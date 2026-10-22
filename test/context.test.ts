import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, jsAnalyzer, pickAnalyzer, pythonAnalyzer, touchedSymbols } from '../src/context/parse.ts';
import { buildGraph, dependentsOf, readTsconfigPaths, resolveImport, type ImportGraph } from '../src/context/graph.ts';
import { DEFAULT_SELECT_OPTIONS, selectContext } from '../src/context/select.ts';
import { emptySnapshot, loadRepoSnapshot, type RepoSnapshot } from '../src/context/repo.ts';
import { parseHunks } from '../src/diff/parse.ts';
import { configureLogger } from '../src/logger.ts';
import type { ChangeSet, ChangedFile, Rule } from '../src/types.ts';
import { makeFakePlatform } from './helpers.ts';

configureLogger({ quiet: true });

function memorySnapshot(files: Record<string, string>): RepoSnapshot {
  return {
    root: '/virtual',
    files: Object.keys(files),
    read: async (path) => files[path] ?? null,
    degraded: null,
  };
}

describe('jsAnalyzer', () => {
  test('finds every import form', () => {
    const { imports } = jsAnalyzer.analyze(
      [
        "import { a } from './a';",
        "import './side-effect';",
        "export * from './re';",
        "export { b } from './b';",
        "const c = require('./c');",
        "const d = await import('./d');",
        "import type { T } from 'pkg';",
      ].join('\n'),
    );
    expect(imports.map((entry) => [entry.source, entry.line])).toEqual([
      ['./a', 1],
      ['./side-effect', 2],
      ['./re', 3],
      ['./b', 4],
      ['./c', 5],
      ['./d', 6],
      ['pkg', 7],
    ]);
  });

  test('finds exported declarations with their kinds and block ranges', () => {
    const source = [
      'export async function load(id: string) {', // 1
      '  if (id) {', //                               2
      '    return "}";', //                           3 brace in a string must not close
      '  }', //                                       4
      '}', //                                         5
      'export const LIMIT = 5;', //                   6
      'export interface Shape {', //                  7
      '  a: number;', //                              8
      '}', //                                         9
      'export type Id = string;', //                  10
      'export const enum Mode { A, B }', //           11
      'export default class Service {}', //           12
      'export abstract class Base {', //              13
      '}', //                                         14
    ].join('\n');
    const { exports } = jsAnalyzer.analyze(source);
    expect(exports.map((s) => [s.name, s.kind, s.startLine, s.endLine])).toEqual([
      ['load', 'function', 1, 5],
      ['LIMIT', 'const', 6, 6],
      ['Shape', 'interface', 7, 9],
      ['Id', 'type', 10, 10],
      ['Mode', 'enum', 11, 11],
      ['Service', 'class', 12, 12],
      ['Base', 'class', 13, 14],
    ]);
  });

  test('a named export list yields re-exports under their public names', () => {
    const { exports } = jsAnalyzer.analyze('export { a, b as c, default as d };');
    expect(exports.map((s) => [s.name, s.kind])).toEqual([
      ['a', 're-export'],
      ['c', 're-export'],
      ['d', 're-export'],
    ]);
  });

  test('an anonymous default export is not invented a name', () => {
    expect(jsAnalyzer.analyze('export default function () {}').exports).toEqual([]);
  });

  test('supports only JS-family languages', () => {
    expect(jsAnalyzer.supports('typescript')).toBe(true);
    expect(jsAnalyzer.supports('svelte')).toBe(true);
    expect(jsAnalyzer.supports('python')).toBe(false);
    expect(jsAnalyzer.supports(null)).toBe(false);
  });
});

describe('pythonAnalyzer', () => {
  test('finds imports and top-level defs and classes, but not methods', () => {
    const source = [
      'import os', //                   1
      'from app.models import User', // 2
      '', //                            3
      'def top(x):', //                 4
      '    def inner():', //            5
      '        pass', //                6
      '    return x', //                7
      '', //                            8
      'class Repo:', //                 9
      '    def method(self):', //       10
      '        pass', //                11
      'async def fetch():', //          12
      '    pass', //                    13
    ].join('\n');
    const { imports, exports } = pythonAnalyzer.analyze(source);
    expect(imports.map((i) => i.source)).toEqual(['os', 'app.models']);
    expect(exports.map((s) => [s.name, s.kind, s.startLine, s.endLine])).toEqual([
      ['top', 'function', 4, 8],
      ['Repo', 'class', 9, 11],
      ['fetch', 'function', 12, 13],
    ]);
  });
});

