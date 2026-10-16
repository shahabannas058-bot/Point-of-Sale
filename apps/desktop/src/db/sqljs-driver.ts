import type { BindParams, Database } from 'sql.js';
import type { SqlDriver, SqlValue, Statement } from '@pos/db';

export interface SqlJsDriver extends SqlDriver {
  /** Serialises the database (used by backup/export). Re-applies pragmas afterwards. */
  exportBytes(): Uint8Array;
  close(): void;
}

const PRAGMAS = 'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;';

/**
 * SqlDriver over a sql.js Database. Pure and Vite-free so it can be unit-tested in Node.
 *
 * - `batch` is one atomic transaction (BEGIN IMMEDIATE ... COMMIT, ROLLBACK on any error).
 * - After every write, `persist(bytes)` is awaited, so a resolved sale is durable. Concurrent writes
 *   are coalesced into a single export/put.
 * - `db.export()` resets connection pragmas, so they are re-applied after each export.
 */
export function createSqlJsDriver(
  db: Database,
  persist?: (bytes: Uint8Array) => Promise<void>,
): SqlJsDriver {
  const applyPragmas = (): void => {
    db.exec(PRAGMAS);
  };
  applyPragmas();

  let chain: Promise<void> = Promise.resolve();
  let queued: Promise<void> | null = null;

  const persistNow = (): Promise<void> => {
    if (!persist) return Promise.resolve();
    if (queued) return queued;
    const run = chain.then(async () => {
      queued = null; // later writers start a fresh export so their changes are included
      const bytes = db.export();
      applyPragmas();
      await persist(bytes);
    });
    queued = run;
    chain = run.catch(() => undefined);
    return run;
  };

  return {
    async exec(script) {
      db.exec(script);
      await persistNow();
    },
    query<T extends object = Record<string, SqlValue>>(
      sql: string,
      params: readonly SqlValue[] = [],
    ): Promise<T[]> {
      try {
        const st = db.prepare(sql);
        try {
          if (params.length > 0) st.bind([...params] as BindParams);
          const rows: T[] = [];
          while (st.step()) rows.push(st.getAsObject() as T);
          return Promise.resolve(rows);
        } finally {
          st.free();
        }
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    async batch(statements: readonly Statement[]) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of statements) db.run(s.sql, (s.params ?? []) as BindParams);
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* no transaction left to roll back */
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
      await persistNow();
    },
    exportBytes() {
      const bytes = db.export();
      applyPragmas();
      return bytes;
    },
    close() {
      db.close();
    },
  };
}
