/**
 * Import graph and reverse dependents.
 *
 * Edges come from resolved module specifiers only. Matching identifier *words*
 * against exported names — the tempting shortcut — creates edges from comments
 * and string literals, and collides every same-named export in the repo.
 * An import we cannot resolve is dropped and counted, never guessed at.
 */

import { dirname, join, normalize } from 'node:path';
import type { FileAnalysis } from './parse.ts';
import { analyze } from './parse.ts';
import { languageOf } from '../diff/filter.ts';
import type { RepoSnapshot } from './repo.ts';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = EXTENSIONS.map((extension) => `index${extension}`);

export interface ImportGraph {
  analyses: Map<string, FileAnalysis>;
  /** importee path -> importer paths */
  dependents: Map<string, string[]>;
  unresolvedImports: number;
  analyzedFiles: number;
  analyzerNames: string[];
  /** Named degradations, e.g. a tsconfig that exists but could not be parsed. */
  degradations?: string[];
}

export interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/**
 * Strips `//` and `/* *\/` comments and trailing commas from JSONC, leaving
 * string literals untouched. A regex stripper cannot do this: the common alias
 * `"@/*"` contains `/*` and would be read as the start of a block comment.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
      out += ' ';
    } else if (char === ',') {
      // A trailing comma: the next significant character closes the container.
      const ahead = nextSignificant(text, index + 1);
      if (ahead !== '}' && ahead !== ']') out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

/** First significant character at or after `from`, skipping whitespace and comments. */
function nextSignificant(text: string, from: number): string | null {
  let index = from;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 2;
    } else {
      return char;
    }
  }
  return null;
}

/**
 * Reads `compilerOptions.baseUrl` / `paths` if a tsconfig is present.
 * A tsconfig that exists but cannot be parsed is reported through `onError`
 * (the graph records it as a degradation) rather than silently ignored.
 */
export async function readTsconfigPaths(
  snapshot: RepoSnapshot,
  onError?: (reason: string) => void,
): Promise<TsconfigPaths | null> {
  for (const candidate of ['tsconfig.json', 'jsconfig.json']) {
    const text = await snapshot.read(candidate);
    if (!text) continue;
    let parsed: { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
      // Tolerate comments and trailing commas in tsconfig.
      parsed = JSON.parse(stripJsonComments(text)) as typeof parsed;
    } catch (err) {
      onError?.(`${candidate} could not be parsed (${err instanceof Error ? err.message : String(err)}); path aliases ignored`);
      continue;
    }
    const options = parsed?.compilerOptions;
    if (!options?.paths && !options?.baseUrl) continue;
    return { baseUrl: options.baseUrl ?? '.', paths: options.paths ?? {} };
  }
  return null;
}

function tidy(path: string): string {
  return normalize(path).replace(/\\/g, '/').replace(/^\.\//, '');
}

function resolveCandidates(base: string): string[] {
  return [
    base,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...INDEX_FILES.map((index) => `${base}/${index}`),
  ];
}

export function resolveImport(
  fromFile: string,
  source: string,
  fileSet: Set<string>,
  tsconfig: TsconfigPaths | null,
): string | null {
  if (source.startsWith('.')) {
    const base = tidy(join(dirname(fromFile), source));
    return resolveCandidates(base).find((candidate) => fileSet.has(candidate)) ?? null;
  }

  if (tsconfig) {
    for (const [alias, targets] of Object.entries(tsconfig.paths)) {
      const prefix = alias.replace(/\*$/, '');
      if (!source.startsWith(prefix)) continue;
      const rest = source.slice(prefix.length);
      for (const target of targets) {
        const base = tidy(join(tsconfig.baseUrl, target.replace(/\*$/, '') + rest));
        const hit = resolveCandidates(base).find((candidate) => fileSet.has(candidate));
        if (hit) return hit;
      }
    }
  }

  // Bare package specifiers are external; not an unresolved edge.
  return null;
}

export async function buildGraph(
  snapshot: RepoSnapshot,
  opts: { maxFiles?: number } = {},
): Promise<ImportGraph> {
  const analyses = new Map<string, FileAnalysis>();
  const dependents = new Map<string, string[]>();
  const analyzerNames = new Set<string>();
  let unresolvedImports = 0;

  if (!snapshot.root) {
    return { analyses, dependents, unresolvedImports: 0, analyzedFiles: 0, analyzerNames: [] };
  }

  const degradations: string[] = [];
  const tsconfig = await readTsconfigPaths(snapshot, (reason) => degradations.push(`tsconfig:${reason}`));
  const fileSet = new Set(snapshot.files.map(tidy));
  const maxFiles = opts.maxFiles ?? 5_000;

  const candidates = snapshot.files
    .filter((path) => languageOf(path) !== null)
    .slice(0, maxFiles);

  for (const path of candidates) {
    const content = await snapshot.read(path);
    if (content === null) continue;
    const analysis = analyze(languageOf(path), content);
    if (analysis.analyzer === 'none') continue;
    analyses.set(tidy(path), analysis);
    analyzerNames.add(analysis.analyzer);
  }

  for (const [importer, analysis] of analyses) {
    for (const entry of analysis.imports) {
      const target = resolveImport(importer, entry.source, fileSet, tsconfig);
      if (!target) {
        if (entry.source.startsWith('.')) unresolvedImports += 1;
        continue;
      }
      const list = dependents.get(target);
      if (list) list.push(importer);
      else dependents.set(target, [importer]);
    }
  }

  return {
    analyses,
    dependents,
    unresolvedImports,
    analyzedFiles: analyses.size,
    analyzerNames: [...analyzerNames],
    degradations,
  };
}

/** Reverse-import walk, breadth-first, bounded by depth and file count. */
export function dependentsOf(
  graph: ImportGraph,
  path: string,
  opts: { depth: number; maxFiles: number },
): string[] {
  const seen = new Set<string>([tidy(path)]);
  const out: string[] = [];
  let frontier = [tidy(path)];

  for (let level = 0; level < opts.depth; level += 1) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const importer of graph.dependents.get(node) ?? []) {
        if (seen.has(importer)) continue;
        seen.add(importer);
        out.push(importer);
        next.push(importer);
        if (out.length >= opts.maxFiles) return out;
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return out;
}