describe('analyze / pickAnalyzer / touchedSymbols', () => {
  test('records which analyzer ran, or none', () => {
    expect(analyze('typescript', 'export const a = 1;').analyzer).toBe('lexical-js');
    expect(analyze('python', 'def a(): pass').analyzer).toBe('lexical-python');
    expect(analyze('rust', 'pub fn a() {}')).toEqual({ imports: [], exports: [], analyzer: 'none' });
    expect(pickAnalyzer(null)).toBeNull();
  });

  test('touchedSymbols returns symbols whose range overlaps a changed line', () => {
    const exports = [
      { name: 'a', kind: 'function' as const, startLine: 1, endLine: 5 },
      { name: 'b', kind: 'function' as const, startLine: 6, endLine: 9 },
    ];
    expect(touchedSymbols(exports, new Set([5])).map((s) => s.name)).toEqual(['a']);
    expect(touchedSymbols(exports, new Set([7, 3])).map((s) => s.name)).toEqual(['a', 'b']);
    expect(touchedSymbols(exports, new Set())).toEqual([]);
    expect(touchedSymbols(exports, new Set([42]))).toEqual([]);
  });
});

describe('resolveImport', () => {
  const files = new Set(['src/a.ts', 'src/lib/index.ts', 'src/util.js', 'src/deep/x.tsx']);

  test('resolves relative imports with extension and index fallbacks', () => {
    expect(resolveImport('src/b.ts', './a', files, null)).toBe('src/a.ts');
    expect(resolveImport('src/b.ts', './lib', files, null)).toBe('src/lib/index.ts');
    expect(resolveImport('src/b.ts', './util.js', files, null)).toBe('src/util.js');
    expect(resolveImport('src/deep/y.ts', '../a', files, null)).toBe('src/a.ts');
  });

  test('an unresolvable relative import returns null', () => {
    expect(resolveImport('src/b.ts', './missing', files, null)).toBeNull();
  });

  test('bare package specifiers are external', () => {
    expect(resolveImport('src/b.ts', 'react', files, null)).toBeNull();
  });

  test('resolves through tsconfig path aliases', () => {
    const tsconfig = { baseUrl: '.', paths: { '@/*': ['src/*'], '~lib': ['src/lib'] } };
    expect(resolveImport('src/b.ts', '@/deep/x', files, tsconfig)).toBe('src/deep/x.tsx');
    expect(resolveImport('src/b.ts', '~lib', files, tsconfig)).toBe('src/lib/index.ts');
    expect(resolveImport('src/b.ts', '@/nope', files, tsconfig)).toBeNull();
  });
});

describe('readTsconfigPaths', () => {
  test('reads baseUrl and paths, tolerating line comments and trailing commas', async () => {
    const snapshot = memorySnapshot({
      'tsconfig.json': `{
        // compiler settings
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": { "~lib": ["lib"], },
        },
      }`,
    });
    expect(await readTsconfigPaths(snapshot)).toEqual({ baseUrl: './src', paths: { '~lib': ['lib'] } });
  });

  test('falls back to jsconfig.json and defaults baseUrl to "."', async () => {
    const snapshot = memorySnapshot({
      'jsconfig.json': JSON.stringify({ compilerOptions: { paths: { 'x/*': ['y/*'] } } }),
    });
    expect(await readTsconfigPaths(snapshot)).toEqual({ baseUrl: '.', paths: { 'x/*': ['y/*'] } });
  });

  test('returns null when there is no config, it is invalid, or it has no aliases', async () => {
    expect(await readTsconfigPaths(memorySnapshot({}))).toBeNull();
    expect(await readTsconfigPaths(memorySnapshot({ 'tsconfig.json': '{ not json' }))).toBeNull();
    expect(await readTsconfigPaths(memorySnapshot({ 'tsconfig.json': '{"compilerOptions":{"strict":true}}' }))).toBeNull();
  });

  test('a plain "@/*" alias with no comments is read', async () => {
    const snapshot = memorySnapshot({
      'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}',
    });
    expect(await readTsconfigPaths(snapshot)).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });

  // BUG (src/context/graph.ts:40): the block-comment stripper
  // `/\/\*[\s\S]*?\*\//g` treats the `/*` inside the extremely common alias
  // string "@/*" as the start of a comment and deletes everything up to the
  // next real `*/`. With any block comment later in the file the JSON breaks,
  // the catch swallows it, and aliases are silently ignored — the import graph
  // then drops every aliased edge without a degradation being recorded.
  test.todo('an "@/*" alias survives a later block comment in tsconfig', async () => {
    const snapshot = memorySnapshot({
      'tsconfig.json': `{
        "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }
        /* trailing note */
      }`,
    });
    expect(await readTsconfigPaths(snapshot)).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });
});

