import type { AppRuntime } from './service/context';
import { createDemoMockPosService } from './service/mock';

export type BootResult =
  { kind: 'ready'; runtime: AppRuntime } | { kind: 'locked' } | { kind: 'error'; error: unknown };

async function createMockRuntime(): Promise<AppRuntime> {
  let service = await createDemoMockPosService();
  const runtime: AppRuntime = {
    get service() {
      return service;
    },
    mode: 'mock',
    resetDemo: async () => {
      service = await createDemoMockPosService();
    },
    loadDemo: async () => {
      service = await createDemoMockPosService();
    },
  };
  return runtime;
}

/**
 * Real service (SQLite via sql.js) is the default; `?mock=1` forces the in-memory mock.
 */
export async function bootstrap(): Promise<BootResult> {
  try {
    const useMock = new URLSearchParams(window.location.search).has('mock');
    if (!useMock) {
      const { acquireTabLock } = await import('./db/browser-db');
      if (!(await acquireTabLock())) return { kind: 'locked' };
      const { createRealRuntime } = await import('./service/real');
      return { kind: 'ready', runtime: await createRealRuntime() };
    }
    return { kind: 'ready', runtime: await createMockRuntime() };
  } catch (error) {
    return { kind: 'error', error };
  }
}
