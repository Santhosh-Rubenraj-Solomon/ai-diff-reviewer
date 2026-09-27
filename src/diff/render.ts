/**
 * The view the model sees.
 *
 * Every number in the left column is a head-side line number, so a finding can
 * only ever cite a line it can actually read. Removed lines are shown with a
 * `-` and no number — there is nothing on the head side to point at.
 */

import type { ChangedFile, Hunk } from '../types.ts';

function pad(value: string, width: number): string {
  return value.padStart(width, ' ');
}

function widthFor(hunks: Hunk[]): number {
  let max = 1;
  for (const hunk of hunks) {
    max = Math.max(max, hunk.newStart + hunk.newLines);
  }
  return String(max).length;
}

export function renderNumberedDiff(file: ChangedFile, headSha: string): string {
  const shortSha = headSha.slice(0, 7);
  const header =
    file.status === 'renamed' && file.oldPath
      ? `--- ${file.path} (renamed from ${file.oldPath}, head ${shortSha}) ---`
      : `--- ${file.path} (${file.status}, head ${shortSha}) ---`;

  const width = widthFor(file.hunks);
  const out: string[] = [header];

  file.hunks.forEach((hunk, index) => {
    if (index > 0) out.push(`${' '.repeat(width + 2)}...`);
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        out.push(`+ ${pad(String(line.newLine), width)} | ${line.text}`);
      } else if (line.kind === 'del') {
        out.push(`- ${' '.repeat(width)} | ${line.text}`);
      } else {
        out.push(`  ${pad(String(line.newLine), width)} | ${line.text}`);
      }
    }
  });

  return out.join('\n');
}

export function renderNumberedContent(content: string, startLine = 1): string {
  const lines = content.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((text, index) => `${pad(String(startLine + index), width)} | ${text}`)
    .join('\n');
}

/** A cheap stand-in for a full file body when the token budget will not fit it. */
export function renderSymbolOutline(symbols: { name: string; kind: string; line: number }[]): string {
  if (symbols.length === 0) return '(no exported symbols detected)';
  return symbols
    .slice(0, 200)
    .map((symbol) => `${String(symbol.line).padStart(5, ' ')} | ${symbol.kind} ${symbol.name}`)
    .join('\n');
}

/** Extracts the text of one head-side line, for the judge's context window. */
export function lineSlice(content: string, line: number, radius: number): string {
  const lines = content.split('\n');
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return renderNumberedContent(lines.slice(start - 1, end).join('\n'), start);
}
