/**
 * Tiny dependency-free logger shared by every TypeScript layer (core, db, desktop).
 *
 *  - four levels, structured context objects, a pluggable sink (console by default)
 *  - every entry is redacted first: any key matching /pin|hash|token|secret/i is replaced, so a PIN,
 *    pin hash or approval token can never reach the console, the buffer or a future host sink
 *  - an in-memory ring buffer of the last LOG_BUFFER_SIZE entries, for a later "copy diagnostics" button
 *
 * This is the only file allowed to call `console` (see eslint.config.js).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogContext = Readonly<Record<string, unknown>>;

export interface LogEntry {
  readonly ts: number;
  readonly level: LogLevel;
  readonly msg: string;
  readonly ctx?: LogContext;
}

export type LogSink = (entry: LogEntry) => void;

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
  /** A logger whose entries always carry `bound` (call-site context wins on key clashes). */
  child(bound: LogContext): Logger;
}

export interface LoggerHandle {
  readonly logger: Logger;
  /** Oldest first; a fresh array of frozen entries every call. */
  entries(): readonly LogEntry[];
  clear(): void;
  /** Replaces all sinks. */
  setSink(sink: LogSink): void;
  /** Fans out to one more sink. */
  addSink(sink: LogSink): void;
}

export interface CreateLoggerOptions {
  sink?: LogSink;
  bufferSize?: number;
  minLevel?: LogLevel;
  now?: () => number;
}

/** Plain, JSON-safe picture of a thrown value, with a bounded cause chain. */
export interface ErrorSummary {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  details?: unknown;
  cause?: ErrorSummary;
}

export const LOG_BUFFER_SIZE = 500;
export const REDACTED = '[redacted]';
const SECRET_KEY = /pin|hash|token|secret/i;
const MAX_DEPTH = 5;
const MAX_STRING = 1000;
const MAX_CAUSE_DEPTH = 5;
const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

// ---------- redaction ----------

const truncate = (s: string): string =>
  s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[+${s.length - MAX_STRING}]` : s;

function redactInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`;
  if (value instanceof Error) return describeErrorInner(value, 0, seen);
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth]';
  seen.add(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => redactInner(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactInner(v, depth + 1, seen);
  }
  return out;
}

/** Returns a redacted, cycle-safe, depth- and length-bounded copy; the input is never mutated. */
export const redact = (value: unknown): unknown => redactInner(value, 0, new WeakSet());

// ---------- errors ----------

function describeErrorInner(e: unknown, depth: number, seen: WeakSet<object>): ErrorSummary {
  if (!(e instanceof Error)) return { name: 'NonError', message: truncate(String(e)) };
  const out: ErrorSummary = { name: e.name, message: truncate(e.message) };
  if (typeof e.stack === 'string') out.stack = truncate(e.stack);
  const extra = e as unknown as { code?: unknown; details?: unknown; cause?: unknown };
  if (typeof extra.code === 'string') out.code = extra.code;
  if (extra.details !== undefined) out.details = redactInner(extra.details, 1, seen);
  if (extra.cause !== undefined && depth < MAX_CAUSE_DEPTH - 1)
    out.cause = describeErrorInner(extra.cause, depth + 1, seen);
  return out;
}

/** Message, stack, code/details (redacted) and the cause chain (at most MAX_CAUSE_DEPTH deep). */
export const describeError = (e: unknown): ErrorSummary => describeErrorInner(e, 0, new WeakSet());

// ---------- sinks ----------

export const consoleSink: LogSink = (entry) => {
  const line = `[pos ${entry.level}] ${entry.msg}`;
  const args: unknown[] = entry.ctx === undefined ? [line] : [line, entry.ctx];
  switch (entry.level) {
    case 'debug':
      console.debug(...args);
      break;
    case 'info':
      console.info(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'error':
      console.error(...args);
      break;
  }
};

// ---------- logger ----------

export function createLogger(opts: CreateLoggerOptions = {}): LoggerHandle {
  const size = opts.bufferSize ?? LOG_BUFFER_SIZE;
  const minRank = LEVEL_RANK[opts.minLevel ?? 'debug'];
  const now = opts.now ?? Date.now;
  let sinks: readonly LogSink[] = [opts.sink ?? consoleSink];
  const buffer: LogEntry[] = [];

  const emit = (
    level: LogLevel,
    msg: string,
    bound: LogContext | undefined,
    ctx?: LogContext,
  ): void => {
    if (LEVEL_RANK[level] < minRank) return;
    const merged = bound === undefined ? ctx : { ...bound, ...ctx };
    const safeCtx = merged === undefined ? undefined : (redact(merged) as LogContext);
    const entry: LogEntry = Object.freeze(
      safeCtx === undefined ? { ts: now(), level, msg } : { ts: now(), level, msg, ctx: safeCtx },
    );
    buffer.push(entry);
    if (buffer.length > size) buffer.splice(0, buffer.length - size);
    for (const sink of sinks) {
      try {
        sink(entry);
      } catch {
        // a broken sink must never take the app down with it
      }
    }
  };

  const make = (bound?: LogContext): Logger => ({
    debug: (msg, ctx) => emit('debug', msg, bound, ctx),
    info: (msg, ctx) => emit('info', msg, bound, ctx),
    warn: (msg, ctx) => emit('warn', msg, bound, ctx),
    error: (msg, ctx) => emit('error', msg, bound, ctx),
    child: (more) => make(bound === undefined ? more : { ...bound, ...more }),
  });

  return {
    logger: make(),
    entries: () => [...buffer],
    clear: () => {
      buffer.length = 0;
    },
    setSink: (sink) => {
      sinks = [sink];
    },
    addSink: (sink) => {
      sinks = [...sinks, sink];
    },
  };
}

// ---------- the shared singleton ----------

const shared = createLogger();

/** The app-wide logger. Console by default; the desktop shell may add a host sink via `addLogSink`. */
export const log: Logger = shared.logger;
/** Last LOG_BUFFER_SIZE entries, oldest first, for a diagnostics dump. */
export const getLogEntries = (): readonly LogEntry[] => shared.entries();
export const clearLogEntries = (): void => shared.clear();
export const setLogSink = (sink: LogSink): void => shared.setSink(sink);
export const addLogSink = (sink: LogSink): void => shared.addSink(sink);
