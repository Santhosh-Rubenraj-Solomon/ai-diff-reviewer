/**
 * The adversarial pass: the precision mechanism.
 *
 * Published benchmarks put the leading AI reviewers around half precision —
 * roughly one comment in two is wrong. Self-reported confidence scores do not
 * fix that; they cluster tightly and barely discriminate. So instead of asking
 * the model how sure it is, this pass hands each finding back and asks it to
 * argue the finding is wrong. A finding that cannot withstand a good-faith
 * attempt to refute it does not reach the user.
 *
 * There is no cap on how many findings survive. The count varies with the
 * quality of the diff, and zero is a valid and meaningful result.
 */

import { config } from './config.ts';
import { generate, parseJson } from './gemini.ts';
import type { Finding, RawFinding, Severity, Warning } from './types.ts';

const SYSTEM = `You are refuting a code review comment. Assume it is wrong and build the case.

Consider, in order:
- Does the claimed behaviour actually follow from the code shown?
- Is the problem already handled elsewhere in the visible diff?
- Does the claim depend on assumptions about code that is not shown? If so it is not defensible.
- Is it a real defect, or a restatement of what the code does, or a style preference in disguise?
- Would a competent author of this change accept it, or reject it as noise?

Then decide honestly. You are not trying to win; you are trying to find out whether the comment
survives contact with a skeptic. Refute it if the case against it is stronger. Concede it if the
comment is right. Unsupportable claims and claims that need unseen code must be refuted.

Return "refuted": true when the comment should NOT be shown to the author.`;

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: {
      type: 'boolean',
      description: 'True if the comment does not survive the counter-argument.',
    },
    reason: {
      type: 'string',
      description: 'One or two sentences. The strongest point either way.',
    },
  },
  required: ['refuted', 'reason'],
} as const;

interface VerdictResponse {
  refuted?: boolean;
  reason?: string;
}

/** Highest severity first, so a ceiling never spends its budget on nits. */
const SEVERITY_ORDER: Record<Severity, number> = { bug: 0, risk: 1, nit: 2 };

function buildPrompt(finding: RawFinding, context: string): string {
  return [
    `File: ${finding.file}`,
    finding.line === null ? 'Line: file-level' : `Line: ${finding.line}`,
    '',
    'The diff under review:',
    '```diff',
    context,
    '```',
    '',
    'The review comment to refute:',
    `Severity: ${finding.severity}`,
    `Title: ${finding.title}`,
    `Body: ${finding.body}`,
    `Evidence cited: ${finding.evidence || '(none given)'}`,
    finding.historyBasis ? `Git-history basis claimed: ${finding.historyBasis}` : '',
    '',
    'Argue this comment is incorrect, then give your honest verdict.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Verify one finding. Errors are conservative: an unjudged finding survives, flagged. */
async function verifyOne(
  finding: RawFinding,
  context: string,
): Promise<{ finding: Finding; warning?: Warning }> {
  try {
    const text = await generate({
      model: config.verifyModel,
      system: SYSTEM,
      prompt: buildPrompt(finding, context),
      schema: VERDICT_SCHEMA,
      temperature: 0,
    });
    const verdict = parseJson<VerdictResponse>(text);
    const refuted = verdict.refuted === true;

    return {
      finding: {
        ...finding,
        verdict: refuted ? 'discarded' : 'survived',
        verdictReason: verdict.reason?.trim() || (refuted ? 'Refuted.' : 'Survived refutation.'),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      finding: {
        ...finding,
        verdict: 'unverified',
        verdictReason: `Verification failed: ${message}`,
      },
      warning: { stage: 'verify', path: finding.file, message },
    };
  }
}

export interface VerifyPassResult {
  findings: Finding[];
  warnings: Warning[];
  callsUsed: number;
}

/**
 * Run every candidate finding through refutation, up to the call ceiling.
 *
 * The ceiling exists only so a pathological diff cannot produce an unbounded
 * number of API calls. Findings past it are passed through and clearly flagged
 * as unverified rather than dropped, because dropping them silently would be
 * the same failure mode as a fixed comment cap.
 */
export async function runVerifyPass(
  findings: RawFinding[],
  contextByFile: Map<string, string>,
  concurrency = config.concurrency,
  ceiling = config.maxVerifyCalls,
  onProgress?: (done: number, total: number) => void,
): Promise<VerifyPassResult> {
  const ordered = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity]);

  const results = new Array<Finding>(findings.length);
  const warnings: Warning[] = [];
  const budget = Math.min(ordered.length, ceiling);

  // Everything past the ceiling short-circuits without a call.
  for (const { finding, index } of ordered.slice(budget)) {
    results[index] = {
      ...finding,
      verdict: 'unverified',
      verdictReason: `Verification ceiling of ${ceiling} calls reached; shown unverified.`,
    };
  }
  if (ordered.length > budget) {
    warnings.push({
      stage: 'verify',
      message: `${ordered.length - budget} finding(s) exceeded the verification ceiling of ${ceiling} and are shown unverified.`,
    });
  }

  const queue = ordered.slice(0, budget);
  let next = 0;
  let done = 0;

  const worker = async () => {
    while (true) {
      const slot = next++;
      const entry = queue[slot];
      if (!entry) return;
      const context = contextByFile.get(entry.finding.file) ?? '(diff unavailable)';
      const { finding, warning } = await verifyOne(entry.finding, context);
      results[entry.index] = finding;
      if (warning) warnings.push(warning);
      onProgress?.(++done, queue.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker),
  );

  return { findings: results.filter(Boolean), warnings, callsUsed: queue.length };
}

export { buildPrompt as buildVerifyPrompt, VERDICT_SCHEMA };
