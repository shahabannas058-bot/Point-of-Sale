import { createContext, useContext, type ReactNode } from 'react';
import type { BusinessType, PosService } from '@pos/shared';

export interface AppRuntime {
  service: PosService;
  /** Raw database bytes for the backup button (real mode only). */
  exportBytes?: () => Uint8Array;
  /**
   * Wipes demo data and reseeds. Resolves when the app should navigate to /login.
   * Absent in the desktop shell, where the real database can never be wiped from the page.
   */
  resetDemo?: () => Promise<void>;
  /**
   * Replaces the whole database with a checked backup file; the caller reloads the page afterwards.
   * Absent in the desktop shell, which owns pos.db and restores backups itself.
   */
  restore?: (bytes: Uint8Array) => Promise<void>;
  /** First-run only: fills an empty database with the demo shop ('kiryana' = grocery demo, else mobile shop). */
  loadDemo: (businessType?: BusinessType) => Promise<void>;
}

const Ctx = createContext<AppRuntime | null>(null);

export function RuntimeProvider({
  runtime,
  children,
}: {
  runtime: AppRuntime;
  children: ReactNode;
}): ReactNode {
  return <Ctx.Provider value={runtime}>{children}</Ctx.Provider>;
}

export function useRuntime(): AppRuntime {
  const v = useContext(Ctx);
  if (!v) throw new Error('RuntimeProvider missing');
  return v;
}

export function useService(): PosService {
  return useRuntime().service;
}
