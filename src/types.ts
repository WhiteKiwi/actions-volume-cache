export class InputError extends Error {}

export interface Options {
  paths: string[];
  key: string;
  restoreKeys: string[];
  volume: string;
  workspace: string;
  home: string;
  repository: string;
  autoCleanup: boolean;
  retentionDays: number;
  maxBytes?: number;
}

export interface Reporter {
  info(message: string): void;
  warning(message: string): void;
}

export const silent: Reporter = { info() {}, warning() {} };

export interface Unit {
  id: string;
  destination: string;
}
export interface Selection {
  units: Unit[];
  unmatched: boolean;
}
export type NodeKind = 'file' | 'directory' | 'symlink';
export interface TreeNode {
  relative: string;
  kind: NodeKind;
  mode: number;
  mtime: number;
  bytes: number;
  digest?: string;
  target?: string;
}

export interface Entry {
  schema: 1;
  repository: string;
  key: string;
  path: string;
  generation: string;
  sequence: number;
  publishedAt: number;
  lastUsedAt: number;
  bytes: number;
  manifestDigest: string;
}

export interface Manifest {
  schema: 1;
  nodes: TreeNode[];
}
export interface StoredEntry {
  entry: Entry;
  directory: string;
}
export interface TestHooks {
  point?(name: string): Promise<void>;
}
