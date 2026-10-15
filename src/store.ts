import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hash,
  noSymlinkAncestors,
  readBounded,
  realLocation,
  removeOwned,
  safeDirectory,
  statOptional,
  writeJson,
} from './fs.js';
import { withLock } from './lock.js';
import { destination } from './paths.js';
import { MAX_MANIFEST_BYTES, payloadBytes, validateManifest } from './tree.js';
import {
  InputError,
  type Entry,
  type Manifest,
  type Options,
  type Reporter,
  type StoredEntry,
} from './types.js';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class Store {
  readonly root: string;
  corrupt = false;
  constructor(
    readonly options: Options,
    readonly report: Reporter,
  ) {
    this.root = path.join(options.volume, 'actions-volume-cache', 'v1');
  }

  async locked<T>(operation: () => Promise<T>): Promise<T> {
    const volume = await realLocation(this.options.volume);
    if (volume !== this.options.volume)
      throw new InputError('volume-path must use its canonical filesystem path');
    const stat = await fs.stat(volume);
    if (!stat.isDirectory()) throw new InputError('volume-path must be a directory');
    await safeDirectory(this.root);
    return withLock(path.join(this.root, 'global.lock'), async () => {
      await safeDirectory(path.join(this.root, 'repos'));
      await safeDirectory(path.join(this.root, 'staging'));
      return operation();
    });
  }

  entryDirectory(repository: string, key: string, logical: string): string {
    if (!/^\d+$/.test(repository)) throw new InputError('Invalid repository namespace');
    return path.join(this.root, 'repos', repository, hash(key), hash(logical));
  }

  async list(): Promise<StoredEntry[]> {
    const result: StoredEntry[] = [];
    this.corrupt = false;
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
          try {
            await noSymlinkAncestors(directory, true);
            const pointer = path.join(directory, 'current.json');
            if (!(await statOptional(pointer))) continue;
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
            destination(entry.path, this.options); // Validate logical identity without trusting it as a raw path.
            result.push({ entry, directory });
          } catch (error) {
            if (error instanceof InputError && String(error.message).startsWith('Unsafe directory'))
              throw error;
            this.corrupt = true;
            this.report.warning(
              `Ignoring invalid cache metadata in ${repository}/${keyHash.slice(0, 12)}/${pathHash.slice(0, 12)}`,
            );
          }
        }
      }
    }
    return result;
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
    record.entry.lastUsedAt = Math.max(Date.now(), record.entry.lastUsedAt);
    await writeJson(path.join(record.directory, 'current.json'), record.entry);
  }

  async staging(): Promise<string> {
    const directory = path.join(this.root, 'staging', randomUUID());
    await fs.mkdir(directory, { mode: 0o700 });
    return directory;
  }

  async publish(staging: string, key: string, logical: string, manifest: Manifest): Promise<void> {
    const bytes = payloadBytes(manifest.nodes);
    if (!Number.isSafeInteger(bytes))
      throw new Error('Cache payload size exceeds safe accounting range');
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
    const manifestText = JSON.stringify(manifest);
    await writeJson(path.join(staging, 'manifest.json'), manifest);
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
    // The only commit point. Until this rename, current.json still names the old generation.
    await writeJson(path.join(directory, 'current.json'), entry);
    if (old) {
      try {
        await removeOwned(this.root, this.generation(old));
      } catch {
        this.report.warning(
          'Committed cache updated; superseded generation will be reclaimed on cleanup',
        );
      }
    }
  }

  async cleanup(): Promise<void> {
    const cutoff = Date.now() - this.options.retentionDays * 86400000;
    const records = await this.list();
    for (const record of records) {
      if (record.entry.lastUsedAt <= cutoff) {
        await removeOwned(this.root, record.directory);
        this.report.info(`Removed expired cache ${record.entry.key} (${record.entry.path})`);
      } else {
        const parent = path.join(record.directory, 'generations');
        await noSymlinkAncestors(parent, true);
        if (!(await statOptional(parent))) continue;
        for (const generation of await fs.readdir(parent))
          if (UUID.test(generation) && generation !== record.entry.generation) {
            await removeOwned(this.root, path.join(parent, generation));
          }
      }
    }
    // The volume-wide kernel lock proves no cooperating cache operation is active.
    for (const name of await fs.readdir(path.join(this.root, 'staging')))
      if (UUID.test(name)) {
        await removeOwned(this.root, path.join(this.root, 'staging', name));
      }
  }
}
