import { describeError, log } from '@pos/shared';
import type { AppRuntime } from './service/context';

export type BootResult =
  { kind: 'ready'; runtime: AppRuntime } | { kind: 'locked' } | { kind: 'error'; error: unknown };

/** Opens the real service (SQLite via sql.js, persisted in IndexedDB). */
export async function bootstrap(): Promise<BootResult> {
  try {
    // two browser tabs would overwrite each other's database bytes; the desktop shell is one window on a native file
    const { isWebView2 } = await import('./native/webview-bridge');
    const inShell = isWebView2();
    if (!inShell) {
      const { acquireTabLock } = await import('./db/browser-db');
      if (!(await acquireTabLock())) {
        log.info('boot.locked');
        return { kind: 'locked' };
      }
    }
    const { createRealRuntime } = await import('./service/real');
    const runtime = await createRealRuntime();
    log.info('boot.ready', { inShell });
    return { kind: 'ready', runtime };
  } catch (error) {
    log.error('boot.failed', { error: describeError(error) });
    return { kind: 'error', error };
  }
}

/** The part of `window` the global handlers need; a parameter so tests can pass a fake. */
export interface ErrorEventTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

interface ErrorEventLike {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  error?: unknown;
}
interface RejectionEventLike {
  reason?: unknown;
}

const installed = new WeakSet<ErrorEventTarget>();

/**
 * Logs uncaught exceptions and unhandled promise rejections so a shopkeeper's "it did not work" leaves a trace
 * in the ring buffer. Installs once per target; never throws.
 */
export function installGlobalErrorLogging(target: ErrorEventTarget): void {
  if (installed.has(target)) return;
  installed.add(target);
  target.addEventListener('error', (event) => {
    const ev = (event ?? {}) as ErrorEventLike;
    log.error('window.error', {
      message: typeof ev.message === 'string' ? ev.message : undefined,
      filename: typeof ev.filename === 'string' ? ev.filename : undefined,
      lineno: typeof ev.lineno === 'number' ? ev.lineno : undefined,
      colno: typeof ev.colno === 'number' ? ev.colno : undefined,
      error: ev.error === undefined ? undefined : describeError(ev.error),
    });
  });
  target.addEventListener('unhandledrejection', (event) => {
    const ev = (event ?? {}) as RejectionEventLike;
    log.error('window.unhandledrejection', { reason: describeError(ev.reason) });
  });
}
