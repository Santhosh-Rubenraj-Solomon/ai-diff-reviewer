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
}

export interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

/** Reads `compilerOptions.baseUrl` / `paths` if a tsconfig is present. */
export async function readTsconfigPaths(snapshot: RepoSnapshot): Promise<TsconfigPaths | null> {
  for (const candidate of ['tsconfig.json', 'jsconfig.json']) {
    const text = await snapshot.read(candidate);
    if (!text) continue;
    try {
      // Tolerate comments and trailing commas in tsconfig.
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(stripped) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const options = parsed.compilerOptions;
      if (!options?.paths && !options?.baseUrl) continue;
      return { baseUrl: options.baseUrl ?? '.', paths: options.paths ?? {} };
    } catch {
      continue;
    }
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

  const tsconfig = await readTsconfigPaths(snapshot);
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
