import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { InputError } from './types.js';

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};
export const overlaps = (a: string, b: string): boolean => within(a, b) || within(b, a);
export const missing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export async function statOptional(file: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (missing(error)) return;
    throw error;
  }
}

// Resolve existing parent aliases even when the requested leaf does not exist.
export async function realLocation(file: string): Promise<string> {
  try {
    return await fs.realpath(file);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = path.dirname(file);
    if (parent === file) return file;
    return path.join(await realLocation(parent), path.basename(file));
  }
}

export async function noSymlinkAncestors(file: string, includeLeaf = false): Promise<void> {
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts.slice(0, includeLeaf ? undefined : -1)) {
    current = path.join(current, part);
    const stat = await statOptional(current);
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new InputError(`Unsafe directory ancestor: ${current}`);
  }
}

export async function safeDirectory(directory: string): Promise<void> {
  await noSymlinkAncestors(directory, true);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await noSymlinkAncestors(directory, true);
}

export async function readBounded(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`Invalid or oversized metadata: ${file}`);
    // Do not use readFile after stat: a changing file must not bypass the bound.
    const buffer = Buffer.alloc(stat.size + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > stat.size || total > limit)
      throw new Error(`Metadata changed during read: ${file}`);
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await noSymlinkAncestors(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let committed = false;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    committed = true;
  } finally {
    if (!committed) await fs.rm(temporary, { force: true });
  }
}

// Only call for an action-owned subtree, never an unvalidated workflow path.
export async function removeOwned(root: string, file: string): Promise<void> {
  if (file === root || !within(root, file))
    throw new InputError('Deletion escaped its owned directory');
  await noSymlinkAncestors(file);
  const stat = await statOptional(file);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await fs.unlink(file);
    return;
  }
  await fs.chmod(file, (stat.mode & 0o777) | 0o700);
  for (const child of await fs.readdir(file)) await removeOwned(root, path.join(file, child));
  await fs.rmdir(file);
}

export function safeRelative(relative: string): boolean {
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      !/[\x00-\x1f]/.test(relative) &&
      relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..'))
  );
}
