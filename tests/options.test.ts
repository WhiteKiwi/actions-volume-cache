import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionsFrom, parseSize } from '../src/options.js';
import { InputError } from '../src/types.js';

const env = { GITHUB_REPOSITORY_ID: '123', GITHUB_WORKSPACE: '/workspace', HOME: '/runner' };
const values: Record<string, string> = { path: 'target', key: 'build', 'volume-path': '/cache' };
test('required inputs, defaults, size grammar and invalid settings', () => {
  const parsed = optionsFrom((name) => values[name] ?? '', env);
  assert.equal(parsed.autoCleanup, true);
  assert.equal(parsed.retentionDays, 7);
  assert.equal(parsed.maxBytes, undefined);
  assert.equal(parseSize('100GiB'), 100 * 1024 ** 3);
  assert.equal(parseSize('123'), 123);
  for (const name of ['path', 'key', 'volume-path'])
    assert.throws(
      () => optionsFrom((key) => (key === name ? '' : (values[key] ?? '')), env),
      InputError,
    );
  for (const [name, bad] of [
    ['path', '!target'],
    ['key', 'bad\0key'],
    ['key', 'x'.repeat(513)],
    ['auto-cleanup', 'yes'],
    ['cleanup-retention-days', '0'],
    ['cleanup-retention-days', 'NaN'],
    ['max-cache-size', '-1'],
    ['max-cache-size', '0'],
    ['max-cache-size', '1.5GiB'],
  ]) {
    assert.throws(
      () => optionsFrom((key) => (key === name ? bad! : (values[key] ?? '')), env),
      InputError,
    );
  }
});
