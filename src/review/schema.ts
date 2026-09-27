/**
 * The output contract.
 *
 * Structured outputs, not "return only JSON". There is no JSON repair path in
 * this codebase: a response that does not satisfy the schema is a failed call,
 * and a failed call is never reported as "no findings".
 *
 * Note on constraints: JSON-schema length and numeric bounds are not supported
 * by structured outputs (the SDK strips them and validates client-side, which
 * turns a chatty title into a hard parse failure). Bounds are therefore stated
 * in the prompt and enforced in code — see `clampFinding`.
 */

import { z } from 'zod';
import type { Category, Severity } from '../types.ts';

export const SEVERITY_VALUES = ['critical', 'high', 'medium', 'low'] as const;
export const CATEGORY_VALUES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
] as const;

export const ModelFindingSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  endLine: z.number().int().nullable().optional(),
  severity: z.enum(SEVERITY_VALUES),
  category: z.enum(CATEGORY_VALUES),
  title: z.string(),
  body: z.string(),
  evidence: z.string(),
  suggestion: z.string().nullable().optional(),
  ruleIds: z.array(z.string()),
  confidence: z.number(),
});

export const ReviewSchema = z.object({
  findings: z.array(ModelFindingSchema),
  notes: z.string().nullable().optional(),
});

export const VerdictSchema = z.object({
  verdict: z.enum(['keep', 'drop']),
  reason: z.string(),
});

export type ModelFinding = z.infer<typeof ModelFindingSchema>;
export type ModelReview = z.infer<typeof ReviewSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;

const TITLE_MAX = 120;

/** Normalises what the model returned into the shape the rest of the code trusts. */
export function clampFinding(finding: ModelFinding): {
  path: string;
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  title: string;
  body: string;
  evidence: string;
  suggestion?: string;
  ruleIds: string[];
  confidence: number;
} {
  const title = finding.title.trim().replace(/\s+/g, ' ');
  const out: ReturnType<typeof clampFinding> = {
    path: finding.path.replace(/^\.\//, ''),
    line: Math.max(1, Math.trunc(finding.line)),
    // One enum, case-normalised on ingest, everywhere.
    severity: finding.severity.toLowerCase() as Severity,
    category: finding.category.toLowerCase() as Category,
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title,
    body: finding.body.trim(),
    evidence: finding.evidence,
    ruleIds: [...new Set(finding.ruleIds.map((id) => id.trim()).filter(Boolean))],
    confidence: Math.min(1, Math.max(0, finding.confidence)),
  };
  if (finding.endLine != null) out.endLine = Math.max(out.line, Math.trunc(finding.endLine));
  if (finding.suggestion) out.suggestion = finding.suggestion;
  return out;
}
