import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { restore, save } from '../src/cache.js';
import { Store } from '../src/store.js';
import { InputError } from '../src/types.js';
import { fixture } from './helpers.js';

test('cold miss, successful save, exact hit, and same-key update', async () => {
  const f = await fixture();
  try {
    assert.equal(await restore(f.options), '');
    await f.file('target/a', 'first');
    await save(f.options);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'first');
    await f.file('target/a', 'second');
    await save(f.options);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'second');
  } finally {
    await f.close();
  }
});

test('ordered fallback keys, exact fallback priority, and primary save preserves fallback', async () => {
  const f = await fixture();
  try {
    for (const [key, value] of [
      ['rust-', 'exact-fallback'],
      ['rust-new', 'newer-prefix'],
      ['go-new', 'other'],
    ]) {
      await f.file('target/a', value!);
      await save({ ...f.options, key: key! });
    }
    await f.reset();
    const next = { ...f.options, key: 'missing', restoreKeys: ['rust-', 'go-'] };
    assert.equal(await restore(next), 'false');
    assert.equal(await f.read('target/a'), 'exact-fallback');
    await f.file('target/a', 'updated');
    await save(next);
    await f.reset();
    assert.equal(await restore({ ...f.options, key: 'rust-' }), 'true');
    assert.equal(await f.read('target/a'), 'exact-fallback');
  } finally {
    await f.close();
  }
});

test('prefix candidates use last publication, not access recency or creation order', async () => {
  const f = await fixture();
  try {
    for (const [key, value] of [
      ['prefix-a', 'old'],
      ['prefix-b', 'new'],
      ['prefix-a', 'updated'],
    ]) {
      await f.file('target/a', value!);
      await save({ ...f.options, key: key! });
    }
    await f.reset();
    assert.equal(await restore({ ...f.options, key: 'absent', restoreKeys: ['prefix-'] }), 'false');
    assert.equal(await f.read('target/a'), 'updated');
    await f.reset();
    assert.equal(await restore({ ...f.options, key: 'prefix', restoreKeys: [] }), '');
  } finally {
    await f.close();
  }
});

test('independent paths preserve reuse, aggregate output, and repository namespaces', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'cached');
    await save(f.options);
    await f.reset();
    const both = { ...f.options, paths: ['target', '.next/cache'] };
    assert.equal(await restore(both), 'false');
    assert.equal(await f.read('target/a'), 'cached');
    await f.file('.next/cache/b', 'other');
    await save(both);
    await f.reset();
    assert.equal(await restore(both), 'true');
    await f.reset();
    assert.equal(await restore({ ...both, repository: '456' }), '');
  } finally {
    await f.close();
  }
});

