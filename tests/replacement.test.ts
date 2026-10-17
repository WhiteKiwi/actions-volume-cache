import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { restore, save } from '../src/cache.js';
import { hash } from '../src/fs.js';
import { recoverRestores } from '../src/restore.js';
import { Store } from '../src/store.js';
import { snapshot } from '../src/tree.js';
import { fixture } from './helpers.js';
import { signaled, terminate, worker } from './processes.js';

test('payload hashes are omitted and same-size content changes are not detected', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'original');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    const record = await store.locked(async () => (await store.list())[0]!);
    const manifest = await store.manifest(record);
    assert.equal(manifest.schema, 2);
    assert.ok(manifest.nodes.every((node) => !('digest' in node)));
    await fs.writeFile(path.join(store.generation(record), 'payload/a'), 'modified');
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'modified');
  } finally {
    await f.close();
  }
});

test('save keeps its source and restored writes remain private to the job', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'cached');
    await save(f.options);
    assert.equal(await f.read('target/a'), 'cached');
    await f.file('target/a', 'unsaved');
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'cached');
    await f.file('target/a', 'private');
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'cached');
  } finally {
    await f.close();
  }
});

test('a miss preserves the complete existing destination', async () => {
  const f = await fixture();
  try {
    await f.file('target/only', 'keep');
    assert.equal(await restore(f.options), '');
    assert.equal(await f.read('target/only'), 'keep');
  } finally {
    await f.close();
  }
});

test('whole-root installation preserves directory modes and mtimes', async () => {
  const f = await fixture();
  try {
    await f.file('target/sub/a', 'cached');
    const time = new Date('2020-02-03T04:05:06Z');
    for (const relative of ['target/sub', 'target']) {
      const directory = path.join(f.options.workspace, relative);
      await fs.chmod(directory, 0o751);
      await fs.utimes(directory, time, time);
    }
    await save(f.options);
    await f.reset();
    await f.file('target/obsolete', 'replaced');
    assert.equal(await restore(f.options), 'true');
    for (const relative of ['target', 'target/sub']) {
      const stat = await fs.stat(path.join(f.options.workspace, relative));
      assert.equal(stat.mode & 0o777, 0o751);
      assert.equal(stat.mtimeMs, time.getTime());
    }
  } finally {
    await f.close();
  }
});

test('replacement failures restore existing roots or remove newly installed roots', async () => {
  for (const existing of [false, true]) {
    for (const point of ['restore-prepared', 'restore-backed-up', 'restore-installed']) {
      if (!existing && point === 'restore-backed-up') continue;
      const f = await fixture();
      try {
        await f.file('target/a', 'cached');
        await save(f.options);
        await f.reset();
        if (existing) await f.file('target/only', 'original');
        const hit = await restore(f.options, f.reporter, {
          async point(name) {
            if (name === point) throw new Error(`injected ${point}`);
          },
        });
        assert.equal(hit, '');
        if (existing) {
          assert.equal(await f.read('target/only'), 'original');
          await assert.rejects(f.read('target/a'), { code: 'ENOENT' });
        } else
          await assert.rejects(fs.lstat(path.join(f.options.workspace, 'target')), {
            code: 'ENOENT',
          });
        assert.deepEqual(
          (await fs.readdir(f.options.workspace)).filter((name) =>
            name.startsWith('.avc-restore-'),
          ),
          [],
        );
      } finally {
        await f.close();
      }
    }
  }
});

test('SIGKILL recovery distinguishes preparation, root replacement, and committed data', async () => {
  for (const existing of [false, true]) {
    for (const point of [
      'restore-prepared',
      'restore-backed-up',
      'restore-installed',
      'restore-committed',
    ]) {
      if (!existing && point === 'restore-backed-up') continue;
      const f = await fixture();
      let child: ReturnType<typeof worker> | undefined;
      try {
        await f.file('target/a', 'cached');
        await save(f.options);
        await f.reset();
        if (existing) await f.file('target/only', 'original');
        const signal = path.join(f.root, 'replacement-kill');
        child = worker('restore', f.options, signal, point);
        await signaled(signal);
        await terminate(child.child);
        await child.completed;
        const store = new Store(f.options, f.reporter);
        await store.locked(async () => {
          for (const record of await store.list())
            await fs.rm(record.directory, { recursive: true });
        });
        assert.equal(await restore(f.options), '');
        if (point === 'restore-committed') {
          assert.equal(await f.read('target/a'), 'cached');
          await assert.rejects(f.read('target/only'), { code: 'ENOENT' });
        } else if (existing) {
          assert.equal(await f.read('target/only'), 'original');
          await assert.rejects(f.read('target/a'), { code: 'ENOENT' });
        } else
          await assert.rejects(fs.lstat(path.join(f.options.workspace, 'target')), {
            code: 'ENOENT',
          });
        await recoverRestores(path.join(f.options.workspace, 'target'));
        assert.deepEqual(
          (await fs.readdir(f.options.workspace)).filter((name) =>
            name.startsWith('.avc-restore-'),
          ),
          [],
        );
      } finally {
        if (child) await terminate(child.child);
        await f.close();
      }
    }
  }
});

test('schema-1 manifests remain readable without verifying their payload digests', async () => {
  const f = await fixture();
  const store = new Store(f.options, f.reporter);
  const staging = await store.staging();
  try {
    await f.file('target/a', 'legacy');
    const payload = path.join(staging.directory, 'payload');
    const manifest = await snapshot(path.join(f.options.workspace, 'target'), payload, f.options);
    manifest.schema = 1;
    for (const node of manifest.nodes)
      if (node.kind === 'file')
        node.digest = createHash('sha256')
          .update(await fs.readFile(path.join(payload, node.relative)))
          .digest('hex');
    await store.publish(staging.directory, f.options.key, 'workspace:target', manifest);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'legacy');
  } finally {
    await store.dispose(staging);
    await f.close();
  }
});

test('legacy interrupted merge journals still roll back before cache lookup', async () => {
  const f = await fixture({ paths: ['target/a'] });
  try {
    const destination = await f.file('target/a', 'partially restored');
    const transaction = path.join(
      path.dirname(destination),
      `.avc-restore-${hash(destination).slice(0, 16)}-${randomUUID()}`,
    );
    await fs.mkdir(path.join(transaction, 'backup'), { recursive: true });
    await fs.writeFile(path.join(transaction, 'backup/0'), 'original');
    await fs.writeFile(
      path.join(transaction, 'journal.json'),
      JSON.stringify({
        schema: 1,
        destination,
        phase: 'applying',
        nodes: [{ relative: '', directory: false, hadOld: true, mode: 0o600, mtime: 0 }],
      }),
    );
    assert.equal(await restore(f.options), '');
    assert.equal(await f.read('target/a'), 'original');
    await assert.rejects(fs.stat(transaction), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
