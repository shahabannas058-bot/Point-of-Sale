import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrate, migrationsFromFiles, type SqlDriver } from '../src';

/** SqlDriver over better-sqlite3 (in-memory), same contract as the sql.js and WebView2 drivers. */
export function createNodeDriver(
  db = new Database(':memory:'),
): SqlDriver & { raw: Database.Database } {
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  const attempt = <T>(fn: () => T): Promise<T> => {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
  return {
    raw: db,
    exec: (script) => attempt(() => void db.exec(script)),
    query: <T extends object>(sql: string, params: readonly unknown[] = []) =>
      attempt(() => {
        const st = db.prepare(sql);
        return (st.reader ? st.all(...params) : (st.run(...params), [])) as T[];
      }),
    batch: (statements) =>
      attempt(() => {
        db.transaction(() => {
          for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
        }).immediate();
      }),
  };
}

export const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');

export function loadMigrationFiles(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => [f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')]),
  );
}

export async function migratedDriver(): Promise<ReturnType<typeof createNodeDriver>> {
  const driver = createNodeDriver();
  await migrate(driver, migrationsFromFiles(loadMigrationFiles()));
  return driver;
}
