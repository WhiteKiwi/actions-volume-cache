import * as fs from 'node:fs/promises';
import { restore, save } from '../src/cache.js';
import { type Options } from '../src/types.js';

const [mode, serialized, signal, pause = ''] = process.argv.slice(2);
const options = JSON.parse(serialized!) as Options;
const report = {
  info() {},
  warning(message: string) {
    process.stderr.write(`${message}\n`);
  },
};
const hooks = {
  async point(name: string) {
    if (name !== pause) return;
    await fs.writeFile(signal!, name);
    // This worker is intentionally killed or released by the parent test.
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
  },
};
if (mode === 'save') await save(options, report, hooks);
else process.stdout.write(await restore(options, report, hooks));
