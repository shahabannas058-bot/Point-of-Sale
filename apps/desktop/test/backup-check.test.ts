import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { checksum, migrate, migrationsFromFiles, type Migration } from '@pos/db';
import { createPosService } from '@pos/db/service';
import {
  BackupError,
  checkBackupCompat,
  isBackupError,
  validateBackup,
  type AppliedMigrationRow,
} from '../src/db/backup-check';
import { createSqlJsDriver } from '../src/db/sqljs-driver';

const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const bundled = migrationsFromFiles(files);

const mig = (version: number, sql: string): Migration => ({ version, name: `m${version}`, sql });
const row = (m: Migration, over: Partial<AppliedMigrationRow> = {}): AppliedMigrationRow => ({
  version: m.version,
  name: m.name,
  checksum: checksum(m.sql),
  ...over,
});
const app = [mig(1, 'CREATE TABLE a (id INTEGER);'), mig(2, 'CREATE TABLE b (id INTEGER);')];

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return isBackupError(e) ? e.code : 'other';
  }
};

describe('checkBackupCompat', () => {
  it('accepts a backup at the same version', () => {
    expect(
      codeOf(() =>
        checkBackupCompat(
          app.map((m) => row(m)),
          app,
        ),
      ),
    ).toBeNull();
  });

  it('accepts an older backup (migrate() upgrades it on the next open)', () => {
    expect(codeOf(() => checkBackupCompat([row(app[0]!)], app))).toBeNull();
    expect(codeOf(() => checkBackupCompat([], app))).toBeNull();
  });

  it('refuses a backup newer than the app', () => {
    const newer = [...app.map((m) => row(m)), row(mig(3, 'CREATE TABLE c (id INTEGER);'))];
    expect(codeOf(() => checkBackupCompat(newer, app))).toBe('BACKUP_NEWER');
  });

  it('refuses a backup whose applied migrations differ from the bundled ones', () => {
    const changed = [row(app[0]!), row(app[1]!, { checksum: 'abc' })];
    expect(codeOf(() => checkBackupCompat(changed, app))).toBe('BACKUP_INCOMPATIBLE');
    const renamed = [row(app[0]!), row(app[1]!, { name: 'other' })];
    expect(codeOf(() => checkBackupCompat(renamed, app))).toBe('BACKUP_INCOMPATIBLE');
    const gap = [row(app[0]!, { version: 2 })];
    expect(codeOf(() => checkBackupCompat(gap, app))).toBe('BACKUP_INCOMPATIBLE');
  });
});

describe('validateBackup (sql.js)', () => {
  async function exportedShop(): Promise<Uint8Array> {
    const SQL = await initSqlJs();
    const driver = createSqlJsDriver(new SQL.Database());
    await migrate(driver, bundled);
    await createPosService({ driver, pinIterations: 1000 }).setup.firstRun({
      shopName: 'Bismillah Kiryana',
      branchName: 'Main',
      invoicePrefix: 'B',
      owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
      businessType: 'kiryana',
    });
    return driver.exportBytes();
  }

  it('round-trips: an exported database validates and reopens with the same shop name', async () => {
    const SQL = await initSqlJs();
    const bytes = await exportedShop();
    expect(() => validateBackup(SQL, bytes, bundled)).not.toThrow();
    const reopened = createSqlJsDriver(new SQL.Database(bytes));
    await migrate(reopened, bundled);
    const shop = await createPosService({ driver: reopened }).setup.getShop();
    expect(shop.shopName).toBe('Bismillah Kiryana');
  });

  it('refuses bytes that are not an SQLite file', async () => {
    const SQL = await initSqlJs();
    const bytes = new TextEncoder().encode('brand,name,sku\nLoose,Chini,CHINI\n');
    expect(codeOf(() => validateBackup(SQL, bytes, bundled))).toBe('BACKUP_NOT_DATABASE');
  });

  it('refuses an SQLite file that is not a POS database', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT)');
    const bytes = db.export();
    expect(codeOf(() => validateBackup(SQL, bytes, bundled))).toBe('BACKUP_NOT_DATABASE');
  });

  it('refuses a database whose migrations the app does not know', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database(await exportedShop());
    db.exec(
      "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 1)",
    );
    const bytes = db.export();
    expect(codeOf(() => validateBackup(SQL, bytes, bundled))).toBe('BACKUP_NEWER');
  });

  it('refuses a damaged file', async () => {
    const SQL = await initSqlJs();
    const bytes = await exportedShop();
    const damaged = new Uint8Array(bytes);
    // keep the 100-byte header so sql.js opens it, then wreck the second page's b-tree content
    damaged.fill(0xff, 4096 + 8, 4096 * 2);
    expect(() => validateBackup(SQL, damaged, bundled)).toThrow(BackupError);
  });
});
