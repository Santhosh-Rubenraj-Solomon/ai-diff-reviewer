import { describe, expect, test } from 'bun:test';
import { render } from '../src/render/terminal.ts';
import type { Finding, RawFinding } from '../src/types.ts';
import { buildVerifyPrompt, runVerifyPass } from '../src/verify.ts';

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  file: 'src/a.ts',
  line: 12,
  severity: 'bug',
  title: 'Null dereference',
  body: 'user may be null here.',
  evidence: '+ return user.name;',
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  ...raw(),
  verdict: 'survived',
  verdictReason: 'held up',
  ...over,
});

describe('buildVerifyPrompt', () => {
  test('includes the diff, the claim and the refutation instruction', () => {
    const prompt = buildVerifyPrompt(raw({ historyBasis: 'line fixed 3 days ago' }), '@@ -1 +1 @@');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('Line: 12');
    expect(prompt).toContain('@@ -1 +1 @@');
    expect(prompt).toContain('Null dereference');
    expect(prompt).toContain('line fixed 3 days ago');
    expect(prompt).toContain('Argue this comment is incorrect');
  });

  test('marks file-level findings and omits an absent history basis', () => {
    const prompt = buildVerifyPrompt(raw({ line: null }), 'diff');
    expect(prompt).toContain('Line: file-level');
    expect(prompt).not.toContain('Git-history basis');
  });
});

describe('runVerifyPass ceiling', () => {
  test('passes everything through unverified when the ceiling is zero', async () => {
    const findings = [raw(), raw({ severity: 'nit', title: 'B' })];
    const result = await runVerifyPass(findings, new Map(), 2, 0);

    expect(result.callsUsed).toBe(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings.every((f) => f.verdict === 'unverified')).toBe(true);
    expect(result.findings[0]?.verdictReason).toContain('ceiling');
    expect(result.warnings[0]?.message).toContain('exceeded the verification ceiling');
  });

  test('every processed finding carries a verdict and a reason', async () => {
    const result = await runVerifyPass([raw()], new Map(), 1, 0);
    for (const f of result.findings) {
      expect(['survived', 'discarded', 'unverified']).toContain(f.verdict);
      expect(f.verdictReason.length).toBeGreaterThan(0);
    }
  });

  test('spends the ceiling on the most severe findings first', async () => {
    // No key means the single permitted call fails closed to `unverified`
    // without touching the network — but the *nit* must be the one that never
    // gets a call at all, and it is distinguishable by its verdict reason.
    const key = process.env.GEMINI_API_KEY;
    const alt = process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const findings = [
        raw({ severity: 'nit', title: 'Nit' }),
        raw({ severity: 'bug', title: 'Bug' }),
      ];
      const result = await runVerifyPass(findings, new Map(), 1, 1);

      expect(result.callsUsed).toBe(1);
      expect(result.findings.find((f) => f.title === 'Nit')?.verdictReason).toContain('ceiling');
      expect(result.findings.find((f) => f.title === 'Bug')?.verdictReason).toContain(
        'GEMINI_API_KEY',
      );
      expect(result.findings.every((f) => f.verdict === 'unverified')).toBe(true);
    } finally {
      if (key !== undefined) process.env.GEMINI_API_KEY = key;
      if (alt !== undefined) process.env.GOOGLE_API_KEY = alt;
    }
  });
});

describe('render', () => {
  const base = {
    target: { kind: 'staged' } as const,
    excluded: [],
    warnings: [],
    filesReviewed: 1,
    chunksReviewed: 1,
    verifyCallsUsed: 1,
  };

  test('hides discarded findings by default and shows them under verbose', () => {
    const result = {
      ...base,
      findings: [finding({ verdict: 'discarded', verdictReason: 'refuted: already guarded' })],
    };

    expect(render(result, { verbose: false })).toContain('No findings.');
    expect(render(result, { verbose: false })).toContain('did not survive verification');

    const verbose = render(result, { verbose: true });
    expect(verbose).toContain('Null dereference');
    expect(verbose).toContain('already guarded');
  });

  test('orders by severity within a file and groups files alphabetically', () => {
    const out = render(
      {
        ...base,
        findings: [
          finding({ file: 'src/z.ts', severity: 'nit', title: 'Z-nit' }),
          finding({ file: 'src/a.ts', severity: 'nit', title: 'A-nit', line: 1 }),
          finding({ file: 'src/a.ts', severity: 'bug', title: 'A-bug', line: 9 }),
        ],
      },
      { verbose: false },
    );

    expect(out.indexOf('src/a.ts')).toBeLessThan(out.indexOf('src/z.ts'));
    expect(out.indexOf('A-bug')).toBeLessThan(out.indexOf('A-nit'));
  });

  test('flags unverified findings and shows a history basis when present', () => {
    const out = render(
      {
        ...base,
        findings: [
          finding({ verdict: 'unverified', historyBasis: 'these lines were fixed 3 days ago' }),
        ],
      },
      { verbose: false },
    );

    expect(out).toContain('[unverified]');
    expect(out).toContain('fixed 3 days ago');
  });

  test('reports excluded files instead of dropping them silently', () => {
    const out = render(
      { ...base, findings: [], excluded: [{ path: 'bun.lockb', reason: 'lockfile' as const }] },
      { verbose: false },
    );
    expect(out).toContain('bun.lockb');
    expect(out).toContain('lockfile');
  });
});
