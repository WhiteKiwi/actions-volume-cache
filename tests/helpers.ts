import * as fs from 'node:fs/promises';
import path from 'node:path';
import { type Options, type Reporter } from '../src/types.js';

export async function fixture(overrides: Partial<Options> = {}) {
  const parent = path.resolve('.cache/tests');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'case-'));
  for (const name of ['workspace', 'home', 'volume']) await fs.mkdir(path.join(root, name));
  const options: Options = {
    paths: ['target'],
    key: 'build-a',
    restoreKeys: [],
    repository: '123',
    workspace: path.join(root, 'workspace'),
    home: path.join(root, 'home'),
    volume: path.join(root, 'volume'),
    autoCleanup: true,
    retentionDays: 7,
    ...overrides,
  };
  const warnings: string[] = [];
  const reporter: Reporter = {
    info() {},
    warning(message) {
      warnings.push(message);
    },
  };
  return {
    root,
    options,
    warnings,
    reporter,
    async file(relative: string, value: string) {
      const target = path.join(options.workspace, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, value);
      return target;
    },
    async read(relative: string) {
      return fs.readFile(path.join(options.workspace, relative), 'utf8');
    },
    async reset() {
      await fs.rm(options.workspace, { recursive: true, force: true });
      await fs.mkdir(options.workspace);
    },
    async close() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
