import { sha256Hex } from '@pos/core';
import type { SqlDriver } from './types';

export class MigrationError extends Error {
  override name = 'MigrationError';
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const FORBIDDEN =
  /^\s*(PRAGMA\b|COMMIT\b|ROLLBACK\b|BEGIN\s+(TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)\b|BEGIN\s*;)/im;
const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');
export const checksum = (sql: string): string => sha256Hex(normalizeEol(sql));

/** Keys are file paths or names like '0001_masters.sql'; values are file contents. Works for fs (Node) and Vite ?raw globs. */
export function migrationsFromFiles(files: Readonly<Record<string, string>>): Migration[] {
  const list = Object.entries(files).map(([path, raw]): Migration => {
    const file = path.split(/[\\/]/).pop() ?? path;
    const m = FILE_RE.exec(file);
    if (!m) throw new MigrationError(`Bad migration file name: ${file}`);
    const [, version = '', name = ''] = m;
    const sql = normalizeEol(raw);
    if (FORBIDDEN.test(sql))
      throw new MigrationError(
        `${file}: PRAGMA/BEGIN/COMMIT/ROLLBACK are not allowed; the runner owns the transaction`,
      );
    return { version: Number(version), name, sql };
  });
  list.sort((a, b) => a.version - b.version);
  list.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new MigrationError(
        `Migration versions must be contiguous from 0001; found ${m.version} at position ${i + 1}`,
      );
  });
  return list;
}

/** Applies pending migrations, each in its own transaction. Returns the versions applied now. */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly Migration[],
): Promise<number[]> {
  await driver.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
) STRICT;`);
  const applied = await driver.query<{ version: number; name: string; checksum: string }>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  applied.forEach((row, i) => {
    const expected = migrations[i];
    if (!expected || expected.version !== row.version)
      throw new MigrationError(
        `Database has migration ${row.version} (${row.name}) unknown to this app: database is newer than the app`,
      );
    if (checksum(expected.sql) !== row.checksum)
      throw new MigrationError(
        `Migration ${row.version} (${row.name}) was modified after it was applied`,
      );
  });
  const done: number[] = [];
  for (const m of migrations.slice(applied.length)) {
    const script =
      `BEGIN IMMEDIATE;\n${m.sql}\n` +
      `INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (${m.version}, '${m.name}', '${checksum(m.sql)}', ${Date.now()});\n` +
      'COMMIT;';
    try {
      await driver.exec(script);
    } catch (error) {
      await driver.exec('ROLLBACK').catch(() => undefined);
      throw new MigrationError(
        `Migration ${m.version} (${m.name}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    done.push(m.version);
  }
  return done;
}
