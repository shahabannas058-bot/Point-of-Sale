import type { BindParams, Database } from 'sql.js';
import type { SqlDriver, SqlValue, Statement } from '@pos/db';

export interface SqlJsDriver extends SqlDriver {
  /** Serialises the database (used by backup/export). Re-applies pragmas afterwards. */
  exportBytes(): Uint8Array;
  close(): void;
}

const PRAGMAS = 'PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON;';

/** Where the bytes go after each write, and how to rebuild the database from bytes saved earlier. */
export interface SqlJsPersistence {
  save(bytes: Uint8Array): Promise<void>;
  reopen(bytes: Uint8Array): Database;
}

/**
 * SqlDriver over a sql.js Database. Pure and Vite-free so it can be unit-tested in Node.
 *
 * - `batch` is one atomic transaction (BEGIN IMMEDIATE ... COMMIT, ROLLBACK on any error).
 * - After every write, `persist.save(bytes)` is awaited, so a resolved sale is durable. Concurrent writes
 *   are coalesced into a single export/put.
 * - When a save fails, the in-memory database goes back to the last saved bytes before the error is thrown:
 *   a write reported as failed must not be stored later by the next write (a retry would store it twice).
 *   Writes waiting on that save are rejected as well, since their changes went with it.
 * - `db.export()` resets connection pragmas, so they are re-applied after each export.
 */
export function createSqlJsDriver(initial: Database, persist?: SqlJsPersistence): SqlJsDriver {
  let db = initial;
  const applyPragmas = (): void => {
    db.exec(PRAGMAS);
  };
  const exportNow = (): Uint8Array => {
    const bytes = db.export();
    applyPragmas();
    return bytes;
  };
  applyPragmas();

  let saved = persist ? exportNow() : null; // the bytes the store holds (or will hold) as far as we know
  let restores = 0;
  let chain: Promise<void> = Promise.resolve();
  let queued: Promise<void> | null = null;

  const restoreSaved = (store: SqlJsPersistence, good: Uint8Array): void => {
    db.close();
    db = store.reopen(good);
    applyPragmas();
    restores += 1;
    queued = null; // writes after the restore start a fresh save
  };

  const persistNow = (): Promise<void> => {
    if (!persist) return Promise.resolve();
    if (queued) return queued;
    const restoresAtQueue = restores;
    const run = chain.then(async () => {
      queued = null; // later writers start a fresh export so their changes are included
      if (restores !== restoresAtQueue) throw new Error('write undone: an earlier save failed');
      const bytes = exportNow();
      try {
        await persist.save(bytes);
        saved = bytes;
      } catch (e) {
        if (saved) restoreSaved(persist, saved);
        throw e;
      }
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
      return exportNow();
    },
    close() {
      db.close();
    },
  };
}
