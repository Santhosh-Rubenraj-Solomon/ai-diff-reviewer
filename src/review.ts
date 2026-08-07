/**
 * The reading pass: one Gemini call per chunk, diff plus git history in,
 * candidate findings out.
 *
 * This pass sets the recall ceiling for the whole tool — verification can
 * remove findings but never add them — so the prompt asks for anything
 * defensible and leaves the pruning to `verify.ts`.
 */

import { config } from './config.ts';
import { generate, parseJson } from './gemini.ts';
import { formatHistoryForPrompt } from './history.ts';
import type { EnrichedChunk, RawFinding, Severity, Warning } from './types.ts';

const SYSTEM = `You are a senior engineer reviewing a git diff. You report defects, not impressions.

Rules:
- Only report problems you can point at in the diff. No speculation about code you cannot see.
- Reporting nothing is a correct and common outcome. Do not invent findings to appear useful.
- No style, formatting or naming opinions unless they cause a concrete defect.
- Do not restate what the diff does. Every finding must describe something that is wrong.
- Judge the post-change state, not the author's intent.

Severity:
- "bug"  - this is incorrect and will misbehave: wrong logic, crash, data loss, security hole, broken contract.
- "risk" - correct today but fragile: unhandled edge case, race, resource leak, silent failure path.
- "nit"  - minor and real, worth a sentence but not worth blocking on.

You are given the file's git history alongside the diff. Use it as evidence, not decoration:
a line that has been fixed repeatedly, reverted before, or changed days ago by a commit whose
subject mentions a bug is a genuine signal that this change may be repeating a known mistake.
When history informed a finding, put that reasoning in "historyBasis" and cite the commit
subject. When it did not, omit the field. Never fabricate a history link.`;

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: {
            type: 'integer',
            nullable: true,
            description: 'Line number in the post-change file, or null if file-level.',
          },
          severity: { type: 'string', enum: ['bug', 'risk', 'nit'] },
          title: { type: 'string', description: 'One line, under 80 characters.' },
          body: { type: 'string', description: 'Why it is wrong and what happens as a result.' },
          evidence: {
            type: 'string',
            description: 'The exact line or lines from the diff the finding is about.',
          },
          historyBasis: {
            type: 'string',
            nullable: true,
            description: 'How git history supports this finding. Omit if it did not.',
          },
        },
        required: ['severity', 'title', 'body', 'evidence'],
      },
    },
  },
  required: ['findings'],
} as const;

interface ReviewResponse {
  findings?: Array<Partial<RawFinding> & { severity?: string }>;
}

export interface ReviewPassResult {
  findings: RawFinding[];
  warnings: Warning[];
}

function buildPrompt(item: EnrichedChunk): string {
  const { chunk } = item;
  const partNote =
    chunk.partsTotal > 1
      ? `\nThis is part ${chunk.part} of ${chunk.partsTotal} of this file's diff. Judge only what is shown.`
      : '';

  return [
    `File: ${chunk.path}${partNote}`,
    '',
    formatHistoryForPrompt(item.history),
    '',
    'Diff:',
    '```diff',
    chunk.patch,
    '```',
    '',
    'Return findings for this diff. Return an empty array if there is nothing wrong with it.',
  ].join('\n');
}

/** Review one chunk, retrying once when the model returns unparseable JSON. */
async function reviewChunk(item: EnrichedChunk): Promise<ReviewPassResult> {
  const prompt = buildPrompt(item);
  const warnings: Warning[] = [];
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await generate({
        model: config.reviewModel,
        system: SYSTEM,
        prompt:
          attempt === 0
            ? prompt
            : `${prompt}\n\nYour previous response was not valid JSON. Return only JSON matching the schema.`,
        schema: FINDINGS_SCHEMA,
      });
      const parsed = parseJson<ReviewResponse>(text);
      return { findings: normalize(parsed, item), warnings };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // A parse failure is worth one more shot; anything else already had its
      // retries inside the Gemini client.
      if (!(err instanceof SyntaxError)) break;
    }
  }

  warnings.push({
    stage: 'review',
    path: item.chunk.path,
    message: `skipped — ${lastError}`,
  });
  return { findings: [], warnings };
}

function normalize(parsed: ReviewResponse, item: EnrichedChunk): RawFinding[] {
  const severities: Severity[] = ['bug', 'risk', 'nit'];

  return (parsed.findings ?? [])
    .filter((raw) => raw && typeof raw.title === 'string' && typeof raw.body === 'string')
    .map((raw) => {
      const severity = severities.includes(raw.severity as Severity)
        ? (raw.severity as Severity)
        : 'risk';
      const finding: RawFinding = {
        file: item.chunk.path,
        line: typeof raw.line === 'number' && Number.isFinite(raw.line) ? raw.line : null,
        severity,
        title: raw.title!.trim(),
        body: raw.body!.trim(),
        evidence: (raw.evidence ?? '').trim(),
      };
      // Only attach a history basis when there was history to base it on.
      const basis = raw.historyBasis?.trim();
      if (basis && item.history.available) finding.historyBasis = basis;
      return finding;
    });
}

/**
 * Run the reading pass over every chunk with bounded concurrency.
 *
 * Order is preserved so the renderer's output is stable across runs.
 */
export async function runReviewPass(
  items: EnrichedChunk[],
  concurrency = config.concurrency,
  onProgress?: (done: number, total: number) => void,
): Promise<ReviewPassResult> {
  const results = new Array<ReviewPassResult>(items.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const index = next++;
      const item = items[index];
      if (!item) return;
      results[index] = await reviewChunk(item);
      onProgress?.(++done, items.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );

  return {
    findings: results.flatMap((result) => result?.findings ?? []),
    warnings: results.flatMap((result) => result?.warnings ?? []),
  };
}

export { buildPrompt as buildReviewPrompt, FINDINGS_SCHEMA };