test('whole-root restores replace destination-only and excluded data', async () => {
  const f = await fixture({ paths: ['target', '!target/tmp/**'] });
  try {
    await f.file('target/a', 'cache');
    await f.file('target/c', 'new');
    await f.file('target/tmp/secret', 'excluded');
    await save(f.options);
    await f.reset();
    await f.file('target/a', 'destination');
    await f.file('target/b', 'keep');
    await f.file('target/tmp/secret', 'keep-excluded');
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'cache');
    await assert.rejects(f.read('target/b'), { code: 'ENOENT' });
    assert.equal(await f.read('target/c'), 'new');
    await assert.rejects(f.read('target/tmp/secret'), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('fresh workspace globs discover saved paths and collapse overlapping roots', async () => {
  const f = await fixture({ paths: ['packages/**/cache', 'packages/*/cache/**', '!**/ignored'] });
  try {
    await f.file('packages/a/cache/x', 'a');
    await f.file('packages/b/cache/x', 'b');
    await f.file('packages/a/cache/ignored', 'no');
    await save(f.options);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('packages/a/cache/x'), 'a');
    assert.equal(await f.read('packages/b/cache/x'), 'b');
    await assert.rejects(f.read('packages/a/cache/ignored'), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('workspace and home identities survive disposable runner paths', async () => {
  const f = await fixture({ paths: ['target', '~/.cache/compiler'] });
  try {
    await f.file('target/a', 'workspace');
    await fs.mkdir(path.join(f.options.home, '.cache/compiler'), { recursive: true });
    await fs.writeFile(path.join(f.options.home, '.cache/compiler/a'), 'home');
    await save(f.options);
    const workspace = path.join(f.root, 'workspace-next');
    const home = path.join(f.root, 'home-next');
    await fs.mkdir(workspace);
    await fs.mkdir(home);
    assert.equal(await restore({ ...f.options, workspace, home }), 'true');
    assert.equal(await fs.readFile(path.join(workspace, 'target/a'), 'utf8'), 'workspace');
    assert.equal(await fs.readFile(path.join(home, '.cache/compiler/a'), 'utf8'), 'home');
  } finally {
    await f.close();
  }
});

test('preserve executable bits, mtime, symlinks, broken links and cycles without dereference', async () => {
  const f = await fixture();
  try {
    const file = await f.file('target/tool', 'executable');
    const time = new Date('2020-01-02T03:04:05.000Z');
    await fs.chmod(file, 0o751);
    await fs.utimes(file, time, time);
    await f.file('outside', 'not-copied');
    await fs.symlink('../..', path.join(f.options.workspace, 'target/cycle'));
    await fs.symlink('../outside', path.join(f.options.workspace, 'target/external'));
    await fs.symlink('/does-not-exist', path.join(f.options.workspace, 'target/broken'));
    await save(f.options);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    const stat = await fs.stat(path.join(f.options.workspace, 'target/tool'));
    assert.equal(stat.mode & 0o777, 0o751);
    assert.equal(stat.mtimeMs, time.getTime());
    assert.equal(
      await fs.readlink(path.join(f.options.workspace, 'target/external')),
      '../outside',
    );
    assert.equal(
      await fs.readlink(path.join(f.options.workspace, 'target/broken')),
      '/does-not-exist',
    );
    assert.equal(await fs.readlink(path.join(f.options.workspace, 'target/cycle')), '../..');
    await assert.rejects(f.read('outside'), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('unsafe roots, volume overlaps and symlink aliases are rejected', async () => {
  const f = await fixture();
  try {
    for (const bad of ['/', '~', f.options.volume, path.join(f.options.volume, 'child'), f.root]) {
      await assert.rejects(restore({ ...f.options, paths: [bad] }), InputError);
    }
    await fs.symlink(f.options.volume, path.join(f.options.workspace, 'alias'));
    await assert.rejects(save({ ...f.options, paths: ['alias'] }), InputError);
  } finally {
    await f.close();
  }
});

test('whole-root replacement removes nested destination links without following them', async () => {
  const f = await fixture();
  try {
    await f.file('target/sub/a', 'cache');
    await save(f.options);
    await f.reset();
    await f.file('outside/a', 'keep');
    await fs.mkdir(path.join(f.options.workspace, 'target'));
    await fs.symlink('../outside', path.join(f.options.workspace, 'target/sub'));
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/sub/a'), 'cache');
    assert.equal(await f.read('outside/a'), 'keep');
  } finally {
    await f.close();
  }
});

test('payload size mismatch is not applied and remaining candidates are attempted', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'fallback');
    await save({ ...f.options, key: 'fallback' });
    await f.file('target/a', 'primary');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const record = (await store.list()).find((record) => record.entry.key === f.options.key)!;
      await fs.writeFile(path.join(store.generation(record), 'payload/a'), 'truncated payload');
    });
    await f.reset();
    assert.equal(await restore({ ...f.options, restoreKeys: ['fallback'] }, f.reporter), 'false');
    assert.equal(await f.read('target/a'), 'fallback');
    assert.ok(f.warnings.some((message) => message.includes('size mismatch')));
  } finally {
    await f.close();
  }
});

test('restore application failure rolls back old files and removes newly installed files', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'cache');
    await f.file('target/new', 'new');
    await save(f.options);
    await f.reset();
    await f.file('target/a', 'original');
    await f.file('target/only', 'preserve');
    const result = await restore(f.options, f.reporter, {
      async point(name) {
        if (name === 'restore-installed') throw new Error('injected application error');
      },
    });
    assert.equal(result, '');
    assert.equal(await f.read('target/a'), 'original');
    assert.equal(await f.read('target/only'), 'preserve');
    await assert.rejects(f.read('target/new'), { code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

test('size admission rejects writes without eviction and accounts replacements', async () => {
  const f = await fixture({ maxBytes: 5 });
  try {
    await f.file('target/a', '12345');
    await save(f.options);
    await f.file('target/a', '123456');
    await save(f.options, f.reporter);
    assert.ok(f.warnings.some((message) => message.includes('max-cache-size')));
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), '12345');
    await f.file('target/a', 'new');
    await save(f.options);
    await f.reset();
    await restore(f.options);
    assert.equal(await f.read('target/a'), 'new');
  } finally {
    await f.close();
  }
});

test('retention uses successful access and never cleans shared or unrelated data', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'old');
    await save(f.options);
    const store = new Store(f.options, f.reporter);
    await fs.mkdir(path.join(f.options.volume, 'shared'), { recursive: true });
    await fs.writeFile(path.join(f.options.volume, 'shared/keep'), 'keep');
    await fs.writeFile(path.join(f.options.volume, 'unrelated'), 'keep');
    await store.locked(async () => {
      const record = (await store.list())[0]!;
      record.entry.lastUsedAt = Date.now() - 8 * 86400000;
      await fs.writeFile(path.join(record.directory, 'current.json'), JSON.stringify(record.entry));
    });
    await f.reset();
    assert.equal(await restore({ ...f.options, autoCleanup: false }), 'true');
    // A successful restore refreshed age; a later cleanup must keep the entry.
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    await store.locked(async () => {
      const record = (await store.list())[0]!;
      record.entry.lastUsedAt = Date.now() - 8 * 86400000;
      await fs.writeFile(path.join(record.directory, 'current.json'), JSON.stringify(record.entry));
    });
    await f.reset();
    assert.equal(await restore(f.options), '');
    assert.equal(await fs.readFile(path.join(f.options.volume, 'shared/keep'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(f.options.volume, 'unrelated'), 'utf8'), 'keep');
  } finally {
    await f.close();
  }
});

test('empty save does not replace the previous entry', async () => {
  const f = await fixture();
  try {
    await f.file('target/a', 'old');
    await save(f.options);
    await f.reset();
    await fs.mkdir(path.join(f.options.workspace, 'target'));
    await save(f.options, f.reporter);
    assert.ok(f.warnings.length);
    await f.reset();
    assert.equal(await restore(f.options), 'true');
    assert.equal(await f.read('target/a'), 'old');
  } finally {
    await f.close();
  }
});