describe('buildGraph / dependentsOf', () => {
  const repo = {
    'src/core.ts': 'export function core() {}',
    'src/a.ts': "import { core } from './core';\nexport const a = core;",
    'src/b.ts': "import { a } from './a';\nimport x from './missing';\nimport r from 'react';",
    'src/c.ts': "import { a } from './a';",
    'README.md': 'not code we analyse? markdown has a language but no analyzer',
    'tool.py': 'import os',
  };

  test('builds reverse edges from resolved imports and counts unresolved relative ones', async () => {
    const graph = await buildGraph(memorySnapshot(repo));
    expect(graph.dependents.get('src/core.ts')).toEqual(['src/a.ts']);
    expect(graph.dependents.get('src/a.ts')?.sort()).toEqual(['src/b.ts', 'src/c.ts']);
    expect(graph.unresolvedImports).toBe(1);
    expect(graph.analyzerNames.sort()).toEqual(['lexical-js', 'lexical-python']);
    // README.md maps to "markdown", which no analyzer supports.
    expect(graph.analyses.has('README.md')).toBe(false);
  });

  test('an empty snapshot produces an empty graph', async () => {
    const graph = await buildGraph(emptySnapshot('no archive'));
    expect(graph.analyzedFiles).toBe(0);
    expect(graph.dependents.size).toBe(0);
  });

  test('maxFiles bounds how many files are analysed', async () => {
    const graph = await buildGraph(memorySnapshot(repo), { maxFiles: 2 });
    expect(graph.analyzedFiles).toBe(2);
  });

  test('dependentsOf walks breadth-first, bounded by depth', async () => {
    const graph = await buildGraph(memorySnapshot(repo));
    expect(dependentsOf(graph, 'src/core.ts', { depth: 1, maxFiles: 10 })).toEqual(['src/a.ts']);
    expect(dependentsOf(graph, 'src/core.ts', { depth: 2, maxFiles: 10 }).sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
    ]);
  });

  test('dependentsOf stops at maxFiles and survives cycles', () => {
    const graph: ImportGraph = {
      analyses: new Map(),
      dependents: new Map([
        ['x.ts', ['y.ts']],
        ['y.ts', ['x.ts', 'z.ts']],
        ['z.ts', ['x.ts']],
      ]),
      unresolvedImports: 0,
      analyzedFiles: 0,
      analyzerNames: [],
    };
    expect(dependentsOf(graph, 'x.ts', { depth: 10, maxFiles: 10 })).toEqual(['y.ts', 'z.ts']);
    expect(dependentsOf(graph, 'x.ts', { depth: 10, maxFiles: 1 })).toEqual(['y.ts']);
    expect(dependentsOf(graph, './x.ts', { depth: 0, maxFiles: 10 })).toEqual([]);
  });
});

function changed(path: string, headContent: string | null, diff: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    status: 'modified',
    hunks: parseHunks(diff),
    headContent,
    contentHash: '',
    language: 'typescript',
    additions: 1,
    deletions: 0,
    ...overrides,
  };
}

function changeSetOf(files: ChangedFile[]): ChangeSet {
  return {
    platform: 'local',
    projectId: 'p',
    requestId: 'r',
    title: 't',
    description: '',
    baseSha: 'a'.repeat(40),
    startSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    targetBranch: 'main',
    files,
    skipped: [],
  };
}

