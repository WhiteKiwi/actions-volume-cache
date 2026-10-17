import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { excluded } from './paths.js';
import { noSymlinkAncestors, safeRelative } from './fs.js';
import { InputError, type Manifest, type Options, type TreeNode } from './types.js';

export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
export const MAX_NODES = 100_000;

async function copyFile(
  source: string,
  target: string,
  expected?: TreeNode,
): Promise<{ bytes: number }> {
  await noSymlinkAncestors(source);
  await noSymlinkAncestors(target);
  const reader = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await reader.stat();
    if (!before.isFile()) throw new Error('Unsupported source file type');
    const writer = await fs.open(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // Copy the already-open regular files, not workflow-controlled paths.
      // Linux procfs keeps O_NOFOLLOW/O_EXCL handling while libuv can use
      // reflink or kernel copying, falling back to a regular copy as needed.
      await fs.copyFile(
        `/proc/self/fd/${reader.fd}`,
        `/proc/self/fd/${writer.fd}`,
        constants.COPYFILE_FICLONE,
      );
      const bytes = (await writer.stat()).size;
      const after = await reader.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size)
        throw new Error('Source changed during cache copy');
      if (expected && expected.bytes !== bytes) throw new Error('Cached file size mismatch');
      await writer.chmod((expected?.mode ?? before.mode) & 0o777);
      const mtime = new Date(expected?.mtime ?? before.mtimeMs);
      await writer.utimes(mtime, mtime);
      return { bytes };
    } finally {
      await writer.close();
    }
  } finally {
    await reader.close();
  }
}

export async function snapshot(
  source: string,
  payload: string,
  options: Options,
): Promise<Manifest> {
  const nodes: TreeNode[] = [];
  async function visit(file: string, target: string, relative: string): Promise<void> {
    if (excluded(file, options)) return;
    if (!safeRelative(relative)) throw new InputError('Unsupported file name in cache path');
    if (nodes.length >= MAX_NODES) throw new Error('Cache unit exceeds 100,000 nodes');
    await noSymlinkAncestors(file);
    const stat = await fs.lstat(file);
    const base = { relative, mode: stat.mode & 0o777, mtime: stat.mtimeMs };
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(file);
      await fs.symlink(link, target);
      await fs.lutimes(target, new Date(stat.mtimeMs), new Date(stat.mtimeMs));
      nodes.push({ ...base, kind: 'symlink', bytes: Buffer.byteLength(link), target: link });
    } else if (stat.isDirectory()) {
      await fs.mkdir(target, { mode: 0o700 });
      nodes.push({ ...base, kind: 'directory', bytes: 0 });
      for (const child of (await fs.readdir(file)).sort())
        await visit(
          path.join(file, child),
          path.join(target, child),
          relative ? `${relative}/${child}` : child,
        );
      await fs.chmod(target, base.mode);
      await fs.utimes(target, new Date(base.mtime), new Date(base.mtime));
    } else if (stat.isFile()) {
      const result = await copyFile(file, target);
      nodes.push({ ...base, kind: 'file', ...result });
    } else throw new Error(`Unsupported special file: ${file}`);
  }
  await visit(source, payload, '');
  const manifest: Manifest = { schema: 2, nodes };
  if (Buffer.byteLength(JSON.stringify(manifest)) > MAX_MANIFEST_BYTES)
    throw new Error('Cache manifest exceeds 32 MiB');
  return manifest;
}

export function validateManifest(value: unknown): Manifest {
  const manifest = value as Manifest;
  if (
    !manifest ||
    ![1, 2].includes(manifest.schema) ||
    !Array.isArray(manifest.nodes) ||
    !manifest.nodes.length ||
    manifest.nodes.length > MAX_NODES
  )
    throw new Error('Invalid cache manifest');
  const seen = new Map<string, TreeNode>();
  for (const node of manifest.nodes) {
    if (
      !node ||
      typeof node.relative !== 'string' ||
      !safeRelative(node.relative) ||
      seen.has(node.relative) ||
      !['file', 'directory', 'symlink'].includes(node.kind) ||
      !Number.isInteger(node.mode) ||
      node.mode < 0 ||
      node.mode > 0o777 ||
      !Number.isFinite(node.mtime) ||
      Math.abs(node.mtime) > 8.64e15 ||
      !Number.isSafeInteger(node.bytes) ||
      node.bytes < 0
    )
      throw new Error('Invalid cache manifest node');
    if (node.relative !== '') {
      const parent = path.posix.dirname(node.relative);
      if (seen.get(parent === '.' ? '' : parent)?.kind !== 'directory')
        throw new Error('Cache manifest parent is not a directory');
    }
    if (
      manifest.schema === 1 &&
      node.kind === 'file' &&
      (typeof node.digest !== 'string' || !/^[a-f0-9]{64}$/.test(node.digest))
    )
      throw new Error('Invalid cached file digest');
    if (
      node.kind === 'symlink' &&
      (typeof node.target !== 'string' ||
        node.target.includes('\0') ||
        Buffer.byteLength(node.target) !== node.bytes)
    )
      throw new Error('Invalid cached link');
    if (node.kind === 'directory' && node.bytes !== 0) throw new Error('Invalid directory size');
    seen.set(node.relative, node);
  }
  if (!seen.has('')) throw new Error('Cache manifest root missing');
  return manifest;
}

export function selectedNodes(
  manifest: Manifest,
  destination: string,
  options: Options,
): TreeNode[] {
  return manifest.nodes.filter((node) => !excluded(path.join(destination, node.relative), options));
}

export async function materialize(
  payload: string,
  destination: string,
  nodes: TreeNode[],
): Promise<void> {
  for (const node of nodes) {
    const source = path.join(payload, node.relative);
    const target = path.join(destination, node.relative);
    await noSymlinkAncestors(source);
    const stat = await fs.lstat(source);
    if (node.kind === 'directory') {
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Cached directory type mismatch');
      await fs.mkdir(target, { mode: 0o700 });
    } else if (node.kind === 'symlink') {
      if (!stat.isSymbolicLink() || (await fs.readlink(source)) !== node.target)
        throw new Error('Cached symlink mismatch');
      await fs.symlink(node.target!, target);
      await fs.lutimes(target, new Date(node.mtime), new Date(node.mtime));
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Cached file type mismatch');
      await copyFile(source, target, node);
    }
  }
  // Apply directory metadata after preparing children, before root replacement.
  for (const node of [...nodes].reverse())
    if (node.kind === 'directory') {
      const target = path.join(destination, node.relative);
      await fs.chmod(target, node.mode);
      await fs.utimes(target, new Date(node.mtime), new Date(node.mtime));
    }
}

export const payloadBytes = (nodes: TreeNode[]): number =>
  nodes.reduce((total, node) => total + node.bytes, 0);
export const hasData = (nodes: TreeNode[]): boolean =>
  nodes.some((node) => node.kind !== 'directory');
