import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { noSymlinkAncestors } from './fs.js';

export async function withLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  await noSymlinkAncestors(file);
  const handle = await fs.open(
    file,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Invalid lock inode');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--timeout', '300', '3'], {
        stdio: ['ignore', 'ignore', 'pipe', handle.fd],
      });
      let error = '';
      child.stderr!.on('data', (data) => {
        error = (error + String(data)).slice(-1024);
      });
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Cannot acquire cache lock (${code}): ${error.trim()}`)),
      );
    });
    // flock(3) and Node share the inherited open file description. Closing the
    // child descriptor does not release the lock while this handle remains open.
    return await operation();
  } finally {
    await handle.close();
  }
}
