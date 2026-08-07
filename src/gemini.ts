/**
 * Gemini client, built on `fetch`.
 *
 * No SDK: one endpoint, one request shape, and structured output is a field on
 * the request rather than a library feature. Keeping it hand-rolled preserves
 * the near-zero dependency goal and makes the retry policy explicit.
 */

import { config } from './config.ts';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** Read the key from the environment. Never accepts a literal. */
export function apiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new GeminiError(
      'GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey and export it.',
    );
  }
  return key;
}

export interface GenerateOptions {
  model: string;
  system: string;
  prompt: string;
  /** A JSON Schema; when present the model is forced to return matching JSON. */
  schema?: unknown;
  temperature?: number;
  signal?: AbortSignal;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/** One generation call, with retries on transient failures. */
export async function generate(options: GenerateOptions): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.requestRetries; attempt++) {
    try {
      return await generateOnce(options);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof GeminiError && err.retryable;
      if (!retryable || attempt === config.requestRetries) break;
      // Exponential backoff, capped so a stuck run still finishes eventually.
      await Bun.sleep(Math.min(2 ** attempt * 750, 8_000));
    }
  }

  throw lastError;
}

async function generateOnce(options: GenerateOptions): Promise<string> {
  // Resolved up front so a missing key fails fast instead of being mistaken
  // for a transient network error and retried.
  const key = apiKey();
  const url = `${ENDPOINT}/${encodeURIComponent(options.model)}:generateContent`;
  const timeout = AbortSignal.timeout(config.requestTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: 'user', parts: [{ text: options.prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.1,
      ...(options.schema
        ? { responseMimeType: 'application/json', responseSchema: options.schema }
        : {}),
    },
    // The reviewer's whole job is discussing code that may be unsafe; the
    // default filters otherwise drop legitimate security findings.
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GeminiError(`Request to Gemini failed: ${message}`, undefined, true);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    throw new GeminiError(
      `Gemini returned ${response.status}: ${truncate(text, 400)}`,
      response.status,
      retryable,
    );
  }

  const payload = (await response.json()) as GeminiResponse;

  if (payload.error?.message) throw new GeminiError(`Gemini error: ${payload.error.message}`);
  if (payload.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini blocked the prompt: ${payload.promptFeedback.blockReason}`);
  }

  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

  if (!text.trim()) {
    throw new GeminiError(
      `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`,
      undefined,
      candidate?.finishReason === 'MAX_TOKENS' ? false : true,
    );
  }
  return text;
}

/**
 * Parse a model response as JSON, tolerating the fenced-code wrapper the
 * model sometimes adds even under a response schema.
 */
export function parseJson<T>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Last resort: pull the outermost JSON value out of surrounding prose.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new SyntaxError(`Model did not return valid JSON: ${truncate(cleaned, 200)}`);
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
