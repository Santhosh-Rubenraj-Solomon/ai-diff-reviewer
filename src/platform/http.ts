/**
 * The HTTP behaviour both hosted adapters need: typed errors, jittered retries
 * on the transient statuses, and pagination that actually follows the cursor.
 *
 * Pagination is not optional. A large MR whose `/diffs` response is truncated
 * silently produces a review that claims to have read every file.
 */

export class PlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PlatformError';
  }

  get retryable(): boolean {
    return this.status === 429 || this.status === 408 || this.status >= 500;
  }
}

export interface HttpOptions {
  headers: Record<string, string>;
  maxAttempts?: number;
  timeoutMs?: number;
}

const BASE_DELAY_MS = 1_000;

function jitter(ms: number): number {
  // ±20%, matching the retry policy used for model calls.
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function httpRequest(
  url: string,
  init: RequestInit,
  opts: HttpOptions,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...opts.headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });

      if (response.ok) return response;

      const body = await response.text().catch(() => '');
      const error = new PlatformError(
        `${init.method ?? 'GET'} ${url} -> ${response.status}`,
        response.status,
        url,
        body.slice(0, 500),
      );
      if (!error.retryable || attempt === maxAttempts) throw error;

      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : jitter(BASE_DELAY_MS * 2 ** (attempt - 1));
      await sleep(delay);
      lastError = error;
    } catch (err) {
      if (err instanceof PlatformError) {
        if (!err.retryable || attempt === maxAttempts) throw err;
        lastError = err;
        continue;
      }
      // Network-level failure (DNS, reset, timeout).
      if (attempt === maxAttempts) throw err;
      lastError = err;
      await sleep(jitter(BASE_DELAY_MS * 2 ** (attempt - 1)));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function httpJson<T>(url: string, init: RequestInit, opts: HttpOptions): Promise<T> {
  const response = await httpRequest(url, init, opts);
  return (await response.json()) as T;
}

export async function httpText(
  url: string,
  init: RequestInit,
  opts: HttpOptions,
): Promise<string> {
  const response = await httpRequest(url, init, opts);
  return await response.text();
}

/** Follows GitLab's `x-next-page` header until it is empty. */
export async function paginateGitlab<T>(
  baseUrl: string,
  opts: HttpOptions,
  perPage = 100,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  for (;;) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${separator}per_page=${perPage}&page=${page}`;
    const response = await httpRequest(url, { method: 'GET' }, opts);
    const items = (await response.json()) as T[] | { diffs?: T[] };
    const batch = Array.isArray(items) ? items : (items.diffs ?? []);
    all.push(...batch);

    const next = response.headers.get('x-next-page');
    if (!next || next.trim() === '') break;
    const parsed = Number(next);
    if (!Number.isFinite(parsed) || parsed <= page) break;
    page = parsed;
  }
  return all;
}

/** Follows GitHub's `Link: <...>; rel="next"` header. */
export async function paginateGithub<T>(
  baseUrl: string,
  opts: HttpOptions,
  perPage = 100,
): Promise<T[]> {
  const all: T[] = [];
  const separator = baseUrl.includes('?') ? '&' : '?';
  let url: string | null = `${baseUrl}${separator}per_page=${perPage}`;

  while (url) {
    const response: Response = await httpRequest(url, { method: 'GET' }, opts);
    all.push(...((await response.json()) as T[]));
    url = nextLink(response.headers.get('link'));
  }
  return all;
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match) return match[1]!;
  }
  return null;
}
