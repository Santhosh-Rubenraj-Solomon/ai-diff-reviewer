/**
 * Token-budgeted context assembly.
 *
 * Per file the model gets: the line-numbered diff (always), the full head file
 * (when it fits), and — only for symbols the diff actually touched — the call
 * sites in files that import it.
 *
 * The ripple search does match symbol names as words, but only *inside files
 * already known to import this module* via a resolved edge. That is what keeps
 * it from behaving like a repo-wide text search for an identifier.
 */

import type { ChangeSet, ChangedFile, FileContext, RippleSnippet, Rule } from '../types.ts';
import { reviewableLines } from '../diff/parse.ts';
import { renderNumberedContent, renderNumberedDiff, renderSymbolOutline } from '../diff/render.ts';
import { rulesForPath } from '../rules/match.ts';
import { languageOf } from '../diff/filter.ts';
import { analyze, touchedSymbols } from './parse.ts';
import { dependentsOf, type ImportGraph } from './graph.ts';
import type { RepoSnapshot } from './repo.ts';
import type { ContextMode } from '../config.ts';

export interface SelectOptions {
  mode: ContextMode;
  /** Head files larger than this keep their diff and get an outline instead. */
  headFileMaxBytes: number;
  rippleMaxFiles: number;
  rippleSnippetsPerFile: number;
  rippleSnippetLines: number;
}

export const DEFAULT_SELECT_OPTIONS: SelectOptions = {
  mode: 'full',
  headFileMaxBytes: 60 * 1024,
  rippleMaxFiles: 5,
  rippleSnippetsPerFile: 3,
  rippleSnippetLines: 20,
};

export interface SelectionReport {
  contexts: FileContext[];
  /** Files whose head body was replaced by an outline, and why. */
  outlined: { path: string; reason: string }[];
  rippleFiles: number;
  rippleSnippets: number;
}

export async function selectContext(
  changeSet: ChangeSet,
  rules: readonly Rule[],
  snapshot: RepoSnapshot,
  graph: ImportGraph | null,
  opts: SelectOptions = DEFAULT_SELECT_OPTIONS,
): Promise<SelectionReport> {
  const contexts: FileContext[] = [];
  const outlined: { path: string; reason: string }[] = [];
  let rippleFiles = 0;
  let rippleSnippets = 0;

  for (const file of changeSet.files) {
    const numberedDiff = renderNumberedDiff(file, changeSet.headSha);
    const fileRules = rulesForPath(rules, file.path);

    let numberedHeadContent: string | null = null;
    let symbolOutline: string | null = null;

    if (opts.mode !== 'off' && file.headContent !== null) {
      const bytes = Buffer.byteLength(file.headContent, 'utf8');
      if (bytes <= opts.headFileMaxBytes) {
        numberedHeadContent = renderNumberedContent(file.headContent);
      } else {
        const analysis = analyze(file.language, file.headContent);
        symbolOutline = renderSymbolOutline(
          analysis.exports.map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            line: symbol.startLine,
          })),
        );
        outlined.push({ path: file.path, reason: `head file is ${bytes} bytes` });
      }
    }

    const ripple =
      opts.mode === 'full' && graph
        ? await rippleFor(file, snapshot, graph, opts)
        : [];
    if (ripple.length > 0) {
      rippleFiles += new Set(ripple.map((snippet) => snippet.path)).size;
      rippleSnippets += ripple.length;
    }

    contexts.push({ file, numberedDiff, numberedHeadContent, symbolOutline, ripple, rules: fileRules });
  }

  return { contexts, outlined, rippleFiles, rippleSnippets };
}

async function rippleFor(
  file: ChangedFile,
  snapshot: RepoSnapshot,
  graph: ImportGraph,
  opts: SelectOptions,
): Promise<RippleSnippet[]> {
  if (file.headContent === null) return [];

  const analysis = analyze(file.language, file.headContent);
  const touched = touchedSymbols(analysis.exports, reviewableLines(file.hunks));
  if (touched.length === 0) return [];

  const names = new Set(touched.map((symbol) => symbol.name));
  const importers = dependentsOf(graph, file.path, { depth: 2, maxFiles: opts.rippleMaxFiles });
  const snippets: RippleSnippet[] = [];

  for (const importer of importers) {
    const content = await snapshot.read(importer);
    if (content === null) continue;
    if (languageOf(importer) === null) continue;

    const lines = content.split('\n');
    let taken = 0;

    for (let index = 0; index < lines.length && taken < opts.rippleSnippetsPerFile; index += 1) {
      const line = lines[index]!;
      const hit = [...names].find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(line));
      if (!hit) continue;
      // Skip the import statement itself — it is not a call site.
      if (/^\s*(import|export)\b/.test(line)) continue;

      const radius = Math.floor(opts.rippleSnippetLines / 2);
      const start = Math.max(1, index + 1 - radius);
      const end = Math.min(lines.length, index + 1 + radius);
      snippets.push({
        path: importer,
        symbol: hit,
        startLine: start,
        text: renderNumberedContent(lines.slice(start - 1, end).join('\n'), start),
      });
      taken += 1;
      index = end; // do not emit overlapping windows
    }
  }

  return snippets;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