describe('selectContext', () => {
  const coreHead = ['export function charge(amount: number) {', '  return amount * 2;', '}', 'export const other = 1;'].join('\n');
  const coreFile = () => changed('src/core.ts', coreHead, ['@@ -1,3 +1,3 @@', ' export function charge(amount: number) {', '-  return amount;', '+  return amount * 2;', ' }'].join('\n'));
  const repo = {
    'src/core.ts': coreHead,
    'src/caller.ts': [
      "import { charge, other } from './core';",
      '',
      'export function pay() {',
      '  return charge(10);',
      '}',
      'const unrelated = other;',
    ].join('\n'),
  };

  test('full mode: diff, numbered head file, rules, and ripple call sites of touched symbols only', async () => {
    const snapshot = memorySnapshot(repo);
    const graph = await buildGraph(snapshot);
    const rules: Rule[] = [
      { id: 'core', globs: ['src/core.ts'], global: false, severity: 'high', priority: 0, body: 'b', sourcePath: 'x', bytes: 1 },
      { id: 'elsewhere', globs: ['lib/**'], global: false, severity: 'high', priority: 0, body: 'b', sourcePath: 'y', bytes: 1 },
    ];
    const report = await selectContext(changeSetOf([coreFile()]), rules, snapshot, graph);
    const ctx = report.contexts[0]!;
    expect(ctx.numberedDiff).toContain('+ 2 | ' + '  return amount * 2;');
    expect(ctx.numberedHeadContent).toContain('1 | export function charge');
    expect(ctx.symbolOutline).toBeNull();
    expect(ctx.rules.map((rule) => rule.id)).toEqual(['core']);
    expect(ctx.ripple).toHaveLength(1);
    expect(ctx.ripple[0]).toMatchObject({ path: 'src/caller.ts', symbol: 'charge' });
    // The import line is not a call site.
    expect(ctx.ripple[0]!.text).toContain('return charge(10);');
    expect(report.rippleFiles).toBe(1);
    expect(report.rippleSnippets).toBe(1);
  });

  test('an oversized head file is replaced by an outline, with a recorded reason', async () => {
    const report = await selectContext(changeSetOf([coreFile()]), [], memorySnapshot(repo), null, {
      ...DEFAULT_SELECT_OPTIONS,
      headFileMaxBytes: 10,
    });
    const ctx = report.contexts[0]!;
    expect(ctx.numberedHeadContent).toBeNull();
    expect(ctx.symbolOutline).toContain('function charge');
    expect(report.outlined[0]!.path).toBe('src/core.ts');
    expect(report.outlined[0]!.reason).toMatch(/head file is \d+ bytes/);
  });

  test('diff mode keeps the head file but does no ripple search', async () => {
    const snapshot = memorySnapshot(repo);
    const graph = await buildGraph(snapshot);
    const report = await selectContext(changeSetOf([coreFile()]), [], snapshot, graph, {
      ...DEFAULT_SELECT_OPTIONS,
      mode: 'diff',
    });
    expect(report.contexts[0]!.numberedHeadContent).not.toBeNull();
    expect(report.contexts[0]!.ripple).toEqual([]);
  });

  test('off mode sends the diff only', async () => {
    const report = await selectContext(changeSetOf([coreFile()]), [], memorySnapshot(repo), null, {
      ...DEFAULT_SELECT_OPTIONS,
      mode: 'off',
    });
    expect(report.contexts[0]!.numberedHeadContent).toBeNull();
    expect(report.contexts[0]!.symbolOutline).toBeNull();
  });

  test('a change that touches no exported symbol produces no ripple', async () => {
    const snapshot = memorySnapshot(repo);
    const graph = await buildGraph(snapshot);
    const file = changed('src/core.ts', coreHead + '\n// trailing', ['@@ -4,1 +4,2 @@', ' export const other = 1;', '+// trailing'].join('\n'));
    const report = await selectContext(changeSetOf([file]), [], snapshot, graph);
    expect(report.contexts[0]!.ripple).toEqual([]);
  });

  test('rippleSnippetsPerFile caps call sites per importer', async () => {
    const snapshot = memorySnapshot({
      'src/core.ts': coreHead,
      'src/many.ts': ["import { charge } from './core';", ...Array.from({ length: 30 }, (_, i) => `charge(${i});`)].join('\n'),
    });
    const graph = await buildGraph(snapshot);
    const report = await selectContext(changeSetOf([coreFile()]), [], snapshot, graph, {
      ...DEFAULT_SELECT_OPTIONS,
      rippleSnippetsPerFile: 2,
      rippleSnippetLines: 2,
    });
    expect(report.contexts[0]!.ripple).toHaveLength(2);
  });

  // BUG (src/context/select.ts:144): after emitting a window that ends at
  // 1-based line `end`, the loop sets `index = end` and then the for-loop's
  // `index += 1` advances to 0-based `end + 1`. 0-based `end` (the first line
  // after the window) is never examined, so a call site immediately following a
  // window is silently missed. The fix is `index = end - 1`.
  test.todo('a call site on the line right after a ripple window is still found', async () => {
    const snapshot = memorySnapshot({
      'src/core.ts': coreHead,
      // radius 1: hit on line 2 -> window 1..3; the next use is on line 4.
      'src/adj.ts': ["import { charge } from './core';", 'charge(1);', 'noop();', 'charge(2);'].join('\n'),
    });
    const graph = await buildGraph(snapshot);
    const report = await selectContext(changeSetOf([coreFile()]), [], snapshot, graph, {
      ...DEFAULT_SELECT_OPTIONS,
      rippleSnippetLines: 2,
    });
    expect(report.contexts[0]!.ripple.map((s) => s.startLine)).toEqual([1, 3]);
  });
});

