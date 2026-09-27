/**
 * One structured line per stage. Law 3: if something was skipped, dropped or
 * failed, it appears here and in the RunResult — never only in someone's head.
 */

export type LogFormat = 'json' | 'human';

export interface StageLog {
  stage: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  files?: number;
  kept?: number;
  dropped?: number;
  [key: string]: unknown;
}

let format: LogFormat = 'human';
let quiet = false;

export function configureLogger(opts: { format?: LogFormat; quiet?: boolean }): void {
  if (opts.format) format = opts.format;
  if (opts.quiet !== undefined) quiet = opts.quiet;
}

function emit(level: 'info' | 'warn' | 'error', payload: Record<string, unknown>): void {
  if (quiet && level === 'info') return;
  const stream = level === 'info' ? process.stdout : process.stderr;
  if (format === 'json') {
    stream.write(JSON.stringify({ level, ts: new Date().toISOString(), ...payload }) + '\n');
    return;
  }
  const { msg, ...rest } = payload;
  const tail = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  const prefix = level === 'info' ? '' : level === 'warn' ? 'warn: ' : 'error: ';
  stream.write(`${prefix}${msg ?? ''}${tail ? ` ${tail}` : ''}\n`);
}

export const log = {
  info(msg: string, fields: Record<string, unknown> = {}): void {
    emit('info', { msg, ...fields });
  },
  warn(msg: string, fields: Record<string, unknown> = {}): void {
    emit('warn', { msg, ...fields });
  },
  error(msg: string, fields: Record<string, unknown> = {}): void {
    emit('error', { msg, ...fields });
  },
  stage(entry: StageLog): void {
    emit('info', { msg: `stage:${entry.stage}`, ...entry });
  },
};

/** Times a stage and logs it, whether it resolves or throws. */
export async function timed<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    log.stage({ stage, durationMs: Math.round(performance.now() - started) });
    return result;
  } catch (err) {
    log.stage({
      stage,
      durationMs: Math.round(performance.now() - started),
      failed: true,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
