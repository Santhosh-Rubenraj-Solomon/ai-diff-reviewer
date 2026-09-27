import { describe, expect, test } from 'bun:test';
import type { ChangeSet, Finding } from '../src/types.ts';
import { loadConfig } from '../src/config.ts';
import { parseHunks } from '../src/diff/parse.ts';
import { sha256 } from '../src/publish/fingerprint.ts';
import { withFingerprint } from '../src/publish/fingerprint.ts';
import { runReview } from '../src/pipeline.ts';
import { Store } from '../src/store/db.ts';
import { exitCodeFor } from '../src/cli.ts';
import { configureLogger } from '../src/logger.ts';
import { JevJudge } from '../src/review/jev.ts';
import { makeFakePlatform, makeFakeReviewer } from './helpers.ts';

configureLogger({ quiet: true });

const HEAD = [
  'export function disable(userId: string) {',
  '  return users.disable(userId);',
  '}',
].join('\n');

function changeSet(): ChangeSet {
  return {
    platform: 'local',
    projectId: 'proj',
    requestId: '42',
    title: 'Add disable',
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
            ' export function disable(userId: string) {',
            '+  return users.disable(userId);',
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

function goodFinding(): Finding {
  return withFingerprint({
    path: 'src/admin.ts',
    line: 2,
    severity: 'critical',
    category: 'security',
    title: 'Check authorisation before disabling a user',
    body: 'Any caller reaching this function can disable any account.',
    evidence: '  return users.disable(userId);',
    ruleIds: [],
    confidence: 0.95,
  });
}

function config(overrides: Record<string, unknown> = {}) {
  return loadConfig(
    { REVIEWER_PLATFORM: 'local' },
    { platform: 'local', dryRun: false, judge: 'off', context: 'off', ...overrides },
  );
}

describe('runReview', () => {
  test('posts a verified finding and reports a completed run', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const store = new Store(':memory:');
    const reviewer = makeFakeReviewer({ findings: [goodFinding()] });

    const result = await runReview(config(), {
      repoRoot: '.',
      platform,
      store,
      runner: reviewer,
    });

    expect(result.status).toBe('completed');
    expect(result.findingsPosted).toHaveLength(1);
    expect(platform.inline).toHaveLength(1);
    expect(platform.inline[0]!.body).toContain('Check authorisation');
    expect(exitCodeFor(result, config())).toBe(0);
  });

  test('a second run on the same head posts nothing new', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const store = new Store(':memory:');
    const reviewer = makeFakeReviewer({ findings: [goodFinding()] });
    const options = { repoRoot: '.', platform, store, runner: reviewer };

    await runReview(config(), options);
    const second = await runReview(config(), options);

    expect(platform.inline).toHaveLength(1);
    // Still reported as an open finding, just not posted twice.
    expect(second.findingsPosted).toHaveLength(1);
    // The per-file cache means the model was not asked again either.
    expect(reviewer.calls).toBe(1);
  });

  test('the summary comment is edited in place, never duplicated', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const store = new Store(':memory:');
    const reviewer = makeFakeReviewer({ findings: [goodFinding()] });
    const options = { repoRoot: '.', platform, store, runner: reviewer };

    await runReview(config(), options);
    await runReview(config(), options);

    const summaries = platform.notes.filter((note) => note.body.includes('<!-- aidr:summary -->'));
    expect(summaries).toHaveLength(1);
    expect(platform.updates.length).toBeGreaterThanOrEqual(1);
  });

  test('a finding with invented evidence is dropped and never posted', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const store = new Store(':memory:');
    const invented = withFingerprint({
      path: 'src/admin.ts',
      line: 2,
      severity: 'high',
      category: 'bug',
      title: 'Something about a line that does not exist',
      body: 'Paraphrased evidence.',
      evidence: '  return users.disableAccount(userId, true);',
      ruleIds: [],
      confidence: 0.9,
    });

    const result = await runReview(config(), {
      repoRoot: '.',
      platform,
      store,
      runner: makeFakeReviewer({ findings: [invented] }),
    });

    expect(platform.inline).toHaveLength(0);
    expect(result.findingsPosted).toHaveLength(0);
    expect(result.findingsDropped[0]!.dropReason).toContain('does not appear');
  });

  test('a failed review is interrupted and exits non-zero — never a silent success', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const result = await runReview(config(), {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({ fail: true }),
    });

    expect(result.status).toBe('interrupted');
    expect(result.errors.some((error) => error.stage === 'review')).toBe(true);
    expect(result.filesSkipped.some((entry) => entry.reason.includes('not reviewed'))).toBe(true);
    expect(exitCodeFor(result, config())).toBe(1);
  });

  test('an inline position rejection falls back to a general note and says so', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet(), rejectInline: true });
    const result = await runReview(config(), {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({ findings: [goodFinding()] }),
    });

    const fallbackNotes = platform.notes.filter((note) => note.body.includes('Could not attach'));
    expect(fallbackNotes).toHaveLength(1);
    expect(fallbackNotes[0]!.body).toContain('src/admin.ts:2');
    expect(result.degradations.some((entry) => entry.startsWith('inline-position-fallbacks'))).toBe(
      true,
    );
  });

  test('the judge can drop a verified finding', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const result = await runReview(config({ judge: 'on' }), {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({
        findings: [goodFinding()],
        judge: () => ({ verdict: 'drop', reason: 'pre-existing code' }),
      }),
    });

    expect(platform.inline).toHaveLength(0);
    expect(result.findingsDropped[0]!.dropReason).toContain('judge:');
  });

  test('a decision-model judge is recorded on the run and billed separately', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const jev = new JevJudge(
      { model: 'jev-1.13', apiKey: 'k', endpoint: 'https://example.test' },
      {
        async post() {
          return {
            id: 'gen-dec-1',
            model: 'jev-1.13',
            answers: {
              real: { type: 'noul', noul: 0.97 },
              changed: { type: 'noul', noul: 0.91 },
              specific: { type: 'noul', noul: 0.84 },
              action: { type: 'score', score: 1.9 },
            } as never,
            usage: { input_tokens: 950, output_tokens: 70, cost: 0.00004 },
          };
        },
      },
    );

    const result = await runReview(config({ judge: 'on' }), {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({ findings: [goodFinding()] }),
      judge: jev,
    });

    expect(platform.inline).toHaveLength(1);
    expect(result.judgeModel).toBe('jev-1.13');
    // The fake reviewer reports no cost, so the whole bill is the judge's.
    expect(result.costUsd).toBeCloseTo(0.00004, 9);
    expect(result.findingsPosted[0]!.calibratedConfidence).toBeCloseTo(0.84, 5);
    expect(platform.inline[0]!.body).toContain('calibrated');
  });

  test('--fail-on turns a posted critical finding into a non-zero exit', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const cfg = config({ failOn: 'high' });
    const result = await runReview(cfg, {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({ findings: [goodFinding()] }),
    });

    expect(result.status).toBe('completed');
    expect(exitCodeFor(result, cfg)).toBe(1);
  });

  test('dry run posts nothing at all', async () => {
    const platform = makeFakePlatform({ changeSet: changeSet() });
    const result = await runReview(config({ dryRun: true }), {
      repoRoot: '.',
      platform,
      store: new Store(':memory:'),
      runner: makeFakeReviewer({ findings: [goodFinding()] }),
    });

    expect(platform.inline).toHaveLength(0);
    expect(platform.notes).toHaveLength(0);
    expect(result.findingsPosted).toHaveLength(1);
  });
});
