import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  httpJson,
  httpRequest,
  httpText,
  paginateGithub,
  paginateGitlab,
  PlatformError,
} from '../src/platform/http.ts';
import { jsonResponse, mockFetch } from './helpers.ts';

const OPTS = { headers: { authorization: 'Bearer t' } };

let restoreFetch: (() => void) | null = null;
let delays: number[] = [];
let timeoutSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  delays = [];
  // Retries sleep with setTimeout; record the delay and fire immediately.
  timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    queueMicrotask(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  timeoutSpy?.mockRestore();
});

function useFetch(route: Parameters<typeof mockFetch>[0]) {
  const mock = mockFetch(route);
  restoreFetch = mock.restore;
  return mock.calls;
}

describe('PlatformError', () => {
  test('retryable on 408, 429 and 5xx only', () => {
    expect(new PlatformError('x', 429, 'u').retryable).toBe(true);
    expect(new PlatformError('x', 408, 'u').retryable).toBe(true);
    expect(new PlatformError('x', 503, 'u').retryable).toBe(true);
    expect(new PlatformError('x', 404, 'u').retryable).toBe(false);
    expect(new PlatformError('x', 401, 'u').retryable).toBe(false);
    expect(new PlatformError('x', 422, 'u').name).toBe('PlatformError');
  });
});

describe('httpRequest', () => {
  test('merges default headers with per-request headers (request wins)', async () => {
    const calls = useFetch(() => new Response('ok'));
    await httpRequest('https://api/x', { method: 'GET', headers: { accept: 'raw', authorization: 'override' } }, OPTS);
    expect(calls[0]!.headers).toEqual({ authorization: 'override', accept: 'raw' });
  });

  test('does not retry a 4xx and throws a typed error with a truncated body', async () => {
    const calls = useFetch(() => new Response('n'.repeat(2_000), { status: 404 }));
    const error = await httpRequest('https://api/x', { method: 'GET' }, OPTS).catch((err) => err);
    expect(error).toBeInstanceOf(PlatformError);
    expect(error.status).toBe(404);
    expect(error.message).toBe('GET https://api/x -> 404');
    expect(error.body).toHaveLength(500);
    expect(calls).toHaveLength(1);
  });

  test('retries a 5xx with exponential backoff and then succeeds', async () => {
    let n = 0;
    const calls = useFetch(() => (++n < 3 ? new Response('busy', { status: 502 }) : new Response('done')));
    const response = await httpRequest('https://api/x', { method: 'GET' }, OPTS);
    expect(await response.text()).toBe('done');
    expect(calls).toHaveLength(3);
    // Base 1000ms, ±20% jitter, doubling.
    expect(delays[0]).toBeGreaterThanOrEqual(800);
    expect(delays[0]).toBeLessThanOrEqual(1200);
    expect(delays[1]).toBeGreaterThanOrEqual(1600);
    expect(delays[1]).toBeLessThanOrEqual(2400);
  });

  test('honours Retry-After on a 429', async () => {
    let n = 0;
    useFetch(() =>
      ++n === 1 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : new Response('ok'),
    );
    await httpRequest('https://api/x', { method: 'GET' }, OPTS);
    expect(delays).toEqual([7000]);
  });

  test('gives up after maxAttempts and throws the last error', async () => {
    const calls = useFetch(() => new Response('down', { status: 500 }));
    await expect(httpRequest('https://api/x', { method: 'POST' }, { ...OPTS, maxAttempts: 2 })).rejects.toMatchObject({
      status: 500,
      message: 'POST https://api/x -> 500',
    });
    expect(calls).toHaveLength(2);
  });

  test('retries network-level failures and rethrows the last one', async () => {
    const calls = useFetch(() => {
      throw new TypeError('ECONNRESET');
    });
    await expect(httpRequest('https://api/x', { method: 'GET' }, { ...OPTS, maxAttempts: 3 })).rejects.toThrow('ECONNRESET');
    expect(calls).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });

  test('httpJson and httpText decode the body', async () => {
    useFetch((url) => (url.endsWith('json') ? jsonResponse({ a: 1 }) : new Response('plain')));
    expect(await httpJson<{ a: number }>('https://api/json', { method: 'GET' }, OPTS)).toEqual({ a: 1 });
    expect(await httpText('https://api/text', { method: 'GET' }, OPTS)).toBe('plain');
  });
});

describe('paginateGitlab', () => {
  test('follows x-next-page until it is empty', async () => {
    const calls = useFetch((url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return jsonResponse([page], { headers: { 'x-next-page': page < 3 ? String(page + 1) : '' } });
    });
    expect(await paginateGitlab<number>('https://gl/api/items?scope=all', OPTS, 2)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url)).toEqual([
      'https://gl/api/items?scope=all&per_page=2&page=1',
      'https://gl/api/items?scope=all&per_page=2&page=2',
      'https://gl/api/items?scope=all&per_page=2&page=3',
    ]);
  });

  test('unwraps a { diffs } envelope', async () => {
    useFetch(() => jsonResponse({ diffs: ['d1', 'd2'] }));
    expect(await paginateGitlab<string>('https://gl/api/diffs', OPTS)).toEqual(['d1', 'd2']);
  });

  test('stops on a non-advancing or garbage next page rather than looping forever', async () => {
    const calls = useFetch(() => jsonResponse(['x'], { headers: { 'x-next-page': '1' } }));
    expect(await paginateGitlab('https://gl/api/a', OPTS)).toEqual(['x']);
    expect(calls).toHaveLength(1);

    const calls2 = useFetch(() => jsonResponse(['y'], { headers: { 'x-next-page': 'abc' } }));
    expect(await paginateGitlab('https://gl/api/b', OPTS)).toEqual(['y']);
    expect(calls2).toHaveLength(1);
  });
});

describe('paginateGithub', () => {
  test('follows the rel="next" Link header', async () => {
    const calls = useFetch((url) => {
      if (url.includes('page=2')) {
        return jsonResponse([3], { headers: { link: '<https://gh/api/items?page=1>; rel="prev"' } });
      }
      return jsonResponse([1, 2], {
        headers: { link: '<https://gh/api/items?page=1>; rel="first", <https://gh/api/items?page=2>; rel="next"' },
      });
    });
    expect(await paginateGithub<number>('https://gh/api/items', OPTS)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.url)).toEqual(['https://gh/api/items?per_page=100', 'https://gh/api/items?page=2']);
  });

  test('a single page with no Link header is one request', async () => {
    const calls = useFetch(() => jsonResponse([]));
    expect(await paginateGithub('https://gh/api/items?state=open', OPTS, 5)).toEqual([]);
    expect(calls[0]!.url).toBe('https://gh/api/items?state=open&per_page=5');
  });
});
