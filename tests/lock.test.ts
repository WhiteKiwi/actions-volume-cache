import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, helperPath } from '../src/lock.js';
import { fixture } from './helpers.js';
import { terminate } from './processes.js';

test('bundled native locks retain shared readers after helper exit and exclude writers', async () => {
  const f = await fixture();
  const leases: { release(): Promise<void> }[] = [];
  try {
    const file = path.join(f.root, 'entry.lock');
    const a = await acquireLock(file, 'shared', 0);
    assert.ok(a);
    leases.push(a);
    const b = await acquireLock(file, 'shared', 0);
    assert.ok(b);
    leases.push(b);
    assert.equal(await acquireLock(file, 'exclusive', 0), undefined);
    const other = await acquireLock(path.join(f.root, 'other.lock'), 'exclusive', 0);
    assert.ok(other);
    leases.push(other);
    await a.release();
    assert.equal(await acquireLock(file, 'exclusive', 0), undefined);
    await b.release();
    const writer = await acquireLock(file, 'exclusive', 0);
    assert.ok(writer);
    leases.push(writer);
  } finally {
    for (const lease of leases) await lease.release();
    await f.close();
  }
});

test('lock timeout returns without discarding the current owner lock', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'entry.lock');
  const owner = await acquireLock(file);
  assert.ok(owner);
  try {
    const start = performance.now();
    assert.equal(await acquireLock(file, 'shared', 60), undefined);
    assert.ok(performance.now() - start >= 40);
    assert.equal(await acquireLock(file, 'exclusive', 0), undefined);
  } finally {
    await owner.release();
    await f.close();
  }
});

test('all shipped helpers match their checksums and contain no dynamic interpreter', async () => {
  const manifest = JSON.parse(await fs.readFile('dist/bin/manifest.json', 'utf8'));
  assert.equal(manifest.go, 'go1.27.2');
  for (const [name, expected] of Object.entries(manifest.files)) {
    const file = path.join('dist/bin', name);
    const bytes = await fs.readFile(file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    assert.equal(bytes.subarray(0, 4).toString(), '\x7fELF');
    assert.equal(bytes[4], 2, 'ELF64');
    assert.equal(bytes[5], 1, 'little-endian');
    assert.equal(bytes.readUInt16LE(18), name.endsWith('x64') ? 62 : 183);
    const offset = Number(bytes.readBigUInt64LE(32));
    const size = bytes.readUInt16LE(54);
    const count = bytes.readUInt16LE(56);
    for (let i = 0; i < count; i++)
      assert.notEqual(bytes.readUInt32LE(offset + i * size), 3, 'no PT_INTERP dynamic loader');
    assert.ok((await fs.stat(file)).mode & 0o100);
  }
  assert.match(await fs.readFile('dist/bin/LICENSE-Go.txt', 'utf8'), /Go Authors/);
});

test('helper rejects an invalid descriptor and lock symlinks never redirect', async () => {
  // Runtime startup may open FD 3 itself; use an explicitly invalid high FD.
  const invalid = spawnSync(
    helperPath(),
    ['--mode', 'exclusive', '--fd', '2147483647', '--parent-pid', String(process.pid)],
    { encoding: 'utf8' },
  );
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /regular file/);
  const pipe = spawnSync(
    helperPath(),
    ['--mode', 'exclusive', '--fd', '3', '--parent-pid', String(process.pid)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
  );
  assert.equal(pipe.status, 2);
  assert.match(pipe.stderr, /regular file/);
  const f = await fixture();
  try {
    const target = await f.file('keep', 'untouched');
    const link = path.join(f.root, 'entry.lock');
    await fs.symlink(target, link);
    await assert.rejects(acquireLock(link), { code: 'ELOOP' });
    assert.equal(await f.read('keep'), 'untouched');
  } finally {
    await f.close();
  }
});

test('a waiting helper exits when its Node parent is killed', async () => {
  const f = await fixture();
  const file = path.join(f.root, 'entry.lock');
  const owner = await acquireLock(file);
  assert.ok(owner);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/lease-worker.ts', file, path.join(f.root, 'waiting')],
    { stdio: 'ignore' },
  );
  let helper = '';
  try {
    for (let attempt = 0; attempt < 150 && !helper; attempt++) {
      const children = await fs
        .readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')
        .catch(() => '');
      for (const pid of children.trim().split(/\s+/).filter(Boolean)) {
        const executable = await fs.readlink(`/proc/${pid}/exe`).catch(() => '');
        if (path.basename(executable).startsWith('lock-linux-')) helper = pid;
      }
      if (!helper) await delay(20);
    }
    assert.ok(helper, 'the child must actually be waiting inside the native helper');
    await terminate(child);
    let closed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      closed = await fs.stat(`/proc/${helper}/fd/3`).then(
        () => false,
        () => true,
      );
      if (closed) break;
      await delay(20);
    }
    assert.equal(closed, true, 'orphaned waiter closes its inherited descriptor');
  } finally {
    await terminate(child);
    await owner.release();
    await f.close();
  }
});
