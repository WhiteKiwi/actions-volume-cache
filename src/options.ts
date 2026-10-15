import path from 'node:path';
import os from 'node:os';
import { InputError, type Options } from './types.js';

export function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
export function validateKey(key: string): void {
  if (!key.trim() || key.length > 512 || /[\x00-\x1f\x7f]/.test(key))
    throw new InputError('Keys must contain 1–512 characters without control characters');
}

export function parseSize(value: string): number | undefined {
  if (!value.trim()) return;
  const match = /^(\d+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/.exec(value.trim());
  if (!match)
    throw new InputError('max-cache-size must be an integer byte count or size such as 100GiB');
  const units: Record<string, number> = {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  };
  const bytes = Number(match[1]) * units[match[2] ?? 'B']!;
  if (!Number.isSafeInteger(bytes) || bytes <= 0)
    throw new InputError('max-cache-size must be a positive safe integer');
  return bytes;
}

export function optionsFrom(get: (name: string) => string, env = process.env): Options {
  for (const name of ['path', 'key', 'volume-path'])
    if (!get(name).trim()) throw new InputError(`Missing required input: ${name}`);
  const paths = lines(get('path'));
  if (!paths.some((item) => !item.startsWith('!')))
    throw new InputError('path requires at least one positive path');
  const key = get('key').trim();
  const restoreKeys = lines(get('restore-keys'));
  [key, ...restoreKeys].forEach(validateKey);
  const cleanup = get('auto-cleanup').trim() || 'true';
  if (!['true', 'false'].includes(cleanup))
    throw new InputError('auto-cleanup must be true or false');
  const retentionDays = Number(get('cleanup-retention-days').trim() || '7');
  if (
    !Number.isFinite(retentionDays) ||
    retentionDays <= 0 ||
    !Number.isFinite(retentionDays * 86400000)
  )
    throw new InputError('cleanup-retention-days must be positive and finite');
  if (!env.GITHUB_REPOSITORY_ID || !/^\d+$/.test(env.GITHUB_REPOSITORY_ID))
    throw new InputError('GITHUB_REPOSITORY_ID must be a numeric repository ID');
  if (!env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE))
    throw new InputError('GITHUB_WORKSPACE must be an absolute path');
  const home = path.resolve(env.HOME ?? os.homedir());
  const rawVolume = get('volume-path').trim();
  const volume = path.resolve(
    rawVolume === '~'
      ? home
      : rawVolume.startsWith('~/')
        ? path.join(home, rawVolume.slice(2))
        : rawVolume,
  );
  return {
    paths,
    key,
    restoreKeys,
    volume,
    workspace: path.resolve(env.GITHUB_WORKSPACE),
    home,
    repository: env.GITHUB_REPOSITORY_ID,
    autoCleanup: cleanup === 'true',
    retentionDays,
    maxBytes: parseSize(get('max-cache-size')),
  };
}
