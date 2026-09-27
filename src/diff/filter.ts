/**
 * Deliberate, explicit file filtering.
 *
 * `.gitignore` is not consulted — it is the wrong list, and a reviewer that
 * silently inherits it skips files nobody decided to skip. Every decision here
 * returns a named reason that ends up in the run status and the summary.
 */

import picomatch from 'picomatch';
import type { SkipReason } from '../types.ts';

const VENDORED_GLOBS = [
  '**/node_modules/**',
  '**/vendor/**',
  '**/third_party/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/Pods/**',
];

const GENERATED_GLOBS = [
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.pb.go',
  '**/*.pb.cc',
  '**/*.pb.h',
  '**/*_pb2.py',
  '**/*.generated.*',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/migrations/**/*.sql',
];

const LOCKFILE_GLOBS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/Gemfile.lock',
  '**/composer.lock',
  '**/go.sum',
];

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'avif',
  'pdf', 'zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg',
  'so', 'dylib', 'dll', 'exe', 'bin', 'class', 'jar', 'wasm',
  'sqlite', 'db', 'pyc', 'pdb',
]);

const isVendored = picomatch(VENDORED_GLOBS, { dot: true });
const isGenerated = picomatch(GENERATED_GLOBS, { dot: true });
const isLockfile = picomatch(LOCKFILE_GLOBS, { dot: true });

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', scala: 'scala', sh: 'shell', bash: 'shell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
  tf: 'terraform', vue: 'vue', svelte: 'svelte', css: 'css', scss: 'scss',
};

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

export interface FilterInput {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  content: string | null;
  /** Byte size when known ahead of fetching content. */
  sizeBytes?: number;
  /** Set by the platform adapter when the API flagged the blob as binary. */
  platformSaysBinary?: boolean;
  maxFileBytes: number;
}

/** Returns the reason this file should not be reviewed, or null to review it. */
export function classify(input: FilterInput): SkipReason | null {
  const { path, status, content } = input;

  if (status === 'deleted') return 'deleted';
  if (input.platformSaysBinary) return 'binary';
  if (BINARY_EXTENSIONS.has(extensionOf(path))) return 'binary';
  if (isLockfile(path)) return 'lockfile';
  if (isVendored(path)) return 'vendored';
  if (isGenerated(path)) return 'generated';

  const size = input.sizeBytes ?? (content === null ? 0 : Buffer.byteLength(content, 'utf8'));
  if (size > input.maxFileBytes) return 'too-large';

  if (content === null) return 'no-content';
  // A NUL byte in the first block is the reliable binary tell.
  if (content.slice(0, 8192).includes('\u0000')) return 'binary';
  if (/^\s*(\/\/|#|\/\*|<!--)?\s*@generated\b/m.test(content.slice(0, 2048))) return 'generated';

  return null;
}

export function describeSkip(reason: SkipReason): string {
  switch (reason) {
    case 'binary': return 'binary file';
    case 'vendored': return 'vendored path';
    case 'generated': return 'generated file';
    case 'lockfile': return 'lockfile';
    case 'too-large': return 'over the size limit';
    case 'deleted': return 'deleted in this change';
    case 'ignored': return 'excluded by configuration';
    case 'no-content': return 'content unavailable at head';
  }
}
