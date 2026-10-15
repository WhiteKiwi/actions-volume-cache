import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hash,
  missing,
  noSymlinkAncestors,
  readBounded,
  realLocation,
  removeOwned,
  safeDirectory,
  statOptional,
  writeJson,
} from './fs.js';
import { acquireLock, withLock, type Lease } from './lock.js';
import { destination } from './paths.js';
import { MAX_MANIFEST_BYTES, payloadBytes, validateManifest } from './tree.js';
import {
  InputError,
  type Entry,
  type Manifest,
  type Options,
  type Reporter,
  type StoredEntry,
  type TestHooks,
} from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Directory {
  repository: string;
  keyHash: string;
  pathHash: string;
  directory: string;
}
export interface OwnedOperation {
  id: string;
  directory: string;
  lockFile: string;
  release(): Promise<void>;
}

export class Store {
  readonly root: string;
  corrupt = false;
  private ready?: Promise<void>;
  constructor(
    readonly options: Options,
    readonly report: Reporter,
  ) {
    // Old v1 clients only honor a volume-wide lock. Never mix lock protocols.
    this.root = path.join(options.volume, 'actions-volume-cache', 'v2');
  }

  private async initialize(): Promise<void> {
    this.ready ??= (async () => {
      const volume = await realLocation(this.options.volume);
      if (volume !== this.options.volume)
        throw new InputError('volume-path must use its canonical filesystem path');
      if (!(await fs.stat(volume)).isDirectory())
        throw new InputError('volume-path must be a directory');
      for (const name of [
        '',
        'repos',
        'staging',
        'garbage',
        'locks',
        'locks/entries',
        'locks/workspaces',
        'locks/operations',
      ])
        await safeDirectory(path.join(this.root, name));
    })();
    return this.ready;
  }

