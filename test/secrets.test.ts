import { describe, expect, test } from 'bun:test';
import { confineToRepo, isDeniedPath, redact } from '../src/review/secrets.ts';

describe('redact', () => {
  test('reports zero matches on clean text and returns it unchanged', () => {
    const result = redact('const total = a + b;');
    expect(result).toEqual({ text: 'const total = a + b;', count: 0, kinds: [] });
  });

  test('masks a PEM private key block as one match', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEow...', '-----END RSA PRIVATE KEY-----'].join('\n');
    const result = redact(`key:\n${pem}\nafter`);
    expect(result.text).toBe('key:\n[REDACTED:private-key]\nafter');
    expect(result.kinds).toEqual(['private-key']);
    expect(result.count).toBe(1);
  });

  test('an Anthropic key is labelled as such, not as an OpenAI key', () => {
    const result = redact(`const k = sk-ant-${'a'.repeat(40)};`);
    expect(result.text).toContain('[REDACTED:anthropic-key]');
    expect(result.kinds).toEqual(['anthropic-key']);
  });

  test('masks provider tokens', () => {
    const cases: [string, string][] = [
      [`sk-${'A1'.repeat(20)}`, 'openai-key'],
      ['AKIAABCDEFGHIJKLMNOP', 'aws-access-key'],
      [`ghp_${'x'.repeat(36)}`, 'github-token'],
      [`glpat-${'y'.repeat(20)}`, 'gitlab-token'],
      ['xoxb-1234567890-abcdef', 'slack-token'],
      [`AIza${'Z'.repeat(35)}`, 'google-api-key'],
      [`eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`, 'jwt'],
    ];
    for (const [secret, kind] of cases) {
      const result = redact(`value ${secret} end`);
      expect(result.text).toBe(`value [REDACTED:${kind}] end`);
      expect(result.kinds).toContain(kind);
    }
  });

  test('a too-short token-looking string is left alone', () => {
    expect(redact('ghp_short').count).toBe(0);
    expect(redact('AKIA1234').count).toBe(0);
  });

  test('masks the value of an assigned credential but keeps the key and quotes', () => {
    const result = redact(`const password = "hunter2hunter2";`);
    expect(result.text).toBe(`const password = "[REDACTED]";`);
    expect(result.kinds).toEqual(['assigned-secret']);
  });

  test('assignment matching is case-insensitive and supports colon syntax', () => {
    const result = redact(`API_KEY: 'abcdefghijkl'`);
    expect(result.text).toBe(`API_KEY: '[REDACTED]'`);
  });

  test('short assigned values (< 8 chars) are not treated as secrets', () => {
    expect(redact(`password = "abc"`).count).toBe(0);
  });

  test('counts every match across kinds', () => {
    const text = `AKIAABCDEFGHIJKLMNOP and AKIAQRSTUVWXYZ012345 and token = "zzzzzzzzzz"`;
    const result = redact(text);
    expect(result.count).toBe(3);
    expect(result.kinds).toEqual(['aws-access-key', 'assigned-secret']);
  });

  test('redact is idempotent on its own output', () => {
    const once = redact(`AKIAABCDEFGHIJKLMNOP password="supersecret"`);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
  });
});

describe('isDeniedPath', () => {
  test('denies env files, keys and credential stores anywhere in the tree', () => {
    for (const path of [
      '.env',
      'apps/api/.env.production',
      'certs/server.pem',
      'tls.key',
      'store.p12',
      'store.pfx',
      'home/.ssh/id_rsa',
      'id_ed25519',
      'aws/credentials',
      'config/credentials.json',
      '.npmrc',
      'x/.netrc',
    ]) {
      expect(isDeniedPath(path)).toBe(true);
    }
  });

  test('allows ordinary source files with similar-looking names', () => {
    for (const path of ['src/env.ts', 'src/keyboard.ts', 'docs/environment.md', 'src/id_rsa_parser.ts']) {
      expect(isDeniedPath(path)).toBe(false);
    }
  });
});

describe('confineToRepo', () => {
  test('joins a relative path to the root', () => {
    expect(confineToRepo('/repo/', './src/a.ts')).toBe('/repo/src/a.ts');
    expect(confineToRepo('/repo', 'src/a.ts')).toBe('/repo/src/a.ts');
  });

  test('normalises Windows separators', () => {
    expect(confineToRepo('/repo', 'src\\a.ts')).toBe('/repo/src/a.ts');
  });

  test('refuses absolute paths and parent traversal', () => {
    expect(confineToRepo('/repo', '/etc/passwd')).toBeNull();
    expect(confineToRepo('/repo', '../outside.ts')).toBeNull();
    expect(confineToRepo('/repo', 'src/../../outside.ts')).toBeNull();
    expect(confineToRepo('/repo', '..\\outside.ts')).toBeNull();
  });

  test('refuses denied paths even inside the repo', () => {
    expect(confineToRepo('/repo', 'config/.env')).toBeNull();
  });

  // Over-strict rather than unsafe: `includes('..')` also rejects a legal file
  // name such as `a..b.ts`. Documented here; not a security issue.
  test('rejects a filename that merely contains two dots (over-strict)', () => {
    expect(confineToRepo('/repo', 'src/a..b.ts')).toBeNull();
  });
});
