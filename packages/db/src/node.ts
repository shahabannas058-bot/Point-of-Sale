import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationsFromFiles, type Migration } from './migrate';
import type { SqlDriver, SqlValue, Statement } from './types';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function loadMigrationsFromDir(dir: string = MIGRATIONS_DIR): Migration[] {
  const files: Record<string, string> = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')))
    files[f] = readFileSync(join(dir, f), 'utf8');
  return migrationsFromFiles(files);
}

export interface NodeSqliteDriver extends SqlDriver {
  close(): void;
}

const wrap = <T>(fn: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    try {
      resolve(fn());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

/** Same pragmas the Rust side must apply. Test-only; the app uses the Tauri driver. */
export function createNodeSqliteDriver(filename = ':memory:'): NodeSqliteDriver {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('recursive_triggers = ON');
  db.pragma('busy_timeout = 5000');

  const run = (sql: string, params: readonly SqlValue[] = []): unknown[] => {
    const stmt = db.prepare(sql);
    if (stmt.reader) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };

  return {
    exec: (script) => wrap(() => void db.exec(script)),
    query: <T extends object>(sql: string, params?: readonly SqlValue[]) =>
      wrap(() => run(sql, params) as T[]),
    batch: (statements: readonly Statement[]) =>
      wrap(() => {
        db.transaction(() => {
          for (const s of statements) run(s.sql, s.params);
        })();
      }),
    close: () => void db.close(),
  };
}
