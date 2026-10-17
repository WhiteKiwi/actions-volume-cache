import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hash,
  noSymlinkAncestors,
  readBounded,
  removeOwned,
  safeDirectory,
  safeRelative,
  statOptional,
  within,
  writeJson,
} from './fs.js';
import { materialize } from './tree.js';
import { collapse, patterns, searchRoot, validateTarget } from './paths.js';
import { InputError, type Options, type TestHooks, type TreeNode } from './types.js';

interface PlanNode {
  relative: string;
  directory: boolean;
  hadOld: boolean;
  mode: number;
  mtime: number;
}
interface MergeJournal {
  schema: 1;
  destination: string;
  phase: 'preparing' | 'applying' | 'committed';
  nodes: PlanNode[];
}
interface ReplacementJournal {
  schema: 2;
  destination: string;
  phase: 'preparing' | 'applying' | 'committed';
  hadOld: boolean;
}
type Journal = MergeJournal | ReplacementJournal;

function prefix(destination: string): string {
  return `.avc-restore-${hash(destination).slice(0, 16)}-`;
}

async function unlinkLeaf(file: string): Promise<void> {
  await noSymlinkAncestors(file);
  const stat = await statOptional(file);
  if (!stat) return;
  if (stat.isDirectory())
    throw new InputError(`Refusing to remove directory during rollback: ${file}`);
  await fs.unlink(file);
}

async function rollback(transaction: string, journal: Journal): Promise<void> {
  if (journal.schema === 2) {
    const parent = path.dirname(journal.destination);
    const backup = path.join(transaction, 'backup');
    await noSymlinkAncestors(journal.destination);
    if (await statOptional(backup)) {
      await removeOwned(parent, journal.destination);
      await fs.rename(backup, journal.destination);
    } else if (!journal.hadOld && !(await statOptional(path.join(transaction, 'payload')))) {
      await removeOwned(parent, journal.destination);
    }
    return;
  }
  // Retain recovery for interrupted restores made by older action versions.
  for (const node of journal.nodes)
    if (node.directory) {
      const target = path.join(journal.destination, node.relative);
      await noSymlinkAncestors(target);
      const stat = await statOptional(target);
      if (stat?.isDirectory() && !stat.isSymbolicLink())
        await fs.chmod(target, (stat.mode & 0o777) | 0o700);
    }
  const reversed = journal.nodes.map((node, index) => ({ node, index })).reverse();
  for (const { node, index } of reversed) {
    const target = path.join(journal.destination, node.relative);
    await noSymlinkAncestors(target);
    if (node.directory) {
      const stat = await statOptional(target);
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new InputError('Restore rollback directory changed type');
      if (!node.hadOld) await fs.rmdir(target);
      else {
        await fs.chmod(target, node.mode);
        await fs.utimes(target, new Date(node.mtime), new Date(node.mtime));
      }
    } else {
      const backup = path.join(transaction, 'backup', String(index));
      if (await statOptional(backup)) {
        await unlinkLeaf(target);
        await fs.rename(backup, target);
      } else if (
        !node.hadOld &&
        !(await statOptional(path.join(transaction, 'payload', node.relative)))
      )
        await unlinkLeaf(target);
    }
  }
}

function validateJournal(value: unknown, destination: string): Journal {
  const journal = value as Journal;
  if (
    journal?.schema === 2 &&
    journal.destination === destination &&
    ['preparing', 'applying', 'committed'].includes(journal.phase) &&
    typeof journal.hadOld === 'boolean'
  )
    return journal;
  if (
    !journal ||
    journal.schema !== 1 ||
    journal.destination !== destination ||
    !['preparing', 'applying', 'committed'].includes(journal.phase) ||
    !Array.isArray(journal.nodes) ||
    journal.nodes.length > 100_000 ||
    (journal.phase === 'preparing' && journal.nodes.length !== 0)
  )
    throw new InputError('Invalid restore recovery journal');
  const seen = new Set<string>();
  for (const node of journal.nodes) {
    if (
      !node ||
      typeof node.relative !== 'string' ||
      !safeRelative(node.relative) ||
      seen.has(node.relative) ||
      typeof node.directory !== 'boolean' ||
      typeof node.hadOld !== 'boolean' ||
      !Number.isInteger(node.mode) ||
      node.mode < 0 ||
      node.mode > 0o777 ||
      !Number.isFinite(node.mtime)
    )
      throw new InputError('Invalid restore recovery path');
    if (
      node.relative &&
      !seen.has(path.posix.dirname(node.relative) === '.' ? '' : path.posix.dirname(node.relative))
    )
      throw new InputError('Invalid restore recovery ordering');
    seen.add(node.relative);
  }
  return journal;
}

