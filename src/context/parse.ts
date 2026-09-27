/**
 * Imports, exports and symbol ranges.
 *
 * The analyzer is an interface on purpose. The shipped implementation is a
 * lexical one (regex + brace balancing) rather than a full parse: it is honest
 * about what it is, it has no native build step, and it cannot silently return
 * nothing because a grammar failed to load. Every run records which analyzer
 * ran, so a degraded context engine is never mistaken for a working one.
 *
 * To swap in tree-sitter later, implement `Analyzer` and register it in
 * `pickAnalyzer` — nothing else in the pipeline needs to change.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'const'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 're-export';

export interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface ImportInfo {
  /** The module specifier exactly as written. */
  source: string;
  line: number;
}

export interface FileAnalysis {
  imports: ImportInfo[];
  exports: SymbolInfo[];
  analyzer: string;
}

export interface Analyzer {
  readonly name: string;
  supports(language: string | null): boolean;
  analyze(content: string): { imports: ImportInfo[]; exports: SymbolInfo[] };
}

const JS_LANGUAGES = new Set(['typescript', 'javascript', 'vue', 'svelte']);

const IMPORT_PATTERNS: RegExp[] = [
  /^\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/,
  /^\s*import\s*['"]([^'"]+)['"]/,
  /^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/,
];

const EXPORT_PATTERNS: { re: RegExp; kind: SymbolKind }[] = [
  { re: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
  { re: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  { re: /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
  { re: /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/, kind: 'type' },
  { re: /^\s*export\s+(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
  { re: /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
];

const NAMED_EXPORT_LIST = /^\s*export\s*\{([^}]*)\}/;

/** Walks forward from `start` balancing braces; falls back to the same line. */
function blockEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i += 1) {
    const line = stripStringsAndComments(lines[i]!);
    for (const char of line) {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') {
        depth -= 1;
        if (opened && depth <= 0) return i + 1;
      }
    }
    if (!opened && /;\s*$/.test(line)) return i + 1;
    // Give up after a reasonable window rather than swallowing the whole file.
    if (i - start > 400) return i + 1;
  }
  return Math.min(lines.length, start + 1);
}

/** Crude but enough to stop braces inside strings and comments from counting. */
function stripStringsAndComments(line: string): string {
  return line
    .replace(/\\./g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
}

export const jsAnalyzer: Analyzer = {
  name: 'lexical-js',
  supports: (language) => language !== null && JS_LANGUAGES.has(language),
  analyze(content) {
    const lines = content.split('\n');
    const imports: ImportInfo[] = [];
    const exports: SymbolInfo[] = [];

    lines.forEach((line, index) => {
      for (const pattern of IMPORT_PATTERNS) {
        const match = pattern.exec(line);
        if (match?.[1]) {
          imports.push({ source: match[1], line: index + 1 });
          break;
        }
      }

      for (const { re, kind } of EXPORT_PATTERNS) {
        const match = re.exec(line);
        if (match?.[1]) {
          exports.push({
            name: match[1],
            kind,
            startLine: index + 1,
            endLine: blockEnd(lines, index),
          });
          return;
        }
      }

      const named = NAMED_EXPORT_LIST.exec(line);
      if (named?.[1]) {
        for (const raw of named[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
          if (name && /^[A-Za-z_$][\w$]*$/.test(name)) {
            exports.push({ name, kind: 're-export', startLine: index + 1, endLine: index + 1 });
          }
        }
      }
    });

    return { imports, exports };
  },
};

export const pythonAnalyzer: Analyzer = {
  name: 'lexical-python',
  supports: (language) => language === 'python',
  analyze(content) {
    const lines = content.split('\n');
    const imports: ImportInfo[] = [];
    const exports: SymbolInfo[] = [];

    lines.forEach((line, index) => {
      const from = /^\s*from\s+([\w.]+)\s+import\s+/.exec(line);
      if (from?.[1]) imports.push({ source: from[1], line: index + 1 });
      const plain = /^\s*import\s+([\w.]+)/.exec(line);
      if (plain?.[1]) imports.push({ source: plain[1], line: index + 1 });

      const def = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
      if (def?.[2] && def[1] === '') {
        exports.push({
          name: def[2],
          kind: 'function',
          startLine: index + 1,
          endLine: pythonBlockEnd(lines, index),
        });
      }
      const cls = /^class\s+([A-Za-z_]\w*)/.exec(line);
      if (cls?.[1]) {
        exports.push({
          name: cls[1],
          kind: 'class',
          startLine: index + 1,
          endLine: pythonBlockEnd(lines, index),
        });
      }
    });

    return { imports, exports };
  },
};

function pythonBlockEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) return i;
  }
  return lines.length;
}

const ANALYZERS: Analyzer[] = [jsAnalyzer, pythonAnalyzer];

export function pickAnalyzer(language: string | null): Analyzer | null {
  return ANALYZERS.find((analyzer) => analyzer.supports(language)) ?? null;
}

export function analyze(language: string | null, content: string): FileAnalysis {
  const analyzer = pickAnalyzer(language);
  if (!analyzer) return { imports: [], exports: [], analyzer: 'none' };
  const { imports, exports } = analyzer.analyze(content);
  return { imports, exports, analyzer: analyzer.name };
}

/** Exported symbols whose line range overlaps a line the change touched. */
export function touchedSymbols(exports: SymbolInfo[], changedLines: Set<number>): SymbolInfo[] {
  if (changedLines.size === 0) return [];
  return exports.filter((symbol) => {
    for (let line = symbol.startLine; line <= symbol.endLine; line += 1) {
      if (changedLines.has(line)) return true;
    }
    return false;
  });
}
