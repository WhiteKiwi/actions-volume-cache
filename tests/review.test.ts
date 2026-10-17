import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { restore, save } from '../src/cache.js';
import { Store } from '../src/store.js';
import { InputError } from '../src/types.js';
import { fixture } from './helpers.js';

test('failed pointer publication reclaims the moved generation with cleanup disabled', async () => {
  const f = await fixture({ autoCleanup: false });
  try {
    const store = new Store(f.options, f.reporter);
    for (const existing of [false, true]) {
      if (existing) {
        await f.file('target/a', 'committed');
        await save(f.options);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.file('target/a', 'uncommitted');
        await save(f.options, f.reporter, {
          async point(name) {
            if (name === 'publication-staged')
              throw Object.assign(new Error('injected pointer ENOSPC'), { code: 'ENOSPC' });
          },
        });
      }
      await store.locked(async () => {
        const directory = store.entryDirectory(
          f.options.repository,
          f.options.key,
          'workspace:target',
        );
        const records = await store.list();
        assert.equal(records.length, existing ? 1 : 0);
        assert.deepEqual(
          await fs.readdir(path.join(directory, 'generations')),
          existing ? [records[0]!.entry.generation] : [],
        );
        assert.deepEqual(await fs.readdir(path.join(store.root, 'staging')), []);
      });
      await f.reset();
      assert.equal(await restore(f.options), existing ? 'true' : '');
      if (existing) assert.equal(await f.read('target/a'), 'committed');
    }
    assert.equal(f.warnings.filter((message) => message.includes('pointer ENOSPC')).length, 6);
  } finally {
    await f.close();
  }
});

test('a real pointer rename failure removes its unpublished generation', async () => {
  const f = await fixture({ autoCleanup: false });
  try {
    await f.file('target/a', 'uncommitted');
    const store = new Store(f.options, f.reporter);
    const directory = store.entryDirectory(f.options.repository, f.options.key, 'workspace:target');
    await save(f.options, f.reporter, {
      async point(name) {
        if (name === 'save-prepared')
          await fs.mkdir(path.join(directory, 'current.json'), { recursive: true });
      },
    });
    assert.deepEqual(await fs.readdir(path.join(directory, 'generations')), []);
    assert.ok(f.warnings.some((message) => message.includes('EISDIR')));
  } finally {
    await f.close();
  }
});

test('runner workspace/home aliases preserve identities and reject links below the roots', async () => {
  const f = await fixture({ paths: ['target', '~/.cache/compiler'] });
  try {
    const alias = path.join(f.root, 'runner-alias');
    await fs.symlink(f.root, alias);
    const options = {
      ...f.options,
      workspace: path.join(alias, 'workspace'),
      home: path.join(alias, 'home'),
      paths: [path.join(alias, 'workspace/target'), '~/.cache/compiler'],
    };
    await f.file('target/a', 'workspace');
    await fs.mkdir(path.join(f.options.home, '.cache/compiler'), { recursive: true });
    await fs.writeFile(path.join(f.options.home, '.cache/compiler/a'), 'home');
    await save(options, f.reporter);
    assert.deepEqual(f.warnings, []);
    await f.reset();
    await fs.rm(path.join(f.options.home, '.cache'), { recursive: true });
    assert.equal(await restore(f.options), 'true', 'alias and real roots use the same identities');
    assert.equal(await f.read('target/a'), 'workspace');
    await f.reset();
    assert.equal(await restore(options), 'true');
    assert.equal(await fs.readFile(path.join(options.home, '.cache/compiler/a'), 'utf8'), 'home');
    await f.reset();
    await f.file('outside/a', 'untouched');
    await fs.symlink('outside', path.join(f.options.workspace, 'inner-alias'));
    await assert.rejects(
      save({ ...options, paths: ['inner-alias/a'] }),
      InputError,
      'only runner roots may be resolved, not inner directory links',
    );
    assert.equal(await f.read('outside/a'), 'untouched');
  } finally {
    await f.close();
  }
});

test('a missing literal parent does not shadow an available cached descendant', async () => {
  const f = await fixture({ paths: ['target/child'] });
  try {
    await f.file('target/child/a', 'child');
    await save(f.options);
    await f.reset();
    assert.equal(await restore({ ...f.options, paths: ['target', 'target/*'] }), 'false');
    assert.equal(await f.read('target/child/a'), 'child');
  } finally {
    await f.close();
  }
});

test('a corrupt cached parent does not shadow a usable cached descendant', async () => {
  const f = await fixture({ paths: ['target/child'] });
  try {
    await f.file('target/child/a', 'child');
    await save(f.options);
    await save({ ...f.options, paths: ['target'] });
    const store = new Store(f.options, f.reporter);
    await store.locked(async () => {
      const parent = (await store.list()).find(
        (record) => record.entry.path === 'workspace:target',
      )!;
      await fs.writeFile(
        path.join(store.generation(parent), 'payload/child/a'),
        'truncated payload',
      );
    });
    await f.reset();
    assert.equal(await restore({ ...f.options, paths: ['target/**'] }, f.reporter), 'false');
    assert.equal(await f.read('target/child/a'), 'child');
  } finally {
    await f.close();
  }
});

test('journal discovery preserves unknown directories that resemble transaction names', async () => {
  const f = await fixture();
  try {
    const relative =
      'target/.avc-restore-aaaaaaaaaaaaaaaa-00000000-0000-0000-0000-000000000000/keep';
    await f.file(relative, 'application data');
    assert.equal(await restore(f.options), '');
    assert.equal(await f.read(relative), 'application data');
  } finally {
    await f.close();
  }
});