export async function recoverRestores(destination: string): Promise<void> {
  const parent = path.dirname(destination);
  await noSymlinkAncestors(parent, true);
  if (!(await statOptional(parent))) return;
  const start = prefix(destination);
  for (const name of await fs.readdir(parent)) {
    if (!name.startsWith(start) || !/^[a-f0-9-]{36}$/.test(name.slice(start.length))) continue;
    const transaction = path.join(parent, name);
    await noSymlinkAncestors(transaction, true);
    const file = path.join(transaction, 'journal.json');
    if (await statOptional(file)) {
      const journal = validateJournal(
        JSON.parse((await readBounded(file, 32 * 1024 * 1024)).toString()),
        destination,
      );
      if (journal.phase === 'applying') {
        try {
          await rollback(transaction, journal);
        } catch {
          throw new InputError(
            `Cannot recover interrupted restore at ${destination}; do not continue this workspace`,
          );
        }
      }
    }
    await removeOwned(parent, transaction);
  }
}

// Recovery cannot depend on live glob matches or a surviving cache index: a
// killed restore may have moved the destination into its backup already.
export async function recoverSelectedRestores(options: Options): Promise<void> {
  const roots = collapse(
    patterns(options).positive.map((pattern) => {
      const destination = searchRoot(pattern);
      return { id: destination, destination };
    }),
  ).map((unit) => unit.destination);
  const visited = new Set<string>();
  const transactionName = /^\.avc-restore-[a-f0-9]{16}-[a-f0-9-]{36}$/;
  async function scan(directory: string, recursive: boolean): Promise<void> {
    await noSymlinkAncestors(directory);
    const stat = await statOptional(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      const name = child.name;
      const file = path.join(directory, name);
      if (transactionName.test(name)) {
        if (!child.isDirectory()) continue;
        if (
          !recursive &&
          !roots.some((root) => path.dirname(root) === directory && name.startsWith(prefix(root)))
        )
          continue;
        if (visited.has(file)) continue;
        visited.add(file);
        await noSymlinkAncestors(file, true);
        const journalFile = path.join(file, 'journal.json');
        if (!(await statOptional(journalFile))) {
          // A name alone does not identify an unknown directory as ours.
          // Known-root preparation is handled by recoverRestores(root).
          continue;
        }
        const value = JSON.parse((await readBounded(journalFile, 32 * 1024 * 1024)).toString());
        if (
          typeof value?.destination !== 'string' ||
          path.dirname(value.destination) !== directory ||
          !name.startsWith(prefix(value.destination))
        )
          throw new InputError('Invalid restore recovery location');
        if (!roots.some((root) => within(root, value.destination))) continue;
        await validateTarget(value.destination, options);
        await recoverRestores(value.destination);
      } else if (recursive && child.isDirectory()) await scan(file, true);
    }
  }
  try {
    // Scan ancestors shallowly for root journals, and each selected search tree
    // recursively without following directory symlinks or transaction payloads.
    for (const root of roots) {
      await recoverRestores(root);
      await scan(path.dirname(root), false);
      await scan(root, true);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(
      'Cannot inspect or recover interrupted restores; do not continue this workspace',
    );
  }
}

export async function restoreReplaced(
  payload: string,
  destination: string,
  nodes: TreeNode[],
  hooks: TestHooks = {},
): Promise<void> {
  await recoverRestores(destination);
  await noSymlinkAncestors(destination);
  const parent = path.dirname(destination);
  await safeDirectory(parent);
  const transaction = path.join(parent, `${prefix(destination)}${randomUUID()}`);
  await fs.mkdir(transaction, { mode: 0o700 });
  let journal: ReplacementJournal | undefined;
  let preserve = false;
  try {
    journal = {
      schema: 2,
      destination,
      phase: 'preparing',
      hadOld: false,
    };
    await writeJson(path.join(transaction, 'journal.json'), journal);
    await materialize(payload, path.join(transaction, 'payload'), nodes);
    await hooks.point?.('restore-prepared');
    await noSymlinkAncestors(destination);
    const existing = await statOptional(destination);
    if (existing && !existing.isDirectory() && !existing.isFile() && !existing.isSymbolicLink())
      throw new InputError('Unsupported restore destination type');
    journal = { ...journal, phase: 'applying', hadOld: !!existing };
    await writeJson(path.join(transaction, 'journal.json'), journal);
    if (existing) {
      await fs.rename(destination, path.join(transaction, 'backup'));
      await hooks.point?.('restore-backed-up');
    }
    await fs.rename(path.join(transaction, 'payload'), destination);
    await hooks.point?.('restore-installed');
    await writeJson(path.join(transaction, 'journal.json'), { ...journal, phase: 'committed' });
    journal.phase = 'committed';
    await hooks.point?.('restore-committed');
  } catch (error) {
    if (journal?.phase === 'applying') {
      try {
        await rollback(transaction, journal);
      } catch {
        preserve = true;
        throw new InputError(
          `Restore rollback failed at ${destination}; recovery journal preserved, do not continue this workspace`,
        );
      }
    }
    throw error;
  } finally {
    if (!preserve) await removeOwned(parent, transaction);
  }
}