describe('repo snapshot', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'aidr-ctx-'));
    dirs.push(dir);
    return dir;
  }

  test('emptySnapshot is degraded and reads nothing', async () => {
    const snapshot = emptySnapshot('why');
    expect(snapshot.root).toBeNull();
    expect(snapshot.degraded).toBe('why');
    expect(await snapshot.read('x')).toBeNull();
  });

  test('a missing archive yields a degraded empty snapshot, not an error', async () => {
    const cache = await tempDir();
    const platform = makeFakePlatform({ changeSet: changeSetOf([]) });
    const snapshot = await loadRepoSnapshot(platform, 'c'.repeat(40), cache);
    expect(snapshot.root).toBeNull();
    expect(snapshot.degraded).toContain('archive unavailable');
  });

  test('walks the extracted archive, skipping ignored and hidden dirs but keeping .review', async () => {
    const cache = await tempDir();
    const sha = 'd'.repeat(40);
    let fetches = 0;
    const platform = makeFakePlatform({ changeSet: changeSetOf([]) });
    platform.fetchRepoArchive = async (_sha, dest) => {
      fetches += 1;
      await mkdir(join(dest, 'src'), { recursive: true });
      await mkdir(join(dest, 'node_modules/pkg'), { recursive: true });
      await mkdir(join(dest, '.git'), { recursive: true });
      await mkdir(join(dest, '.review'), { recursive: true });
      await writeFile(join(dest, 'src/a.ts'), 'export const a = 1;');
      await writeFile(join(dest, 'node_modules/pkg/index.js'), 'x');
      await writeFile(join(dest, '.git/HEAD'), 'ref');
      await writeFile(join(dest, '.review/rule.md'), 'rule');
      await writeFile(join(dest, 'big.txt'), 'x'.repeat(1_000_001));
      return dest;
    };

    const snapshot = await loadRepoSnapshot(platform, sha, cache);
    expect(snapshot.degraded).toBeNull();
    expect(snapshot.files.sort()).toEqual(['.review/rule.md', 'big.txt', 'src/a.ts']);
    expect(await snapshot.read('src/a.ts')).toBe('export const a = 1;');
    expect(await snapshot.read('missing.ts')).toBeNull();
    expect(await snapshot.read('src')).toBeNull(); // a directory is not a file
    expect(await snapshot.read('big.txt')).toBeNull(); // over the 1 MB read cap

    // Second load for the same SHA is a cache hit: no archive fetch.
    const again = await loadRepoSnapshot(platform, sha, cache);
    expect(fetches).toBe(1);
    expect(again.files.length).toBe(snapshot.files.length);
  });
});
