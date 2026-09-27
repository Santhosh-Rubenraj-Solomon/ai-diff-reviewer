import { describe, expect, test } from 'bun:test';
import type { ChangeSet, Finding } from '../src/types.ts';
import { parseHunks } from '../src/diff/parse.ts';
import { sha256, withFingerprint } from '../src/publish/fingerprint.ts';
import { judgeFindings } from '../src/review/judge.ts';
import {
  DEFAULT_JEV_THRESHOLDS,
  JevJudge,
  buildJevQuestions,
  buildJevState,
  decide,
  isJevModel,
  type JevTransport,
} from '../src/review/jev.ts';
import { configureLogger } from '../src/logger.ts';

configureLogger({ quiet: true });

const HEAD = [
  'export async function disable(userId: string) {',
  '  await users.disable(userId);',
  '}',
].join('\n');

function changeSet(): ChangeSet {
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
    files: [
      {
        path: 'src/admin.ts',
        status: 'modified',
        hunks: parseHunks(
          [
            '@@ -1,1 +1,3 @@',
            ' export async function disable(userId: string) {',
            '+  await users.disable(userId);',
            '+}',
          ].join('\n'),
        ),
        headContent: HEAD,
        contentHash: sha256(HEAD),
        language: 'typescript',
        additions: 2,
        deletions: 0,
      },
    ],
    skipped: [],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return withFingerprint({
    path: 'src/admin.ts',
    line: 2,
    severity: 'high',
    category: 'security',
    title: 'Check authorisation before disabling a user',
    body: 'Any caller can disable any account.',
    evidence: '  await users.disable(userId);',
    ruleIds: [],
    confidence: 0.9,
    ...overrides,
  }) as Finding;
}

/** Builds a fake transport returning the four answers, plus a call log. */
function transportFor(
  answers: Record<string, unknown>,
  usage?: { input_tokens: number; output_tokens: number; cost?: number },
): JevTransport & { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  return {
    bodies,
    async post(body) {
      bodies.push(body);
      return {
        id: 'gen-dec-1',
        model: 'jev-1.13-20260917',
        answers: answers as never,
        usage: usage ?? { input_tokens: 900, output_tokens: 70, cost: 0.0000378 },
      };
    },
  };
}

const PASSING = {
  real: { type: 'noul', noul: 0.94 },
  changed: { type: 'noul', noul: 0.88 },
  specific: { type: 'noul', noul: 0.81 },
  action: { type: 'score', score: 1.8, confidence: 0.95 },
};

describe('isJevModel', () => {
  test('recognises the decision models and nothing else', () => {
    expect(isJevModel('jev-1.13')).toBe(true);
    expect(isJevModel('jev-latest')).toBe(true);
    expect(isJevModel('typesafe/jev-1.13')).toBe(true);
    expect(isJevModel('claude-sonnet-5')).toBe(false);
    expect(isJevModel('claude-opus-5')).toBe(false);
  });
});

describe('question and state construction', () => {
  test('asks the four gate conditions with bounded answer spaces', () => {
    const questions = buildJevQuestions() as Record<string, { type: string; criteria: unknown }>;
    expect(Object.keys(questions).sort()).toEqual(['action', 'changed', 'real', 'specific']);
    expect(questions.real!.type).toBe('noul');
    expect(questions.changed!.type).toBe('noul');
    expect(questions.specific!.type).toBe('noul');
    expect(questions.action!.type).toBe('score');
    // A score rubric is an ordered list; noul criteria are true/false.
    expect(Array.isArray(questions.action!.criteria)).toBe(true);
    expect(Object.keys(questions.real!.criteria as object).sort()).toEqual(['false', 'true']);
  });

  test('passes the finding and code as state, not as a rendered prompt', () => {
    const state = buildJevState(
      { finding: finding(), hunkWithContext: '2 | code', ruleBodies: [] },
      2_000,
    ) as { finding: Record<string, unknown>; code_at_head: string };

    expect(state.finding.file).toBe('src/admin.ts');
    expect(state.finding.evidence).toBe('  await users.disable(userId);');
    expect(state.code_at_head).toBe('2 | code');
    // No instruction text in the state at all — the schema is the contract.
    expect(JSON.stringify(state)).not.toContain('Keep the finding only if');
  });

  test('truncates an oversized rule body to stay inside the 32k context', () => {
    const state = buildJevState(
      { finding: finding(), hunkWithContext: '', ruleBodies: ['x'.repeat(5_000)] },
      100,
    ) as { project_rules_cited: string[] };
    expect(state.project_rules_cited[0]!.length).toBeLessThan(200);
    expect(state.project_rules_cited[0]).toContain('[truncated]');
  });
});

