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

test('entry lock survives bundled helper exit and serializes same-entry publication', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'first');
    const secondWorkspace = path.join(f.root, 'second');
    await fs.mkdir(path.join(secondWorkspace, 'target'), { recursive: true });
    await fs.writeFile(path.join(secondWorkspace, 'target/a'), 'second');
    const firstSignal = path.join(f.root, 'first-signal');
    const secondSignal = path.join(f.root, 'second-signal');
    const a = worker('save', f.options, firstSignal, 'entry-write-acquired');
    children.push(a.child);
    await signaled(firstSignal);
    const b = worker(
      'save',
      { ...f.options, workspace: secondWorkspace },
      secondSignal,
      'entry-write-acquired',
    );
    children.push(b.child);
    await delay(200);
    assert.equal(
      await fs.stat(secondSignal).then(
        () => true,
        () => false,
      ),
      false,
      'second publisher must wait after the bundled helper has exited',
    );
    await fs.writeFile(`${firstSignal}.release`, 'release');
    assert.equal((await a.completed).code, 0);
    await signaled(secondSignal);
    await fs.writeFile(`${secondSignal}.release`, 'release');
    assert.equal((await b.completed).code, 0);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'second');
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('SIGKILL releases lock, leaves staging invisible, and cleanup reclaims abandoned data', async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    await f.file('target/a', 'committed');
    await save(f.options);
    await f.file('target/a', 'uncommitted');
    const signal = path.join(f.root, 'kill-signal');
    const interrupted = worker('save', f.options, signal, 'save-prepared');
    child = interrupted.child;
    await signaled(signal);
    await terminate(child);
    await interrupted.completed;
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'committed');
    const store = new Store(f.options, f.reporter);
    assert.deepEqual(await fs.readdir(path.join(store.root, 'staging')), []);
  } finally {
    if (child) await terminate(child);
    await f.close();
  }
});

test('reader holds a complete generation while a writer and cleanup wait', async () => {
  const f = await fixture();
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', 'old');
    await save(f.options);
    await f.reset();
    const signal = path.join(f.root, 'reader');
    const reader = worker('restore', f.options, signal, 'restore-prepared');
    children.push(reader.child);
    await signaled(signal);
    const other = path.join(f.root, 'writer');
    await fs.mkdir(path.join(other, 'target'), { recursive: true });
    await fs.writeFile(path.join(other, 'target/a'), 'new');
    const writerSignal = path.join(f.root, 'writer-signal');
    const writer = worker(
      'save',
      { ...f.options, workspace: other, retentionDays: 0.000001 },
      writerSignal,
      'entry-write-acquired',
    );
    children.push(writer.child);
    await delay(200);
    assert.equal(
      await fs.stat(writerSignal).then(
        () => true,
        () => false,
      ),
      false,
    );
    await fs.writeFile(`${signal}.release`, 'release');
    assert.equal((await reader.completed).code, 0);
    assert.equal(await f.read('target/a'), 'old');
    await signaled(writerSignal);
    await fs.writeFile(`${writerSignal}.release`, 'release');
    assert.equal((await writer.completed).code, 0);
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('concurrent distinct-key saves cannot bypass the aggregate admission budget', async () => {
  const f = await fixture({ maxBytes: 6 });
  const children: ChildProcess[] = [];
  try {
    await f.file('target/a', '12345');
    const other = path.join(f.root, 'other');
    await fs.mkdir(path.join(other, 'target'), { recursive: true });
    await fs.writeFile(path.join(other, 'target/a'), '12345');
    const first = path.join(f.root, 'a');
    const second = path.join(f.root, 'b');
    const a = worker('save', { ...f.options, key: 'a' }, first, 'save-prepared');
    children.push(a.child);
    await signaled(first);
    const b = worker('save', { ...f.options, workspace: other, key: 'b' }, second, 'save-prepared');
    children.push(b.child);
    await signaled(second);
    await fs.writeFile(`${first}.release`, 'release');
    await fs.writeFile(`${second}.release`, 'release');
    const results = await Promise.all([a.completed, b.completed]);
    assert.ok(results.every((result) => result.code === 0));
    assert.ok(results.some((result) => result.stderr.includes('max-cache-size')));
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const records = await store.list();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.entry.bytes, 5);
    });
  } finally {
    for (const child of children) await terminate(child);
    await f.close();
  }
});

