import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { restore, save } from '../src/cache.js';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';
import { worker, signaled, terminate } from './processes.js';

async function workspace(root: string, name: string, target = 'target'): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(path.join(directory, target), { recursive: true });
  await fs.writeFile(path.join(directory, target, 'a'), name);
  return directory;
}
async function absent(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => false,
    (error) => {
      if (error.code === 'ENOENT') return true;
      throw error;
    },
  );
}

test('a held reader does not block another key, path, or repository publishing', async () => {
  for (const dimension of ['key', 'path', 'repository']) {
    const f = await fixture();
    const children: ChildProcess[] = [];
    try {
      await f.file('target/a', 'cached');
      await save(f.options);
      await f.reset();
      const reading = path.join(f.root, 'reading');
      const reader = worker('restore', f.options, reading, 'restore-prepared');
      children.push(reader.child);
      await signaled(reading);
      const target = dimension === 'path' ? 'other-target' : 'target';
      const other = await workspace(f.root, 'other', target);
      const signal = path.join(f.root, 'publishing');
      const writer = worker(
        'save',
        {
          ...f.options,
          workspace: other,
          paths: [target],
          key: dimension === 'key' ? 'other-key' : f.options.key,
          repository: dimension === 'repository' ? '456' : f.options.repository,
        },
        signal,
        'entry-write-acquired',
      );
      children.push(writer.child);
      await signaled(signal);
      await fs.writeFile(`${signal}.release`, 'release');
      assert.equal((await writer.completed).code, 0);
      assert.equal(
        await absent(`${reading}.release`),
        true,
        'unrelated publication completes while the reader stays paused',
      );
      await fs.writeFile(`${reading}.release`, 'release');
      assert.equal((await reader.completed).code, 0);
      assert.equal(await f.read('target/a'), 'cached');
    } finally {
      for (const child of children) await terminate(child);
      await f.close();
    }
  }
});

