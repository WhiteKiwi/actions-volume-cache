import path from 'node:path';
import * as fs from 'node:fs/promises';
import * as glob from '@actions/glob';
import { minimatch } from 'minimatch';
import { InputError, type Options, type Selection, type Unit } from './types.js';
import { overlaps, realLocation, within } from './fs.js';

export function absolutePattern(raw: string, options: Options): string {
  if (/[\x00-\x1f\x7f]/.test(raw))
    throw new InputError('Path patterns cannot contain control characters');
  if (raw.startsWith('~') && raw !== '~' && !raw.startsWith('~/'))
    throw new InputError('Only ~/ home expansion is supported');
  return path.resolve(
    options.workspace,
    raw === '~' ? options.home : raw.startsWith('~/') ? path.join(options.home, raw.slice(2)) : raw,
  );
}

export function patterns(options: Options): { positive: string[]; negative: string[] } {
  return {
    positive: options.paths
      .filter((item) => !item.startsWith('!'))
      .map((item) => absolutePattern(item, options)),
    negative: options.paths
      .filter((item) => item.startsWith('!'))
      .map((item) => absolutePattern(item.slice(1), options)),
  };
}

const magic = (text: string): boolean => /[*?\[\]{}()]/.test(text);
const matches = (candidate: string, pattern: string): boolean =>
  minimatch(candidate, pattern, { dot: true, nonegate: true, nocomment: true });

export function excluded(file: string, options: Options): boolean {
  const negative = patterns(options).negative;
  let current = path.resolve(file);
  while (true) {
    if (negative.some((pattern) => matches(current, pattern) || matches(`${current}/`, pattern)))
      return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function identity(file: string, options: Options): string {
  if (within(options.workspace, file)) return `workspace:${path.relative(options.workspace, file)}`;
  if (within(options.home, file)) return `home:${path.relative(options.home, file)}`;
  return `absolute:${file}`;
}

export function destination(id: string, options: Options): string {
  for (const [prefix, base] of [
    ['workspace:', options.workspace],
    ['home:', options.home],
  ] as const) {
    if (id.startsWith(prefix)) {
      const relative = id.slice(prefix.length);
      const result = path.resolve(base, relative);
      if (
        !within(base, result) ||
        path.isAbsolute(relative) ||
        relative.split('/').some((part) => part === '..')
      )
        throw new InputError('Invalid cached relative path');
      return result;
    }
  }
  if (id.startsWith('absolute:') && path.isAbsolute(id.slice(9)))
    return path.normalize(id.slice(9));
  throw new InputError('Invalid logical path identity');
}

export async function validateTarget(file: string, options: Options): Promise<void> {
  const real = await realLocation(file);
  const volume = await realLocation(options.volume);
  const home = await realLocation(options.home);
  if (
    [path.parse(file).root, options.home].includes(file) ||
    real === path.parse(real).root ||
    real === home ||
    overlaps(file, options.volume) ||
    overlaps(real, volume)
  ) {
    throw new InputError(`Unsafe cache path: ${file}`);
  }
}

export async function validateOptions(options: Options): Promise<void> {
  if (process.platform !== 'linux')
    throw new InputError('This action currently supports Linux only');
  const volume = await realLocation(options.volume);
  if (volume === '/' || volume === (await realLocation(options.home)))
    throw new InputError('volume-path must not be filesystem root or the entire home');
  const { positive, negative } = patterns(options);
  if (!positive.length) throw new InputError('At least one positive path is required');
  for (const pattern of [...positive, ...negative]) {
    if (!magic(pattern)) {
      await validateTarget(pattern, options);
      continue;
    }
    const parts = pattern.split('/');
    const firstMagic = parts.findIndex((part) => magic(part));
    const search = parts.slice(0, firstMagic).join('/') || '/';
    await validateTarget(search, options);
  }
}

// Existing directory roots own descendants so overlapping globs do not create
// separate entries for every file under an already-selected directory.
export function collapse(units: Unit[]): Unit[] {
  const result: Unit[] = [];
  for (const unit of units.sort(
    (a, b) => a.destination.length - b.destination.length || a.id.localeCompare(b.id),
  )) {
    if (!result.some((parent) => within(parent.destination, unit.destination))) result.push(unit);
  }
  return result;
}

export async function selectUnits(
  options: Options,
  cachedIds: string[],
  includeMissing: boolean,
): Promise<Selection> {
  const { positive } = patterns(options);
  const chosen = new Map<string, Unit>();
  let unmatched = false;
  for (const pattern of positive) {
    const found = new Set<string>();
    if (!magic(pattern)) {
      if (
        includeMissing ||
        (await fs.lstat(pattern).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ))
      )
        found.add(pattern);
    } else {
      const matcher = await glob.create(pattern, {
        followSymbolicLinks: false,
        implicitDescendants: false,
        omitBrokenSymbolicLinks: false,
      });
      for (const file of await matcher.glob()) found.add(path.resolve(file));
    }
    for (const id of cachedIds) {
      const file = destination(id, options);
      if (matches(file, pattern) || matches(`${file}/`, pattern) || file === pattern)
        found.add(file);
    }
    let included = false;
    for (const file of found) {
      if (excluded(file, options)) continue;
      await validateTarget(file, options);
      const unit = { id: identity(file, options), destination: file };
      chosen.set(unit.id, unit);
      included = true;
    }
    if (!included) unmatched = true;
  }
  return { units: collapse([...chosen.values()]), unmatched };
}
