import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const entry = path.join(
  process.env.AVC_LIFECYCLE_VOLUME,
  'actions-volume-cache/v1/repos',
  process.env.GITHUB_REPOSITORY_ID,
  hash('lifecycle'),
  hash('workspace:.cache/lifecycle-target'),
);
if (process.env.STATE_expected === 'saved') {
  const current = JSON.parse(await fs.readFile(path.join(entry, 'current.json'), 'utf8'));
  assert.equal(
    await fs.readFile(path.join(entry, 'generations', current.generation, 'payload/value'), 'utf8'),
    'lifecycle-data',
  );
} else {
  assert.equal(process.env.STATE_expected, 'absent');
  await assert.rejects(fs.stat(path.join(entry, 'current.json')), { code: 'ENOENT' });
}
console.log(`LIFECYCLE_VERIFIED ${process.env.STATE_expected}`);
