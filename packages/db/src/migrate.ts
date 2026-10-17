import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import type { SqlDriver } from './driver';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

const FILE = /(\d{4})_([a-z0-9_]+)\.sql$/;

// The runner owns the transaction: a migration file may not carry its own (same rule as the C# Migrator).
const FORBIDDEN =
  /^\s*(PRAGMA\b|COMMIT\b|ROLLBACK\b|BEGIN\s+(TRANSACTION|IMMEDIATE|DEFERRED|EXCLUSIVE)\b|BEGIN\s*;)/im;

const normalizeEol = (s: string): string => s.replace(/\r\n/g, '\n');

/** SHA-256 (lowercase hex) of the UTF-8 SQL after CRLF -> LF. Identical to Migrator.Checksum in C#. */
export const checksum = (sql: string): string => bytesToHex(sha256(utf8ToBytes(normalizeEol(sql))));

/** `{ '.../0001_masters.sql': 'CREATE ...' }` (e.g. from import.meta.glob) -> sorted, validated migrations. */
export function migrationsFromFiles(files: Record<string, string>): Migration[] {
  const list: Migration[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const m = FILE.exec(path);
    if (!m) continue;
    const sql = normalizeEol(raw);
    if (FORBIDDEN.test(sql))
      throw new MigrationError(
        `${path}: PRAGMA/BEGIN/COMMIT/ROLLBACK are not allowed; the runner owns the transaction`,
      );
    list.push({ version: Number(m[1]), name: m[2] ?? '', sql });
  }
  list.sort((a, b) => a.version - b.version);
  list.forEach((mig, i) => {
    if (mig.version !== i + 1)
      throw new MigrationError(
        `Migration versions must be contiguous from 0001; found ${String(mig.version)} at position ${String(i + 1)}`,
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
    const known = migrations[i];
    if (!known || known.version !== row.version)
      throw new MigrationError(
        `Database has migration ${String(row.version)} (${row.name}) unknown to this app: database is newer than the app`,
      );
    if (checksum(known.sql) !== row.checksum)
      throw new MigrationError(
        `Migration ${String(row.version)} (${row.name}) was modified after it was applied`,
      );
  });

  const done: number[] = [];
  for (const m of migrations.slice(applied.length)) {
    const script =
      `BEGIN IMMEDIATE;\n${m.sql}\n` +
      `INSERT INTO schema_migrations (version, name, checksum, applied_at) ` +
      `VALUES (${String(m.version)}, '${m.name}', '${checksum(m.sql)}', ${String(Date.now())});\n` +
      'COMMIT;';
    try {
      await driver.exec(script);
    } catch (e) {
      try {
        await driver.exec('ROLLBACK');
      } catch {
        /* nothing to roll back */
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new MigrationError(`Migration ${String(m.version)} (${m.name}) failed: ${msg}`);
    }
    done.push(m.version);
  }
  return done;
}
