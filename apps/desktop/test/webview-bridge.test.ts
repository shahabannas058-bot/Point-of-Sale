import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consoleSink, setLogSink, type LogEntry } from '@pos/shared';

interface Sent {
  id: string;
  method: string;
  payload: unknown;
}

/**
 * One fake window.chrome.webview for the whole file: the bridge registers its 'message' listener once per
 * module instance, so the host must stay the same object across tests.
 */
const sent: Sent[] = [];
let listener: ((ev: { data: unknown }) => void) | undefined;
const webview = {
  postMessage: (m: unknown) => sent.push(m as Sent),
  addEventListener: (_t: string, l: (ev: { data: unknown }) => void) => {
    listener = l;
  },
};
const reply = (data: unknown): void => listener?.({ data });

let seen: LogEntry[] = [];

beforeAll(() => vi.stubGlobal('window', { chrome: { webview } }));
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  seen = [];
  setLogSink((e) => seen.push(e));
});
afterEach(() => {
  setLogSink(consoleSink);
  vi.useRealTimers();
});

describe('webview bridge logging', () => {
  it('logs a timeout with the request id and method, then logs the late reply', async () => {
    // Arrange
    const { call } = await import('../src/native/webview-bridge');

    // Act
    const p = call<string>('ping', undefined, 1000);
    const rejection = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1001);
    const err = (await rejection) as { code: string };
    const id = sent[0]!.id;
    reply({ id, ok: true, data: 'pong' });

    // Assert
    expect(err.code).toBe('INTERNAL');
    const timeout = seen.find((e) => e.msg === 'bridge.timeout');
    expect(timeout?.level).toBe('warn');
    expect(timeout?.ctx).toMatchObject({ id, method: 'ping', timeoutMs: 1000 });
    const late = seen.find((e) => e.msg === 'bridge.lateReply');
    expect(late?.level).toBe('warn');
    expect(late?.ctx).toMatchObject({ id, method: 'ping', ok: true });
  });

  it('does not log a reply that arrives in time and ignores replies that were never ours', async () => {
    const { call } = await import('../src/native/webview-bridge');
    const p = call<string>('ping');
    reply({ id: sent[0]!.id, ok: true, data: 'pong' });
    await expect(p).resolves.toBe('pong');
    reply({ id: 'not-ours', ok: true, data: 1 });
    expect(seen.filter((e) => e.level === 'warn' || e.level === 'error')).toHaveLength(0);
  });

  it('logs host-fault replies (INTERNAL) with method and code but never the payload', async () => {
    const { call } = await import('../src/native/webview-bridge');
    const p = call<string>('checkout.commit', { input: { pin: '1234' }, cashierId: 'u1' });
    const rejection = p.catch((e: unknown) => e);
    reply({
      id: sent[0]!.id,
      ok: false,
      error: { code: 'INTERNAL', message: 'boom', details: { pin: '1234' } },
    });
    const err = (await rejection) as { code: string };
    expect(err.code).toBe('INTERNAL');
    const entry = seen.find((e) => e.msg === 'bridge.error');
    expect(entry?.ctx).toMatchObject({ method: 'checkout.commit', code: 'INTERNAL' });
    expect(JSON.stringify(seen)).not.toContain('1234');
  });
});
