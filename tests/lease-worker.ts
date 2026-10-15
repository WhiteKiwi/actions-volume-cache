import * as fs from 'node:fs/promises';
import { acquireLock } from '../src/lock.js';

const [file, signal] = process.argv.slice(2);
const lease = await acquireLock(file!);
if (!lease) throw new Error('Cannot acquire fixture lease');
await fs.writeFile(signal!, 'acquired');
await new Promise<void>((resolve) => {
  const interval = setInterval(async () => {
    if (
      await fs.stat(`${signal}.release`).then(
        () => true,
        () => false,
      )
    ) {
      clearInterval(interval);
      resolve();
    }
  }, 20);
});
await lease.release();
