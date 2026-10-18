import type { AppRuntime } from './service/context';

export type BootResult =
  { kind: 'ready'; runtime: AppRuntime } | { kind: 'locked' } | { kind: 'error'; error: unknown };

/** Opens the real service (SQLite via sql.js, persisted in IndexedDB). */
export async function bootstrap(): Promise<BootResult> {
  try {
    // two browser tabs would overwrite each other's database bytes; the desktop shell is one window on a native file
    const { isWebView2 } = await import('./native/webview-bridge');
    if (!isWebView2()) {
      const { acquireTabLock } = await import('./db/browser-db');
      if (!(await acquireTabLock())) return { kind: 'locked' };
    }
    const { createRealRuntime } = await import('./service/real');
    return { kind: 'ready', runtime: await createRealRuntime() };
  } catch (error) {
    return { kind: 'error', error };
  }
}
