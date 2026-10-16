import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { del, get, set } from 'idb-keyval';
import { migrate, migrationsFromFiles } from '@pos/db';
import { createSqlJsDriver, type SqlJsDriver } from './sqljs-driver';

const DB_KEY = 'pos-db-v1';

// Migrations are bundled as raw text (same files the Node tests and the future Rust side use).
const migrationFiles = import.meta.glob<string>('../../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;
const loadSql = (): ReturnType<typeof initSqlJs> => {
  sqlPromise ??= initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
};

/**
 * Opens (or creates) the browser database. Bytes live in IndexedDB under one key; every committed
 * write is persisted before its promise resolves. `fresh` ignores any stored bytes (demo reset).
 */
export async function openBrowserDb(opts: { fresh?: boolean } = {}): Promise<SqlJsDriver> {
  const SQL = await loadSql();
  const stored = opts.fresh ? undefined : await get<Uint8Array>(DB_KEY);
  const db = stored ? new SQL.Database(stored) : new SQL.Database();
  const driver = createSqlJsDriver(db, (bytes) => set(DB_KEY, bytes));
  await migrate(driver, migrationsFromFiles(migrationFiles));
  return driver;
}

/** Removes the persisted database. The caller must close any open driver first. */
export async function resetBrowserDb(): Promise<void> {
  await del(DB_KEY);
}

/**
 * Two tabs would overwrite each other's blob, so only one may own the database.
 * Resolves true when this tab got the lock (held until the tab closes).
 */
export function acquireTabLock(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !('locks' in navigator)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    void navigator.locks.request('pos-db-owner', { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      resolve(true);
      return new Promise<void>(() => undefined); // never settles: lock lives as long as the tab
    });
  });
}
