/* REAL SERVICE: @pos/db/service on top of sql.js (IndexedDB-persisted) in the browser.
   Tauri will later swap the driver for the Rust/SQLite one without touching the UI. */
import { createPosService, seedDemoData } from '@pos/db/service';
import { openBrowserDb, resetBrowserDb } from '../db/browser-db';
import type { SqlJsDriver } from '../db/sqljs-driver';
import type { AppRuntime } from './context';

/**
 * Opens the database, runs migrations and returns the runtime.
 * An empty database is filled with demo data unless the URL has `?fresh=1`
 * (then the first-run wizard is shown, with its own "Load demo data" button).
 */
export async function createRealRuntime(): Promise<AppRuntime> {
  let driver: SqlJsDriver = await openBrowserDb();
  let service = createPosService({ driver });

  const wantsFresh = new URLSearchParams(window.location.search).has('fresh');
  if (!wantsFresh && !(await service.setup.isSetUp())) {
    await seedDemoData({ driver });
    service = createPosService({ driver });
  }

  return {
    get service() {
      return service;
    },
    mode: 'real',
    exportBytes: () => driver.exportBytes(),
    resetDemo: async () => {
      driver.close();
      await resetBrowserDb();
      driver = await openBrowserDb({ fresh: true });
      await seedDemoData({ driver });
      service = createPosService({ driver });
    },
    loadDemo: async () => {
      await seedDemoData({ driver });
      service = createPosService({ driver });
    },
  };
}
