import * as fs from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { type Options } from '../src/types.js';

export function worker(mode: string, options: Options, signal: string, pause = '') {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/worker.ts', mode, JSON.stringify(options), signal, pause],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const completed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, completed };
}
export async function signaled(file: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (
      await fs.stat(file).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(20);
  }
  throw new Error(`Worker did not reach ${file}`);
}
export async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