describe('decide', () => {
  test('keeps a finding that clears every condition', () => {
    const decision = decide(PASSING as never, DEFAULT_JEV_THRESHOLDS);
    expect(decision!.verdict).toBe('keep');
    // The weakest of the three probabilities, not their average.
    expect(decision!.calibratedConfidence).toBeCloseTo(0.81, 5);
  });

  test('names the failing condition when it drops', () => {
    const decision = decide(
      { ...PASSING, real: { type: 'noul', noul: 0.2 } } as never,
      DEFAULT_JEV_THRESHOLDS,
    );
    expect(decision!.verdict).toBe('drop');
    expect(decision!.reason).toContain('not real in this code');
    expect(decision!.reason).toContain('real=0.20');
  });

  test('drops a pre-existing problem and says which condition failed', () => {
    const decision = decide(
      { ...PASSING, changed: { type: 'noul', noul: 0.1 } } as never,
      DEFAULT_JEV_THRESHOLDS,
    );
    expect(decision!.reason).toContain('pre-existing');
  });

  test('drops a finding below the action bar', () => {
    const decision = decide(
      { ...PASSING, action: { type: 'score', score: 0.3 } } as never,
      DEFAULT_JEV_THRESHOLDS,
    );
    expect(decision!.reason).toContain('below the action bar');
  });

  test('reports every failing condition, not just the first', () => {
    const decision = decide(
      {
        real: { type: 'noul', noul: 0.1 },
        changed: { type: 'noul', noul: 0.1 },
        specific: { type: 'noul', noul: 0.1 },
        action: { type: 'score', score: 0 },
      } as never,
      DEFAULT_JEV_THRESHOLDS,
    );
    expect(decision!.reason.split(';')).toHaveLength(4);
  });

  test('a missing answer is a failed call, not a drop', () => {
    // In-schema output is guaranteed; a missing key is not, and must not be
    // silently read as "this finding is not real".
    expect(decide({ real: { type: 'noul', noul: 0.9 } } as never, DEFAULT_JEV_THRESHOLDS)).toBeNull();
    expect(decide({} as never, DEFAULT_JEV_THRESHOLDS)).toBeNull();
  });

  test('a wrongly-typed answer is also a failed call', () => {
    expect(
      decide({ ...PASSING, real: { type: 'choice', choice: 'yes' } } as never, DEFAULT_JEV_THRESHOLDS),
    ).toBeNull();
  });
});

describe('JevJudge', () => {
  const options = { model: 'jev-1.13', apiKey: 'k', endpoint: 'https://example.test/v1/systemone' };

  test('returns a keep verdict with a calibrated confidence', async () => {
    const transport = transportFor(PASSING);
    const judge = new JevJudge(options, transport);

    const verdict = await judge.judge({
      finding: finding(),
      hunkWithContext: 'code',
      ruleBodies: [],
    });

    expect(verdict).toMatchObject({ verdict: 'keep' });
    expect(verdict!.calibratedConfidence).toBeCloseTo(0.81, 5);
    expect(transport.bodies[0]).toMatchObject({ model: 'jev-1.13' });
  });

  test('bills from the cost the API reports', async () => {
    const judge = new JevJudge(
      options,
      transportFor(PASSING, { input_tokens: 900, output_tokens: 70, cost: 0.0000378 }),
    );
    await judge.judge({ finding: finding(), hunkWithContext: 'code', ruleBodies: [] });
    expect(judge.usage.costUsd).toBeCloseTo(0.0000378, 9);
    expect(judge.usage.outputTokens).toBe(70);
  });

  test('falls back to the price table when no cost is reported', async () => {
    const judge = new JevJudge(
      options,
      transportFor(PASSING, { input_tokens: 1_000_000, output_tokens: 0 }),
    );
    await judge.judge({ finding: finding(), hunkWithContext: 'code', ruleBodies: [] });
    // $0.042 per 1M input tokens, output unmetered.
    expect(judge.usage.costUsd).toBeCloseTo(0.042, 6);
  });

  test('a transport failure returns null rather than a verdict', async () => {
    const judge = new JevJudge(options, {
      async post() {
        throw new Error('503 service unavailable');
      },
    });
    expect(
      await judge.judge({ finding: finding(), hunkWithContext: 'code', ruleBodies: [] }),
    ).toBeNull();
  });
});

describe('the error policy still holds with a decision backend', () => {
  const failing: JevTransport = {
    async post() {
      throw new Error('429 rate limited');
    },
  };

  test('a high-severity finding fails open and marks the run partial', async () => {
    const judge = new JevJudge({ model: 'jev-1.13', apiKey: 'k', endpoint: 'x' }, failing);
    const result = await judgeFindings([finding({ severity: 'high' })], changeSet(), [], judge, 1);

    expect(result.kept).toHaveLength(1);
    expect(result.failedOpen).toBe(true);
    expect(result.errors).toBe(1);
  });

  test('a low-severity finding fails closed', async () => {
    const judge = new JevJudge({ model: 'jev-1.13', apiKey: 'k', endpoint: 'x' }, failing);
    const result = await judgeFindings(
      [finding({ severity: 'low', category: 'style' })],
      changeSet(),
      [],
      judge,
      1,
    );

    expect(result.kept).toHaveLength(0);
    expect(result.dropped[0]!.dropReason).toContain('failed closed');
    expect(result.failedOpen).toBe(false);
  });

  test('a calibrated confidence reaches the finding that gets posted', async () => {
    const judge = new JevJudge(
      { model: 'jev-1.13', apiKey: 'k', endpoint: 'x' },
      transportFor(PASSING),
    );
    const result = await judgeFindings([finding()], changeSet(), [], judge, 1);
    expect(result.kept[0]!.calibratedConfidence).toBeCloseTo(0.81, 5);
    // The model's own self-report is kept alongside it, not overwritten.
    expect(result.kept[0]!.confidence).toBeCloseTo(0.9, 5);
  });
});
