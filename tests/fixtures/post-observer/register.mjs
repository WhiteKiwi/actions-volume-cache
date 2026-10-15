import { appendFile } from 'node:fs/promises';
await appendFile(process.env.GITHUB_STATE, `expected=${process.env.INPUT_EXPECTED}\n`);
