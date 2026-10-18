/* REAL SERVICE: the TypeScript PosService from @pos/db on a database host.
   Browser (development, tests): sql.js, persisted in IndexedDB.
   Desktop shell (ADR-0010): the native pos.db through the WebView2 bridge. */
import { openBrowserDb, resetBrowserDb } from '../db/browser-db';
import type { SqlJsDriver } from '../db/sqljs-driver';
import { createWebViewDriver } from '../db/webview-driver';
import { isWebView2 } from '../native/webview-bridge';
import type { AppRuntime } from './context';
import { createRuntime, type DbHandle, type DbHost } from './runtime';

function browserHost(): DbHost {
  let current: SqlJsDriver | null = null;
  const handle = (driver: SqlJsDriver): DbHandle => {
    current = driver;
    return { driver, exportBytes: () => driver.exportBytes() };
  };
  return {
    open: async () => handle(await openBrowserDb()),
    reset: async () => {
      current?.close();
      await resetBrowserDb();
      return handle(await openBrowserDb({ fresh: true }));
    },
  };
}

/**
 * C# has already created, checked and migrated pos.db (and takes the daily backup) before the page loads, so there is
 * no migrate() here, no raw export and no reset: the real database is never wiped from the page.
 */
const shellHost: DbHost = {
  open: () => Promise.resolve({ driver: createWebViewDriver() }),
};

/**
 * Opens the database and returns the runtime.
 * In the browser an empty database is filled with the kiryana demo unless the URL has `?fresh=1`.
 * In the desktop shell an empty database always shows the first-run wizard (which has its own "Load demo data" button).
 */
export function createRealRuntime(): Promise<AppRuntime> {
  if (isWebView2()) return createRuntime(shellHost, { fresh: true });
  const fresh = new URLSearchParams(window.location.search).has('fresh');
  return createRuntime(browserHost(), { fresh });
}
