/**
 * Secret redaction, applied to everything before it reaches a model call.
 *
 * Redaction is recorded, not silent: the run reports how many matches were
 * masked, so "no secrets found" and "redaction never ran" look different.
 */

export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

interface Pattern {
  name: string;
  re: RegExp;
  replace?: (match: string) => string;
}

const PATTERNS: Pattern[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_\-]{20,}/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{32,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_\-]{20,}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g },
  {
    name: 'assigned-secret',
    // key = "value" / key: 'value' where the key smells like a credential.
    re: /\b((?:api[_-]?key|secret|passwd|password|token|client[_-]?secret|private[_-]?key)\s*[:=]\s*)(['"])([^'"\n]{8,})\2/gi,
    replace: (match) => match.replace(/(['"])([^'"\n]{8,})\1/, '$1[REDACTED]$1'),
  },
];

export function redact(input: string): RedactionResult {
  let text = input;
  let count = 0;
  const kinds: string[] = [];

  for (const pattern of PATTERNS) {
    let hits = 0;
    text = text.replace(pattern.re, (match) => {
      hits += 1;
      return pattern.replace ? pattern.replace(match) : `[REDACTED:${pattern.name}]`;
    });
    if (hits > 0) {
      count += hits;
      kinds.push(pattern.name);
    }
  }

  return { text, count, kinds };
}

/** Paths a model-requested file read must never reach. */
const DENIED = [
  /(^|\/)\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)credentials?(\.|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
];

export function isDeniedPath(path: string): boolean {
  return DENIED.some((pattern) => pattern.test(path));
}

/** Confines a path to the repository root; returns null when it escapes. */
export function confineToRepo(root: string, candidate: string): string | null {
  const normalized = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || normalized.includes('..')) return null;
  if (isDeniedPath(normalized)) return null;
  return `${root.replace(/\/$/, '')}/${normalized}`;
}
