import path from 'node:path';
import { removeOwned, statOptional } from './fs.js';
import { selectUnits, validateOptions } from './paths.js';
import { recoverRestores, restoreMerged } from './restore.js';
import { Store } from './store.js';
import { hasData, selectedNodes, snapshot } from './tree.js';
import {
  InputError,
  silent,
  type Options,
  type Reporter,
  type StoredEntry,
  type TestHooks,
} from './types.js';

function candidates(records: StoredEntry[], options: Options, logical: string): StoredEntry[] {
  const available = records
    .filter(
      (record) => record.entry.repository === options.repository && record.entry.path === logical,
    )
    .sort((a, b) => b.entry.sequence - a.entry.sequence);
  const result: StoredEntry[] = [];
  const add = (entries: StoredEntry[]): void => {
    for (const entry of entries) if (!result.includes(entry)) result.push(entry);
  };
  add(available.filter((record) => record.entry.key === options.key));
  for (const key of options.restoreKeys) {
    add(available.filter((record) => record.entry.key === key));
    add(available.filter((record) => record.entry.key.startsWith(key)));
  }
  return result;
}

async function clean(store: Store): Promise<void> {
  if (!store.options.autoCleanup) return;
  try {
    await store.cleanup();
  } catch (error) {
    if (error instanceof InputError) throw error;
    store.report.warning('Automatic cache cleanup failed; continuing without additional cleanup');
  }
}

export async function restore(
  options: Options,
  report: Reporter = silent,
  hooks: TestHooks = {},
): Promise<'' | 'true' | 'false'> {
  await validateOptions(options);
  const store = new Store(options, report);
  return store.locked(async () => {
    await hooks.point?.('lock-acquired');
    await clean(store);
    const records = await store.list();
    const ids = records
      .filter((record) => record.entry.repository === options.repository)
      .map((record) => record.entry.path);
    const selection = await selectUnits(options, ids, true);
    let restored = 0;
    let exact = !selection.unmatched;
    for (const unit of selection.units) {
      // Recovery is required even when cleanup or a miss removed the old source.
      await recoverRestores(unit.destination);
      let found = false;
      for (const record of candidates(records, options, unit.id)) {
        try {
          const manifest = await store.manifest(record);
          const nodes = selectedNodes(manifest, unit.destination, options);
          if (!hasData(nodes)) continue;
          await restoreMerged(
            path.join(store.generation(record), 'payload'),
            unit.destination,
            nodes,
            hooks,
          );
          try {
            await store.touched(record);
          } catch {
            report.warning('Cache restored but access timestamp could not be updated');
          }
          restored++;
          found = true;
          if (record.entry.key !== options.key) exact = false;
          report.info(`Restored ${unit.id} using key ${record.entry.key}`);
          break;
        } catch (error) {
          if (error instanceof InputError) throw error;
          report.warning(
            `Cannot restore ${unit.id} from ${record.entry.key}: ${safeMessage(error)}`,
          );
        }
      }
      if (!found) exact = false;
    }
    return restored === 0 ? '' : exact ? 'true' : 'false';
  });
}

export async function save(
  options: Options,
  report: Reporter = silent,
  hooks: TestHooks = {},
): Promise<void> {
  await validateOptions(options);
  const store = new Store(options, report);
  await store.locked(async () => {
    await hooks.point?.('lock-acquired');
    // Run cleanup before staging; it may reclaim abandoned copies from killed writers.
    await clean(store);
    const selection = await selectUnits(options, [], false);
    let count = 0;
    for (const unit of selection.units) {
      if (!(await statOptional(unit.destination))) continue;
      const staging = await store.staging();
      try {
        const manifest = await snapshot(unit.destination, path.join(staging, 'payload'), options);
        if (!hasData(manifest.nodes)) {
          report.warning(`No eligible data to save for ${unit.id}; keeping previous entry`);
          continue;
        }
        await hooks.point?.('save-prepared');
        await store.publish(staging, options.key, unit.id, manifest);
        count++;
        report.info(`Saved ${unit.id} using key ${options.key}`);
        await hooks.point?.('save-published');
      } catch (error) {
        if (error instanceof InputError) throw error;
        report.warning(`Cannot save ${unit.id}: ${safeMessage(error)}`);
      } finally {
        await removeOwned(store.root, staging);
      }
    }
    if (!count) report.warning('No cache entries saved; previous entries were preserved');
  });
}

export function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[\r\n\x00-\x1f]/g, ' ')
    .slice(0, 1000);
}
