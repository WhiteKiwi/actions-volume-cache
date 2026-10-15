import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.js';

const main = path.resolve('dist/main.js');
const post = path.resolve('dist/post.js');
async function execute(file: string, cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [file], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  return { code, output };
}
function parseCommands(data: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = data.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i]!);
    if (match) {
      const values: string[] = [];
      while (++i < lines.length && lines[i] !== match[2]) values.push(lines[i]!);
      result[match[1]!] = values.join('\n');
    }
  }
  return result;
}

test('packaged main/post handshake works without node_modules at execution time', async () => {
  const f = await fixture();
  try {
    // Copy only distributables to demonstrate runtime dependencies are bundled.
    const bundle = path.join(f.root, 'standalone');
    await fs.mkdir(bundle);
    await fs.writeFile(path.join(bundle, 'package.json'), '{"type":"module"}');
    await fs.copyFile(main, path.join(bundle, 'main.js'));
    await fs.copyFile(post, path.join(bundle, 'post.js'));
    const state = path.join(f.root, 'state');
    const output = path.join(f.root, 'output');
    await fs.writeFile(state, '');
    await fs.writeFile(output, '');
    const env = {
      ...process.env,
      GITHUB_REPOSITORY_ID: f.options.repository,
      GITHUB_WORKSPACE: f.options.workspace,
      HOME: f.options.home,
      GITHUB_STATE: state,
      GITHUB_OUTPUT: output,
      INPUT_PATH: 'target',
      INPUT_KEY: 'key',
      'INPUT_VOLUME-PATH': f.options.volume,
    };
    const run = await execute(path.join(bundle, 'main.js'), f.options.workspace, env);
    assert.equal(run.code, 0, run.output);
    assert.equal(parseCommands(await fs.readFile(output, 'utf8'))['cache-hit'], '');
    const saved = parseCommands(await fs.readFile(state, 'utf8')).options;
    assert.ok(saved);
    await f.file('target/a', 'from-post');
    const savedRun = await execute(path.join(bundle, 'post.js'), f.options.workspace, {
      ...env,
      STATE_options: saved,
    });
    assert.equal(savedRun.code, 0, savedRun.output);
    assert.match(savedRun.output, /Saved/);
    await f.reset();
    await fs.writeFile(output, '');
    const hit = await execute(path.join(bundle, 'main.js'), f.options.workspace, env);
    assert.equal(hit.code, 0, hit.output);
    assert.equal(parseCommands(await fs.readFile(output, 'utf8'))['cache-hit'], 'true');
    assert.equal(await f.read('target/a'), 'from-post');
    await f.file('target/a', 'exact-updated');
    const next = parseCommands(await fs.readFile(state, 'utf8')).options;
    await execute(path.join(bundle, 'post.js'), f.options.workspace, {
      ...env,
      STATE_options: next,
    });
    await f.reset();
    await execute(path.join(bundle, 'main.js'), f.options.workspace, env);
    assert.equal(await f.read('target/a'), 'exact-updated');
  } finally {
    await f.close();
  }
});

test('packaged action fails configuration errors and warns on unavailable volume', async () => {
  const f = await fixture();
  try {
    const state = path.join(f.root, 'state');
    const output = path.join(f.root, 'output');
    await fs.writeFile(state, '');
    await fs.writeFile(output, '');
    const base = {
      ...process.env,
      HOME: f.options.home,
      GITHUB_REPOSITORY_ID: '123',
      GITHUB_WORKSPACE: f.options.workspace,
      GITHUB_STATE: state,
      GITHUB_OUTPUT: output,
      INPUT_PATH: 'target',
      INPUT_KEY: 'key',
      'INPUT_VOLUME-PATH': f.options.volume,
    };
    assert.equal((await execute(main, f.options.workspace, { ...base, INPUT_PATH: '' })).code, 1);
    assert.equal((await execute(main, f.options.workspace, { ...base, INPUT_PATH: '/' })).code, 1);
    const unavailable = await execute(main, f.options.workspace, {
      ...base,
      'INPUT_VOLUME-PATH': path.join(f.root, 'not-mounted'),
    });
    assert.equal(unavailable.code, 0, unavailable.output);
    assert.match(unavailable.output, /warning/);
  } finally {
    await f.close();
  }
});
