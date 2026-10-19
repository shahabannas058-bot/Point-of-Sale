import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOG_BUFFER_SIZE,
  consoleSink,
  createLogger,
  describeError,
  getLogEntries,
  log,
  redact,
  setLogSink,
  type LogEntry,
} from '../src/log';

const capture = (): { sink: (e: LogEntry) => void; seen: LogEntry[] } => {
  const seen: LogEntry[] = [];
  return { sink: (e) => seen.push(e), seen };
};

describe('createLogger', () => {
  it('writes every level to the sink with a timestamp and structured context', () => {
    // Arrange
    const { sink, seen } = capture();
    const h = createLogger({ sink, now: () => 1_700_000_000_000 });

    // Act
    h.logger.debug('d', { a: 1 });
    h.logger.info('i');
    h.logger.warn('w', { b: 'two' });
    h.logger.error('e', { c: [1, 2] });

    // Assert
    expect(seen.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
    expect(seen[0]).toEqual({ ts: 1_700_000_000_000, level: 'debug', msg: 'd', ctx: { a: 1 } });
    expect(seen[1]!.ctx).toBeUndefined();
    expect(seen[3]!.ctx).toEqual({ c: [1, 2] });
  });

  it('drops entries below minLevel', () => {
    const { sink, seen } = capture();
    const h = createLogger({ sink, minLevel: 'warn' });
    h.logger.debug('d');
    h.logger.info('i');
    h.logger.warn('w');
    h.logger.error('e');
    expect(seen.map((e) => e.msg)).toEqual(['w', 'e']);
  });

  it('keeps only the last N entries in the ring buffer, oldest first', () => {
    const h = createLogger({ sink: () => undefined, bufferSize: 3 });
    for (let i = 0; i < 5; i++) h.logger.info(`m${i}`);
    expect(h.entries().map((e) => e.msg)).toEqual(['m2', 'm3', 'm4']);
    expect(LOG_BUFFER_SIZE).toBe(500);
  });

  it('returns frozen entries and a fresh copy of the buffer', () => {
    const h = createLogger({ sink: () => undefined });
    h.logger.info('x', { a: 1 });
    const first = h.entries();
    expect(Object.isFrozen(first[0])).toBe(true);
    expect(h.entries()).not.toBe(first);
    h.clear();
    expect(h.entries()).toEqual([]);
  });

  it('a throwing sink never breaks the caller and the entry is still buffered', () => {
    const h = createLogger({
      sink: () => {
        throw new Error('sink down');
      },
    });
    expect(() => h.logger.error('boom')).not.toThrow();
    expect(h.entries()).toHaveLength(1);
  });

  it('setSink replaces and addSink fans out', () => {
    const a = capture();
    const b = capture();
    const h = createLogger({ sink: a.sink });
    h.addSink(b.sink);
    h.logger.info('one');
    h.setSink(b.sink);
    h.logger.info('two');
    expect(a.seen.map((e) => e.msg)).toEqual(['one']);
    expect(b.seen.map((e) => e.msg)).toEqual(['one', 'two']);
  });

  it('child loggers merge their bound context under the call context', () => {
    const { sink, seen } = capture();
    const h = createLogger({ sink });
    h.logger.child({ module: 'bridge', x: 1 }).warn('late', { x: 2 });
    expect(seen[0]!.ctx).toEqual({ module: 'bridge', x: 2 });
  });
});

describe('redaction', () => {
  it('redacts keys matching pin, hash, token or secret at any depth, case-insensitively', () => {
    const out = redact({
      pin: '1234',
      PIN: '0000',
      user: {
        pinHash: 'abc',
        name: 'ali',
        nested: { approvalToken: 't', list: [{ secret: 's' }] },
      },
      Secret_Key: 'k',
      amount: 500,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      pin: '[redacted]',
      PIN: '[redacted]',
      user: {
        pinHash: '[redacted]',
        name: 'ali',
        nested: { approvalToken: '[redacted]', list: [{ secret: '[redacted]' }] },
      },
      Secret_Key: '[redacted]',
      amount: 500,
    });
  });

  it('is applied by the logger before the sink and the ring buffer see the entry', () => {
    const { sink, seen } = capture();
    const h = createLogger({ sink });
    const ctx = { pin: '9999', user: { pinHash: 'h' }, ok: true };
    h.logger.error('login', ctx);
    expect(seen[0]!.ctx).toEqual({ pin: '[redacted]', user: { pinHash: '[redacted]' }, ok: true });
    expect(h.entries()[0]!.ctx).toEqual(seen[0]!.ctx);
    expect(ctx.pin).toBe('9999'); // the caller's object is not mutated
  });

  it('handles cycles, depth limits and long strings without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = redact(a) as Record<string, unknown>;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[circular]');
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: 'x' } } } } } };
    expect(JSON.stringify(redact(deep))).toContain('[depth]');
    const long = redact('x'.repeat(5000)) as string;
    expect(long.length).toBeLessThan(1100);
  });

  it('turns Error values inside context into plain summaries', () => {
    const inner = new Error('inner');
    const outer = new Error('outer', { cause: inner });
    const out = redact({ error: outer }) as {
      error: { name: string; message: string; cause?: unknown };
    };
    expect(out.error.name).toBe('Error');
    expect(out.error.message).toBe('outer');
    expect((out.error.cause as { message: string }).message).toBe('inner');
  });
});

describe('describeError', () => {
  it('captures name, message, stack and the cause chain', () => {
    const root = new TypeError('root');
    const mid = new Error('mid', { cause: root });
    const top = new Error('top', { cause: mid });
    const d = describeError(top);
    expect(d.name).toBe('Error');
    expect(d.message).toBe('top');
    expect(typeof d.stack).toBe('string');
    expect(d.cause?.message).toBe('mid');
    expect(d.cause?.cause?.name).toBe('TypeError');
  });

  it('copes with non-Error throwables and bounded cause depth', () => {
    expect(describeError('plain string')).toEqual({ name: 'NonError', message: 'plain string' });
    expect(describeError(42).message).toBe('42');
    let e: Error = new Error('e0');
    for (let i = 1; i < 20; i++) e = new Error(`e${i}`, { cause: e });
    const d = describeError(e);
    let depth = 0;
    for (let c = d.cause; c; c = c.cause) depth++;
    expect(depth).toBeLessThanOrEqual(5);
  });

  it('includes a ServiceError-like code and redacted details', () => {
    const e = Object.assign(new Error('svc'), { code: 'INTERNAL', details: { pin: '1', f: 'x' } });
    const d = describeError(e);
    expect(d.code).toBe('INTERNAL');
    expect(d.details).toEqual({ pin: '[redacted]', f: 'x' });
  });
});

describe('default logger and console sink', () => {
  afterEach(() => {
    setLogSink(consoleSink);
    vi.restoreAllMocks();
  });

  it('the shared singleton buffers entries and honours setLogSink', () => {
    const { sink, seen } = capture();
    setLogSink(sink);
    log.warn('shared', { token: 'abc' });
    expect(seen.at(-1)!.ctx).toEqual({ token: '[redacted]' });
    expect(getLogEntries().at(-1)!.msg).toBe('shared');
  });

  it('consoleSink routes each level to the matching console method', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = { ts: 0, msg: 'm', ctx: { a: 1 } };
    consoleSink({ ...base, level: 'debug' });
    consoleSink({ ...base, level: 'info' });
    consoleSink({ ...base, level: 'warn' });
    consoleSink({ ...base, level: 'error' });
    expect(debug).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(String(error.mock.calls[0]![0])).toContain('m');
  });
});
