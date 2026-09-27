/**
 * Golden-set case format and loading.
 *
 * A case is a frozen fixture: diff text, head content, and labels. Nothing in
 * the eval path touches a platform API or a live merge request.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ChangeSet, ChangedFile } from '../src/types.ts';
import { countChanges, parseHunks } from '../src/diff/parse.ts';
import { languageOf } from '../src/diff/filter.ts';
import { sha256 } from '../src/publish/fingerprint.ts';

export const ExpectedSchema = z.object({
  path: z.string(),
  line: z.number().int(),
  /** What a human said, or would have said, about this line. */
  description: z.string(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  /** Set on synthetic cases so recall on injected bugs can be reported apart. */
  injected: z.boolean().optional(),
});

export const ForbiddenSchema = z.object({
  /** Case-insensitive substring or /regex/ that marks a finding as noise. */
  match: z.string(),
  why: z.string(),
  path: z.string().optional(),
});

export const CaseFileSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']).default('modified'),
  oldPath: z.string().optional(),
  diff: z.string(),
  headContent: z.string().nullable(),
});

export const EvalCaseSchema = z.object({
  id: z.string(),
  split: z.enum(['train', 'holdout']),
  source: z.string().optional(),
  title: z.string(),
  description: z.string().default(''),
  targetBranch: z.string().default('main'),
  headSha: z.string().default('0'.repeat(40)),
  files: z.array(CaseFileSchema).min(1),
  expected: z.array(ExpectedSchema).default([]),
  forbidden: z.array(ForbiddenSchema).default([]),
  /** Findings a stub reviewer returns, so the harness can be tested offline. */
  stubFindings: z
    .array(
      z.object({
        path: z.string(),
        line: z.number().int(),
        severity: z.enum(['critical', 'high', 'medium', 'low']),
        category: z.enum(['bug', 'security', 'performance', 'maintainability', 'test', 'style']),
        title: z.string(),
        body: z.string(),
        evidence: z.string(),
        ruleIds: z.array(z.string()).default([]),
        confidence: z.number(),
      }),
    )
    .default([]),
});

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;
export type Forbidden = z.infer<typeof ForbiddenSchema>;

export async function loadCases(dir: string): Promise<EvalCase[]> {
  const entries = await readdir(dir).catch(() => []);
  const cases: EvalCase[] = [];

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.json')) continue;
    const text = await readFile(join(dir, entry), 'utf8');
    const parsed = EvalCaseSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new Error(
        `${entry} is not a valid eval case: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
      );
    }
    cases.push(parsed.data);
  }

  return cases;
}

/** A fixture becomes exactly the ChangeSet the real pipeline would receive. */
export function toChangeSet(evalCase: EvalCase): ChangeSet {
  const files: ChangedFile[] = evalCase.files.map((file) => {
    const hunks = parseHunks(file.diff);
    const { additions, deletions } = countChanges(hunks);
    const changed: ChangedFile = {
      path: file.path,
      status: file.status,
      hunks,
      headContent: file.headContent,
      contentHash: sha256(file.headContent ?? ''),
      language: languageOf(file.path),
      additions,
      deletions,
    };
    if (file.oldPath) changed.oldPath = file.oldPath;
    return changed;
  });

  return {
    platform: 'local',
    projectId: 'evals',
    requestId: evalCase.id,
    title: evalCase.title,
    description: evalCase.description,
    baseSha: '1'.repeat(40),
    startSha: '1'.repeat(40),
    headSha: evalCase.headSha,
    targetBranch: evalCase.targetBranch,
    files,
    skipped: [],
  };
}
