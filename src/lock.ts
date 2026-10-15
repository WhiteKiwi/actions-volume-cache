import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { noSymlinkAncestors } from './fs.js';

export type LockMode = 'shared' | 'exclusive';
export interface Lease {
  release(): Promise<void>;
}

export function helperPath(): string {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Bundled locking supports Linux x64 and arm64 only');
  // This resolves to dist/bin from either src/lock.ts or bundled dist/*.js.
  return fileURLToPath(new URL(`../dist/bin/lock-linux-${process.arch}`, import.meta.url));
}

export async function acquireLock(
  file: string,
  mode: LockMode = 'exclusive',
  timeoutMs = 300000,
): Promise<Lease | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000)
    throw new Error('Invalid lock timeout');
  await noSymlinkAncestors(file);
  const handle = await fs.open(
    file,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let acquired = false;
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid lock inode');
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        helperPath(),
        [
          '--mode',
          mode,
          '--timeout-ms',
          String(timeoutMs),
          '--fd',
          '3',
          '--parent-pid',
          String(process.pid),
        ],
        {
          stdio: ['ignore', 'ignore', 'pipe', handle.fd],
        },
      );
      let error = '';
      child.stderr!.on('data', (data) => {
        error = (error + String(data)).slice(-1024);
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0 || code === 75) resolve(code);
        else reject(new Error(`Cannot acquire cache lock (${code}): ${error.trim()}`));
      });
    });
    if (code === 75) return;
    acquired = true;
    let closed = false;
    // The helper and Node share the inherited open file description. Closing the
    // child descriptor does not release the lock while this handle remains open.
    return {
      async release() {
        if (!closed) {
          closed = true;
          await handle.close();
        }
      },
    };
  } finally {
    if (!acquired) await handle.close();
  }
}

export async function withLock<T>(
  file: string,
  operation: () => Promise<T>,
  mode: LockMode = 'exclusive',
): Promise<T> {
  const lease = await acquireLock(file, mode);
  if (!lease) throw new Error('Timed out waiting for cache lock');
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}
