import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { restore, save } from '../src/cache.js';
import { Store } from '../src/store.js';
import { fixture } from './helpers.js';

test('malformed or traversal manifest is ignored without writing arbitrary paths', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'good');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const record = (await store.list())[0]!;
      await fs.writeFile(
        path.join(store.generation(record), 'manifest.json'),
        JSON.stringify({ schema: 1, nodes: [{ relative: '../../outside', kind: 'file' }] }),
      );
    });
    await f.reset();
    assert.equal(await restore(f.options, f.reporter), '');
    await assert.rejects(fs.stat(path.join(f.root, 'outside')), { code: 'ENOENT' });
    assert.ok(f.warnings.some((message) => message.includes('manifest checksum')));
  } finally {
    await f.close();
  }
});

test('file/directory collisions do not delete the existing destination tree', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'cache-file');
    await save(f.options);
    await f.reset();
    await f.file('target/a/keep', 'keep');
    assert.equal(await restore(f.options, f.reporter), '');
    assert.equal(await f.read('target/a/keep'), 'keep');
  } finally {
    await f.close();
  }
});

test('automatic cleanup disabled retains expired entries and abandoned staging', async () => {
  const f = await fixture({ autoCleanup: false });
  try {
    await f.file('target/a', 'cache');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    let staging = '';
    await store.locked(async () => {
      staging = await store.staging();
    });
    await f.reset();
    assert.equal(await restore({ ...f.options, retentionDays: 0.000000001 }), 'true');
    assert.ok((await fs.stat(staging)).isDirectory());
  } finally {
    await f.close();
  }
});

test('failed staging preserves the prior committed entry', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'previous');
    await save(f.options);
    await f.file('target/a', 'new');
    await save(f.options, f.reporter, {
      async point(name) {
        if (name === 'save-prepared')
          throw Object.assign(new Error('simulated no space'), { code: 'ENOSPC' });
      },
    });
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'previous');
    assert.ok(f.warnings.some((message) => message.includes('no space')));
  } finally {
    await f.close();
  }
});

test('cross-repository entries share the capacity budget but never the lookup namespace', async () => {
  const f = await fixture({ maxBytes: 5 });
  try {
    await f.file('target/a', '12345');
    await save(f.options);
    await save({ ...f.options, repository: '999' }, f.reporter);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      assert.equal((await store.list()).length, 1);
    });
    await f.reset();
    assert.equal(await restore({ ...f.options, repository: '999' }), '');
  } finally {
    await f.close();
  }
});

test('an interrupted merge recovers even after its source cache is deleted', async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await f.file('target/a', 'cache');
    await save(f.options);
    await f.reset();
    await f.file('target/a', 'original');
    const signal = path.join(f.root, 'interrupt');
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'tests/worker.ts',
        'restore',
        JSON.stringify(f.options),
        signal,
        'restore-leaf',
      ],
      { stdio: 'ignore' },
    );
    const completed = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    let reached = false;
    for (let i = 0; i < 300; i++) {
      if (
        await fs.stat(signal).then(
          () => true,
          () => false,
        )
      ) {
        reached = true;
        break;
      }
      await delay(20);
    }
    assert.ok(reached);
    child.kill('SIGKILL');
    await completed;
    assert.equal(await f.read('target/a'), 'cache', 'kill after an actual file replacement');
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      for (const record of await store.list()) await fs.rm(record.directory, { recursive: true });
    });
    assert.equal(await restore(f.options), '');
    assert.equal(await f.read('target/a'), 'original');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await f.close();
  }
});