test('interrupted destination merge is rolled back from its journal on the next restore', async () => {
  const f = await fixture();
  let child: ChildProcess | undefined;
  try {
    await f.file('target/a', 'cache');
    await f.file('target/b', 'cache-b');
    await save(f.options);
    await f.reset();
    await f.file('target/a', 'original');
    await f.file('target/only', 'keep');
    const signal = path.join(f.root, 'merge-kill');
    const killed = worker('restore', f.options, signal, 'restore-leaf');
    child = killed.child;
    await signaled(signal);
    await terminate(child);
    await killed.completed;
    // The next restore recovers the transaction, then applies the complete entry.
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'cache');
    assert.equal(await f.read('target/only'), 'keep');
    assert.ok(
      !(await fs.readdir(f.options.workspace)).some((name) => name.startsWith('.avc-restore-')),
    );
  } finally {
    if (child) await terminate(child);
    await f.close();
  }
});

test('cleanup reclaims SIGKILL generations before first publication and during replacement', async () => {
  for (const existing of [false, true]) {
    const f = await fixture({ autoCleanup: false });
    let child: ChildProcess | undefined;
    try {
      if (existing) {
        await f.file('target/a', 'committed');
        await save(f.options);
      }
      await f.file('target/a', 'uncommitted');
      const signal = path.join(f.root, 'publication-kill');
      const killed = worker('save', f.options, signal, 'publication-staged');
      child = killed.child;
      await signaled(signal);
      await terminate(child);
      await killed.completed;
      const store = new Store(f.options, f.reporter);
      const directory = store.entryDirectory(
        f.options.repository,
        f.options.key,
        'workspace:target',
      );
      const pointerTemporary = path.join(
        directory,
        'current.json.00000000-0000-0000-0000-000000000000.tmp',
      );
      await fs.writeFile(pointerTemporary, 'interrupted metadata write');
      assert.equal(
        (await fs.readdir(path.join(directory, 'generations'))).length,
        existing ? 2 : 1,
      );
      await f.reset();
      assert.equal(await restore(f.options), existing ? 'true' : '');
      assert.ok(
        (await fs.stat(pointerTemporary)).isFile(),
        'disabled cleanup preserves abandoned files',
      );
      if (existing) assert.equal(await f.read('target/a'), 'committed');
      await f.reset();
      assert.equal(await restore({ ...f.options, autoCleanup: true }), existing ? 'true' : '');
      await assert.rejects(fs.stat(pointerTemporary), { code: 'ENOENT' });
      if (existing) {
        assert.equal(await f.read('target/a'), 'committed');
        await store.locked(async () => {
          const records = await store.list();
          assert.deepEqual(await fs.readdir(path.join(directory, 'generations')), [
            records[0]!.entry.generation,
          ]);
        });
      } else await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
      assert.deepEqual(await fs.readdir(path.join(store.root, 'staging')), []);
    } finally {
      if (child) await terminate(child);
      await f.close();
    }
  }
});

test('recovery precedes glob discovery and parent collapsing after the source cache disappears', async () => {
  for (const leaf of [false, true]) {
    const f = await fixture({ paths: [leaf ? 'target/a' : 'target/child'] });
    let child: ChildProcess | undefined;
    try {
      const file = leaf ? 'target/a' : 'target/child/a';
      await f.file(file, 'cached');
      await save(f.options);
      await f.reset();
      await f.file(file, 'original');
      const signal = path.join(f.root, 'recovery-kill');
      const killed = worker(
        'restore',
        f.options,
        signal,
        leaf ? 'restore-backed-up' : 'restore-leaf',
      );
      child = killed.child;
      await signaled(signal);
      await terminate(child);
      await killed.completed;
      if (leaf) await assert.rejects(f.read(file), { code: 'ENOENT' });
      else assert.equal(await f.read(file), 'cached');
      const store = new Store(f.options, f.reporter);
      await store.locked(async () => {
        for (const record of await store.list()) await fs.rm(record.directory, { recursive: true });
      });
      const paths = leaf ? ['target/*'] : ['target', 'target/**'];
      assert.equal(await restore({ ...f.options, paths }), '');
      assert.equal(await f.read(file), 'original');
      assert.ok(
        !(await fs.readdir(path.join(f.options.workspace, 'target'))).some((name) =>
          name.startsWith('.avc-restore-'),
        ),
      );
    } finally {
      if (child) await terminate(child);
      await f.close();
    }
  }
});
