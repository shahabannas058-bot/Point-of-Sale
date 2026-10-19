import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consoleSink, setLogSink, type LogEntry } from '@pos/shared';
import { installGlobalErrorLogging, type ErrorEventTarget } from '../src/bootstrap';

type Handler = (ev: unknown) => void;

function fakeTarget(): { target: ErrorEventTarget; fire: (type: string, ev: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  return {
    target: {
      addEventListener: (type: string, h: Handler) => {
        handlers.set(type, [...(handlers.get(type) ?? []), h]);
      },
    },
    fire: (type, ev) => (handlers.get(type) ?? []).forEach((h) => h(ev)),
  };
}

let seen: LogEntry[] = [];
beforeEach(() => {
  seen = [];
  setLogSink((e) => seen.push(e));
});
afterEach(() => setLogSink(consoleSink));

describe('installGlobalErrorLogging', () => {
  it('logs window.onerror events with the thrown error and source position', () => {
    const { target, fire } = fakeTarget();
    installGlobalErrorLogging(target);
    fire('error', {
      message: 'Script error',
      filename: 'app.js',
      lineno: 10,
      colno: 5,
      error: new Error('render blew up'),
    });
    const entry = seen.find((e) => e.msg === 'window.error');
    expect(entry?.level).toBe('error');
    expect(entry?.ctx).toMatchObject({ filename: 'app.js', lineno: 10, colno: 5 });
    expect(JSON.stringify(entry?.ctx)).toContain('render blew up');
  });

  it('logs unhandled promise rejections, including non-Error reasons', () => {
    const { target, fire } = fakeTarget();
    installGlobalErrorLogging(target);
    fire('unhandledrejection', { reason: new Error('async fail') });
    fire('unhandledrejection', { reason: 'just a string' });
    const entries = seen.filter((e) => e.msg === 'window.unhandledrejection');
    expect(entries).toHaveLength(2);
    expect(JSON.stringify(entries[0]!.ctx)).toContain('async fail');
    expect(JSON.stringify(entries[1]!.ctx)).toContain('just a string');
  });

  it('installs only once per target', () => {
    const { target, fire } = fakeTarget();
    installGlobalErrorLogging(target);
    installGlobalErrorLogging(target);
    fire('error', { message: 'x', error: new Error('once') });
    expect(seen.filter((e) => e.msg === 'window.error')).toHaveLength(1);
  });
});
