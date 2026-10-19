import type { Database, SqlJsStatic } from 'sql.js';
import { checksum, type Migration } from '@pos/db';

/**
 * Checks a backup file before it replaces the shop database. Vite-free so it runs in Node tests. These codes are
 * not ServiceError codes (that list is the shared contract and ties to the service); `errorMessage()` maps them to
 * `err.<CODE>` the same way.
 */
export const BACKUP_ERROR_CODES = [
  'BACKUP_NOT_DATABASE',
  'BACKUP_CORRUPT',
  'BACKUP_NEWER',
  'BACKUP_INCOMPATIBLE',
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

export class BackupError extends Error {
  override name = 'BackupError';
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message);
  }
}
export const isBackupError = (e: unknown): e is BackupError => e instanceof BackupError;

export interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * The backup's applied migrations must be a prefix of the app's bundled ones (same version, name and checksum):
 * an older backup is fine (migrate() upgrades it on the next open); a newer or a differently-built one is refused.
 */
export function checkBackupCompat(
  applied: readonly AppliedMigrationRow[],
  bundled: readonly Migration[],
): void {
  applied.forEach((row, i) => {
    const expected = bundled[i];
    if (expected === undefined)
      throw new BackupError(
        'BACKUP_NEWER',
        `Backup has migration ${row.version} (${row.name}) unknown to this app`,
      );
    const same =
      expected.version === row.version &&
      expected.name === row.name &&
      checksum(expected.sql) === row.checksum;
    if (!same)
      throw new BackupError(
        'BACKUP_INCOMPATIBLE',
        `Backup migration ${row.version} (${row.name}) differs from the app's ${expected.version} (${expected.name})`,
      );
  });
}

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const SQLITE_HEADER_BYTES = 100;

export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_HEADER_BYTES) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1)
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  return true;
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `PRAGMA integrity_check` must answer exactly "ok"; an engine error while reading pages is also damage. */
function checkIntegrity(db: Database): void {
  let answers: unknown[];
  try {
    answers = (db.exec('PRAGMA integrity_check')[0]?.values ?? []).map((v) => v[0]);
  } catch (e) {
    throw new BackupError('BACKUP_CORRUPT', `integrity_check failed: ${describe(e)}`);
  }
  if (answers.length !== 1 || answers[0] !== 'ok')
    throw new BackupError('BACKUP_CORRUPT', `integrity_check: ${answers.map(String).join('; ')}`);
}

/** The POS schema_migrations rows; an SQLite file without that table is some other program's database. */
export function readAppliedMigrations(db: Database): AppliedMigrationRow[] {
  let values: unknown[][];
  try {
    values =
      db.exec('SELECT version, name, checksum FROM schema_migrations ORDER BY version')[0]
        ?.values ?? [];
  } catch (e) {
    throw new BackupError('BACKUP_NOT_DATABASE', `no schema_migrations: ${describe(e)}`);
  }
  return values.map((v) => ({
    version: Number(v[0]),
    name: String(v[1]),
    checksum: String(v[2]),
  }));
}

/** Throws a BackupError unless `bytes` is an intact POS database this app can open. */
export function validateBackup(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  bundled: readonly Migration[],
): void {
  if (!hasSqliteHeader(bytes))
    throw new BackupError('BACKUP_NOT_DATABASE', 'The file does not start with the SQLite header');
  const db = new SQL.Database(bytes);
  try {
    checkIntegrity(db);
    checkBackupCompat(readAppliedMigrations(db), bundled);
  } finally {
    db.close();
  }
}