  // Metadata only: never recursively copy/delete payloads inside this callback.
  async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    return withLock(path.join(this.root, 'metadata.lock'), operation);
  }

  async workspace<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    // Protect recovery and overlapping action invocations in one workspace.
    // Different job workspaces do not share this guard; builds never hold it.
    return withLock(
      path.join(this.root, 'locks/workspaces', `${hash(this.options.workspace)}.lock`),
      operation,
    );
  }

  entryDirectory(repository: string, key: string, logical: string): string {
    if (!/^\d+$/.test(repository)) throw new InputError('Invalid repository namespace');
    return path.join(this.root, 'repos', repository, hash(key), hash(logical));
  }

  entryLock(repository: string, key: string, logical: string): string {
    return this.entryLockHashes(repository, hash(key), hash(logical));
  }

  private entryLockHashes(repository: string, keyHash: string, pathHash: string): string {
    return path.join(
      this.root,
      'locks/entries',
      `${hash(`${repository}/${keyHash}/${pathHash}`)}.lock`,
    );
  }

  private async directories(): Promise<Directory[]> {
    const result: Directory[] = [];
    const base = path.join(this.root, 'repos');
    for (const repository of await fs.readdir(base)) {
      if (!/^\d+$/.test(repository)) continue;
      const repoPath = path.join(base, repository);
      await noSymlinkAncestors(repoPath, true);
      for (const keyHash of await fs.readdir(repoPath)) {
        if (!HASH.test(keyHash)) continue;
        const keyPath = path.join(repoPath, keyHash);
        await noSymlinkAncestors(keyPath, true);
        for (const pathHash of await fs.readdir(keyPath)) {
          if (!HASH.test(pathHash)) continue;
          const directory = path.join(keyPath, pathHash);
          await noSymlinkAncestors(directory, true);
          result.push({ repository, keyHash, pathHash, directory });
        }
      }
    }
    return result;
  }

  private async read(info: Directory): Promise<StoredEntry | undefined> {
    const { repository, keyHash, pathHash, directory } = info;
    try {
      await noSymlinkAncestors(directory, true);
      const pointer = path.join(directory, 'current.json');
      if (!(await statOptional(pointer))) return;
      const entry = JSON.parse((await readBounded(pointer, 16384)).toString()) as Entry;
      if (
        !entry ||
        entry.schema !== 1 ||
        entry.repository !== repository ||
        typeof entry.key !== 'string' ||
        entry.key.length > 512 ||
        typeof entry.path !== 'string' ||
        entry.path.length > 8192 ||
        /[\x00-\x1f]/.test(entry.path) ||
        hash(entry.key) !== keyHash ||
        hash(entry.path) !== pathHash ||
        !UUID.test(entry.generation) ||
        !HASH.test(entry.manifestDigest) ||
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence < 1 ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        !Number.isFinite(entry.publishedAt) ||
        !Number.isFinite(entry.lastUsedAt)
      )
        throw new Error('Invalid entry metadata');
      destination(entry.path, this.options);
      return { entry, directory };
    } catch (error) {
      if (error instanceof InputError && error.message.startsWith('Unsafe directory')) throw error;
      if (missing(error)) return;
      this.corrupt = true;
      this.report.warning(
        `Ignoring invalid cache metadata in ${repository}/${keyHash.slice(0, 12)}/${pathHash.slice(0, 12)}`,
      );
      return;
    }
  }

  private info(record: StoredEntry): Directory {
    return {
      repository: record.entry.repository,
      keyHash: hash(record.entry.key),
      pathHash: hash(record.entry.path),
      directory: record.directory,
    };
  }

  // Call under metadata.lock so directory traversal and accounting are coherent.
  async list(): Promise<StoredEntry[]> {
    this.corrupt = false;
    const result: StoredEntry[] = [];
    for (const info of await this.directories()) {
      const record = await this.read(info);
      if (record) result.push(record);
    }
    return result;
  }

  async reading<T>(
    record: StoredEntry,
    operation: (current: StoredEntry) => Promise<T>,
    hooks: TestHooks = {},
  ): Promise<T | undefined> {
    await this.initialize();
    return withLock(
      this.entryLock(record.entry.repository, record.entry.key, record.entry.path),
      async () => {
        await hooks.point?.('entry-read-acquired');
        // Selection was a snapshot. Re-read after locking: publication/cleanup may
        // have replaced or removed the selected generation in the meantime.
        const current = await this.read(this.info(record));
        if (!current) return;
        return operation(current);
      },
      'shared',
    );
  }

  generation(record: StoredEntry): string {
    return path.join(record.directory, 'generations', record.entry.generation);
  }

  async manifest(record: StoredEntry): Promise<Manifest> {
    const generation = this.generation(record);
    await noSymlinkAncestors(generation, true);
    const bytes = await readBounded(path.join(generation, 'manifest.json'), MAX_MANIFEST_BYTES);
    if (hash(bytes.toString()) !== record.entry.manifestDigest)
      throw new Error('Cache manifest checksum mismatch');
    const manifest = validateManifest(JSON.parse(bytes.toString()));
    if (payloadBytes(manifest.nodes) !== record.entry.bytes)
      throw new Error('Cache size metadata mismatch');
    return manifest;
  }

  async touched(record: StoredEntry): Promise<void> {
    // Shared readers can finish concurrently. Serialize the timestamp update and
    // re-read it so a delayed reader cannot move lastUsedAt backwards.
    await this.locked(async () => {
      const current = await this.read(this.info(record));
      if (!current || current.entry.generation !== record.entry.generation) return;
      current.entry.lastUsedAt = Math.max(Date.now(), current.entry.lastUsedAt);
      await writeJson(path.join(current.directory, 'current.json'), current.entry);
    });
  }

  // Caller holds metadata.lock. Fresh UUID leases cannot contend with an owner.
  private async newOperation(kind: 'staging' | 'garbage'): Promise<OwnedOperation> {
    const id = randomUUID();
    const directory = path.join(this.root, kind, id);
    const lockFile = path.join(this.root, 'locks/operations', `${id}.lock`);
    const lease = await acquireLock(lockFile, 'exclusive', 0);
    if (!lease) throw new Error('Cannot initialize operation lease');
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      return { id, directory, lockFile, release: () => lease.release() };
    } catch (error) {
      try {
        await fs.rm(lockFile, { force: true });
      } finally {
        await lease.release();
      }
      throw error;
    }
  }

  async staging(): Promise<OwnedOperation> {
    return this.locked(() => this.newOperation('staging'));
  }

  async dispose(operation: OwnedOperation): Promise<void> {
    try {
      // The lease lives outside this directory so recursive removal cannot
      // unlink an active lease inode and let another cleanup acquire a new one.
      await removeOwned(this.root, operation.directory);
    } finally {
      try {
        await this.locked(async () => {
          if (
            !(await statOptional(path.join(this.root, 'staging', operation.id))) &&
            !(await statOptional(path.join(this.root, 'garbage', operation.id)))
          )
            await fs.rm(operation.lockFile, { force: true });
        });
      } finally {
        await operation.release();
      }
    }
  }

  // Caller holds the entry lock and metadata.lock. Detach by rename only; the
  // potentially large deletion runs after releasing both locks.
  private async quarantine(source: string, pending: OwnedOperation[]): Promise<void> {
    let operation = pending[0];
    if (!operation) {
      operation = await this.newOperation('garbage');
      pending.push(operation);
    }
    await fs.rename(source, path.join(operation.directory, randomUUID()));
  }

  private async removeGarbage(pending: OwnedOperation[], hooks: TestHooks): Promise<void> {
    for (const operation of pending) {
      try {
        await hooks.point?.('garbage-removing');
        await this.dispose(operation);
      } catch {
        this.report.warning('Detached cache garbage will be reclaimed on cleanup');
      } finally {
        await operation.release();
      }
    }
  }

  async publish(
    staging: string,
    key: string,
    logical: string,
    manifest: Manifest,
    hooks: TestHooks = {},
  ): Promise<void> {
    await this.initialize();
    const bytes = payloadBytes(manifest.nodes);
    if (!Number.isSafeInteger(bytes))
      throw new Error('Cache payload size exceeds safe accounting range');
    // Manifest creation/fsync and all payload copying happen before publication.
    const manifestText = JSON.stringify(manifest);
    await writeJson(path.join(staging, 'manifest.json'), manifest);
    const pending: OwnedOperation[] = [];
    try {
      await withLock(this.entryLock(this.options.repository, key, logical), async () => {
        await hooks.point?.('entry-write-acquired');
        await this.locked(async () => {
          const records = await this.list();
          if (this.options.maxBytes !== undefined && this.corrupt)
            throw new Error('Cannot safely account a cache with corrupt entry metadata');
          const old = records.find(
            (record) =>
              record.entry.repository === this.options.repository &&
              record.entry.key === key &&
              record.entry.path === logical,
          );
          const total =
            records.reduce((sum, record) => sum + record.entry.bytes, 0) -
            (old?.entry.bytes ?? 0) +
            bytes;
          if (
            !Number.isSafeInteger(total) ||
            (this.options.maxBytes !== undefined && total > this.options.maxBytes)
          )
            throw new Error('Cache save exceeds max-cache-size; no entries evicted');
          const directory = this.entryDirectory(this.options.repository, key, logical);
          await safeDirectory(path.join(directory, 'generations'));
          const generation = randomUUID();
          const target = path.join(directory, 'generations', generation);
          await fs.rename(staging, target);
          const now = Date.now();
          const entry: Entry = {
            schema: 1,
            repository: this.options.repository,
            key,
            path: logical,
            generation,
            sequence: records.reduce((max, record) => Math.max(max, record.entry.sequence), 0) + 1,
            publishedAt: now,
            lastUsedAt: now,
            bytes,
            manifestDigest: hash(manifestText),
          };
          try {
            await hooks.point?.('publication-staged');
            await writeJson(path.join(directory, 'current.json'), entry);
          } catch (error) {
            try {
              await this.quarantine(target, pending);
            } catch {
              this.report.warning('Unpublished generation will be reclaimed on cleanup');
            }
            throw error;
          }
          if (old) {
            try {
              await this.quarantine(this.generation(old), pending);
            } catch {
              this.report.warning(
                'Committed cache updated; superseded generation will be reclaimed on cleanup',
              );
            }
          }
        });
      });
    } finally {
      await this.removeGarbage(pending, hooks);
    }
  }

  private async cleanupOperations(kind: 'staging' | 'garbage', hooks: TestHooks): Promise<void> {
    const base = path.join(this.root, kind);
    const names = await this.locked(() => fs.readdir(base));
    for (const id of names) {
      if (!UUID.test(id)) continue;
      const directory = path.join(base, id);
      const lockFile = path.join(this.root, 'locks/operations', `${id}.lock`);
      const lease = await this.locked(async () => {
        if (!(await statOptional(directory))) return;
        await noSymlinkAncestors(directory, true);
        // Never wait for an operation while holding metadata.lock.
        return acquireLock(lockFile, 'exclusive', 0);
      });
      if (!lease) continue;
      try {
        await hooks.point?.('operation-removing');
        await this.dispose({ id, directory, lockFile, release: () => lease.release() });
      } finally {
        await lease.release();
      }
    }
  }

  async cleanup(hooks: TestHooks = {}): Promise<void> {
    const cutoff = Date.now() - this.options.retentionDays * 86400000;
    const directories = await this.locked(() => this.directories());
    for (const info of directories) {
      const lease = await acquireLock(
        this.entryLockHashes(info.repository, info.keyHash, info.pathHash),
        'exclusive',
        0,
      );
      if (!lease) continue;
      const pending: OwnedOperation[] = [];
      try {
        await hooks.point?.('cleanup-entry-acquired');
        await this.locked(async () => {
          if (!(await statOptional(info.directory))) return;
          const record = await this.read(info);
          if (!record && !(await statOptional(path.join(info.directory, 'current.json')))) {
            await this.quarantine(info.directory, pending);
            return;
          }
          if (record && record.entry.lastUsedAt <= cutoff) {
            await this.quarantine(record.directory, pending);
            this.report.info(`Removed expired cache ${record.entry.key} (${record.entry.path})`);
            return;
          }
          for (const name of await fs.readdir(info.directory)) {
            const temporary = /^current\.json\.(.+)\.tmp$/.exec(name);
            if (temporary && UUID.test(temporary[1]!))
              await this.quarantine(path.join(info.directory, name), pending);
          }
          // Temporary pointer writes are safe to reclaim even when the current
          // pointer is corrupt. Preserve that pointer and all unknown generations.
          if (!record) return;
          const parent = path.join(record.directory, 'generations');
          await noSymlinkAncestors(parent, true);
          if (!(await statOptional(parent))) return;
          for (const generation of await fs.readdir(parent))
            if (UUID.test(generation) && generation !== record.entry.generation)
              await this.quarantine(path.join(parent, generation), pending);
        });
      } finally {
        await lease.release();
        await this.removeGarbage(pending, hooks);
      }
    }
    await this.cleanupOperations('staging', hooks);
    await this.cleanupOperations('garbage', hooks);
    // A crash after promotion/lease creation can leave just an operation lock.
    // All operation-lease opens/removals are coordinated by metadata.lock.
    const names = await this.locked(() => fs.readdir(path.join(this.root, 'locks/operations')));
    for (const name of names) {
      const id = name.endsWith('.lock') ? name.slice(0, -5) : '';
      if (!UUID.test(id)) continue;
      await this.locked(async () => {
        if (
          (await statOptional(path.join(this.root, 'staging', id))) ||
          (await statOptional(path.join(this.root, 'garbage', id)))
        )
          return;
        const file = path.join(this.root, 'locks/operations', name);
        const lease: Lease | undefined = await acquireLock(file, 'exclusive', 0);
        if (!lease) return;
        try {
          await fs.rm(file, { force: true });
        } finally {
          await lease.release();
        }
      });
    }
  }
}