test('same-entry shared readers overlap and a writer waits until both finish', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'cached');
    await save(f.options);
    await f.reset();
    const second = path.join(f.root, 'second');
    await fs.mkdir(second);
    const firstSignal = path.join(f.root, 'first');
    const secondSignal = path.join(f.root, 'second-signal');
    const a = worker(
      'restore',
      { ...f.options, autoCleanup: false },
      firstSignal,
      'restore-prepared',
    );
    children.push(a.child);
    await signaled(firstSignal);
    const b = worker(
      'restore',
      { ...f.options, workspace: second, autoCleanup: false },
      secondSignal,
      'restore-prepared',
    );
    children.push(b.child);
    await signaled(secondSignal);
    // Expired-entry cleanup must skip active readers instead of waiting for them.
    const cleaner = worker(
      'cleanup',
      { ...f.options, retentionDays: 0.000000001 },
      path.join(f.root, 'cleanup'),
    );
    children.push(cleaner.child);
    assert.equal((await cleaner.completed).code, 0);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => assert.equal((await store.list()).length, 1));
    const other = await workspace(f.root, 'writer');
    const writerSignal = path.join(f.root, 'writer-signal');
    const writer = worker(
      'save',
      { ...f.options, workspace: other },
      writerSignal,
      'entry-write-acquired',
    );
    children.push(writer.child);
    await delay(150);
    assert.equal(await absent(writerSignal), true);
    await fs.writeFile(`${firstSignal}.release`, 'release');
    assert.equal((await a.completed).code, 0);
    await delay(100);
    assert.equal(
      await absent(writerSignal),
      true,
      'the remaining reader still excludes the writer',
    );
    await fs.writeFile(`${secondSignal}.release`, 'release');
    assert.equal((await b.completed).code, 0);
    await signaled(writerSignal);
    await fs.writeFile(`${writerSignal}.release`, 'release');
    assert.equal((await writer.completed).code, 0);
    assert.equal(await fs.readFile(path.join(second, 'target/a'), 'utf8'), 'cached');
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'writer');
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('cleanup preserves an active staging lease while another job publishes', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'committed');
    await save(f.options);
    await f.file('target/a', 'uncommitted');
    const signal = path.join(f.root, 'staging');
    const paused = worker('save', f.options, signal, 'save-prepared');
    children.push(paused.child);
    await signaled(signal);
    const store = new Store(f.options, f.reporter);
    const stages = await fs.readdir(path.join(store.root, 'staging'));
    assert.equal(stages.length, 1);
    const other = await workspace(f.root, 'other');
    const writer = worker(
      'save',
      { ...f.options, workspace: other, key: 'other' },
      path.join(f.root, 'writer'),
    );
    children.push(writer.child);
    assert.equal((await writer.completed).code, 0);
    assert.deepEqual(await fs.readdir(path.join(store.root, 'staging')), stages);
    assert.equal(
      await fs.readFile(path.join(store.root, 'staging', stages[0]!, 'payload/a'), 'utf8'),
      'uncommitted',
    );
    await terminate(paused.child);
    await paused.completed;
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'committed');
    assert.deepEqual(await fs.readdir(path.join(store.root, 'staging')), []);
    assert.deepEqual(await fs.readdir(path.join(store.root, 'locks/operations')), []);
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('detached garbage deletion neither holds metadata nor blocks a replacement entry', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'expired');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const record = (await store.list())[0]!;
      record.entry.lastUsedAt = 0;
      await fs.writeFile(path.join(record.directory, 'current.json'), JSON.stringify(record.entry));
    });
    const signal = path.join(f.root, 'deleting');
    const cleaner = worker('cleanup', f.options, signal, 'garbage-removing');
    children.push(cleaner.child);
    await signaled(signal);
    const garbage = await fs.readdir(path.join(store.root, 'garbage'));
    assert.equal(garbage.length, 1);
    const other = await workspace(f.root, 'replacement');
    const writer = worker('save', { ...f.options, workspace: other }, path.join(f.root, 'writer'));
    children.push(writer.child);
    assert.equal((await writer.completed).code, 0);
    assert.deepEqual(
      await fs.readdir(path.join(store.root, 'garbage')),
      garbage,
      'active garbage cleanup retains its own lease',
    );
    await terminate(cleaner.child);
    await cleaner.completed;
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'replacement');
    assert.deepEqual(await fs.readdir(path.join(store.root, 'garbage')), []);
    assert.deepEqual(await fs.readdir(path.join(store.root, 'locks/operations')), []);
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('a selected entry is re-read after acquiring its lock', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'old');
    await save(f.options);
    await f.reset();
    const signal = path.join(f.root, 'selected');
    const reader = worker('restore', f.options, signal, 'entries-listed');
    children.push(reader.child);
    await signaled(signal);
    const other = await workspace(f.root, 'updated');
    await save({ ...f.options, workspace: other });
    await fs.writeFile(`${signal}.release`, 'release');
    assert.equal((await reader.completed).code, 0);
    assert.equal(await f.read('target/a'), 'updated');
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('v2 starts cold and leaves incompatible v1 caches outside its cleanup and budget', async () => {
  const f = await fixture({ maxBytes: 5 });
  try {
    await f.file('target/a', '12345');
    await save(f.options);
    const current = new Store(f.options, f.reporter).root;
    const legacy = path.join(path.dirname(current), 'v1');
    await fs.rename(current, legacy);
    const before = await fs.readdir(legacy);
    await f.reset();
    assert.equal(await restore(f.options), '');
    await f.file('target/a', 'new');
    await save(f.options);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'new');
    assert.deepEqual(await fs.readdir(legacy), before);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const record = (await store.list())[0]!;
      // Inspect the legacy pointer without assuming its generation UUID.
      const entry = path.join(legacy, path.relative(current, record.directory));
      const old = JSON.parse(await fs.readFile(path.join(entry, 'current.json'), 'utf8'));
      assert.equal(
        await fs.readFile(path.join(entry, 'generations', old.generation, 'payload/a'), 'utf8'),
        '12345',
      );
    });
  } finally {
    await f.close();
  }
});
