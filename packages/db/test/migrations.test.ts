import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationError,
  checksum,
  migrate,
  migrationsFromFiles,
  type Migration,
} from '../src/index';
import { createNodeSqliteDriver, loadMigrationsFromDir, type NodeSqliteDriver } from '../src/node';

const open: NodeSqliteDriver[] = [];
const freshDriver = (): NodeSqliteDriver => {
  const db = createNodeSqliteDriver();
  open.push(db);
  return db;
};
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

describe('migration runner', () => {
  it('applies versions 1-7, records them, and is idempotent', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    expect(await migrate(db, migrations)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const rows = await db.query<{ version: number; name: string; checksum: string }>(
      'select version, name, checksum from schema_migrations order by version',
    );
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.name)).toEqual([
      'masters',
      'stock',
      'sales_ledger',
      'outbox',
      'repairs_warranty',
      'weighted_units',
      'batch_expiry',
    ]);
    rows.forEach((r, i) => expect(r.checksum).toBe(checksum(migrations[i]!.sql)));

    expect(await migrate(db, migrations)).toEqual([]);
    expect(await db.query('select 1 from schema_migrations')).toHaveLength(7);
  });

  it('applies only the missing migrations when the app gets newer', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    expect(await migrate(db, migrations.slice(0, 2))).toEqual([1, 2]);
    expect(await migrate(db, migrations)).toEqual([3, 4, 5, 6, 7]);
  });

  it('refuses a migration whose SQL changed after it was applied', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    await migrate(db, migrations);
    const edited: Migration[] = migrations.map((m, i) =>
      i === 0 ? { ...m, sql: `${m.sql}\n-- sneaky edit` } : m,
    );
    await expect(migrate(db, edited)).rejects.toThrow(/modified after it was applied/);
  });

  it('refuses a database that is newer than the app', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    await migrate(db, migrations);
    await db.query(
      "insert into schema_migrations (version, name, checksum, applied_at) values (8, 'future', 'x', 0)",
    );
    const rejection = migrate(db, migrations);
    await expect(rejection).rejects.toThrow(/newer than the app/);
    await expect(rejection).rejects.toBeInstanceOf(MigrationError);
  });

  it('rolls back a broken migration completely (no table, no version row)', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    await migrate(db, migrations);
    const broken: Migration = {
      version: 8,
      name: 'broken',
      sql: 'CREATE TABLE should_not_survive (id INTEGER PRIMARY KEY);\nTHIS IS NOT VALID SQL;',
    };
    await expect(migrate(db, [...migrations, broken])).rejects.toThrow(
      /Migration 8 \(broken\) failed/,
    );
    const tables = await db.query(
      "select name from sqlite_master where name = 'should_not_survive'",
    );
    expect(tables).toEqual([]);
    expect(await db.query('select * from schema_migrations where version = 8')).toEqual([]);
    // and the runner is still usable afterwards
    expect(await migrate(db, migrations)).toEqual([]);
  });

  it('a failed migration can be retried after it is fixed', async () => {
    const db = freshDriver();
    const migrations = loadMigrationsFromDir();
    await migrate(db, migrations);
    const broken: Migration = { version: 8, name: 'extra', sql: 'CREATE TABLE a (;' };
    await expect(migrate(db, [...migrations, broken])).rejects.toBeInstanceOf(MigrationError);
    const fixed: Migration = { ...broken, sql: 'CREATE TABLE a (id INTEGER PRIMARY KEY) STRICT;' };
    expect(await migrate(db, [...migrations, fixed])).toEqual([8]);
  });
});

describe('migrationsFromFiles', () => {
  const ok = 'CREATE TABLE t (id INTEGER PRIMARY KEY);';

  it('sorts by version and strips directories from paths', () => {
    const list = migrationsFromFiles({
      'C:\\x\\0002_b.sql': ok,
      '/y/0001_a.sql': ok,
    });
    expect(list.map((m) => [m.version, m.name])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });

  it('throws on a bad file name', () => {
    expect(() => migrationsFromFiles({ 'init.sql': ok })).toThrow(/Bad migration file name/);
    expect(() => migrationsFromFiles({ '1_init.sql': ok })).toThrow(/Bad migration file name/);
    expect(() => migrationsFromFiles({ '0001_Init.sql': ok })).toThrow(/Bad migration file name/);
  });

  it('throws on a gap (0001, 0003) and on a list that does not start at 0001', () => {
    expect(() => migrationsFromFiles({ '0001_a.sql': ok, '0003_c.sql': ok })).toThrow(/contiguous/);
    expect(() => migrationsFromFiles({ '0002_b.sql': ok })).toThrow(/contiguous/);
  });

  it.each([
    'PRAGMA foreign_keys = OFF;',
    'COMMIT;',
    'ROLLBACK;',
    'BEGIN TRANSACTION;',
    'BEGIN;',
    'begin immediate;',
  ])('throws on a file containing %s', (statement) => {
    expect(() => migrationsFromFiles({ '0001_x.sql': `${ok}\n${statement}\n` })).toThrow(
      /not allowed/,
    );
  });

  it('does not mistake a trigger body BEGIN or a comment for a transaction statement', () => {
    const trigger = `CREATE TRIGGER trg AFTER INSERT ON t\nBEGIN SELECT 1; END;`;
    expect(() => migrationsFromFiles({ '0001_x.sql': `${ok}\n${trigger}` })).not.toThrow();
  });

  it('CRLF and LF versions of the same file get the same checksum', () => {
    const lf = 'CREATE TABLE t (\n  id INTEGER PRIMARY KEY\n);\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(checksum(crlf)).toBe(checksum(lf));
    const [fromLf] = migrationsFromFiles({ '0001_t.sql': lf });
    const [fromCrlf] = migrationsFromFiles({ '0001_t.sql': crlf });
    expect(checksum(fromCrlf!.sql)).toBe(checksum(fromLf!.sql));
    expect(fromCrlf!.sql).toBe(fromLf!.sql);
  });

  it('different SQL gives a different checksum', () => {
    expect(checksum('SELECT 1;')).not.toBe(checksum('SELECT 2;'));
  });
});

describe('migrated schema', () => {
  const migrated = async (): Promise<NodeSqliteDriver> => {
    const db = freshDriver();
    await migrate(db, loadMigrationsFromDir());
    return db;
  };

  it('has no foreign key violations', async () => {
    const db = await migrated();
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('runs on SQLite 3.37 or later (STRICT tables)', async () => {
    const db = await migrated();
    const [row] = await db.query<{ v: string }>('select sqlite_version() as v');
    const [major = 0, minor = 0] = (row?.v ?? '0.0').split('.').map(Number);
    expect(major > 3 || (major === 3 && minor >= 37)).toBe(true);
  });

  it('creates the expected tables, views and protection triggers', async () => {
    const db = await migrated();
    const names = async (type: string): Promise<string[]> =>
      (
        await db.query<{ name: string }>(
          'select name from sqlite_master where type = ? and name not like ? order by name',
          [type, 'sqlite_%'],
        )
      ).map((r) => r.name);
    expect(await names('table')).toEqual(
      [
        'accessory_variants',
        'app_meta',
        'branches',
        'customers',
        'ledger_entries',
        'outbox',
        'payments',
        'phone_units',
        'products',
        'purchases',
        'repair_parts',
        'repair_payments',
        'repair_status_history',
        'repair_tickets',
        'sale_lines',
        'sales',
        'schema_migrations',
        'stock_batches',
        'stock_movements',
        'suppliers',
        'users',
        'warranties',
      ].sort(),
    );
    expect(await names('view')).toEqual([
      'v_customer_balance',
      'v_phone_unit_on_hand',
      'v_sale_line_mismatch',
      'v_sale_payment_mismatch',
      'v_supplier_balance',
      'v_variant_on_hand',
    ]);
    const triggers = await names('trigger');
    for (const expected of [
      'trg_sales_no_update',
      'trg_sales_no_delete',
      'trg_sales_chain_guard',
      'trg_stock_movements_no_update',
      'trg_stock_movements_no_delete',
      'trg_stock_movements_unit_guard',
      'trg_outbox_frozen',
      'trg_outbox_no_delete_unsent',
      'repair_tickets_identity_fixed',
      'repair_payments_no_update',
      'warranties_no_delete',
      'warranties_unit_on_sale', // dropped and recreated by 0006: must still exist
      'trg_sale_lines_no_update',
      'trg_sale_lines_no_delete',
      'trg_sale_lines_unit_scale',
      'trg_variants_unit_insert',
      'trg_variants_unit_update',
      'trg_stock_batches_no_update',
      'trg_stock_batches_no_delete',
      'trg_stock_movements_batch_guard',
    ])
      expect(triggers).toContain(expected);
  });

  it('the test driver applies the pragmas the app relies on', async () => {
    const db = await migrated();
    const pragma = async (name: string): Promise<unknown> => {
      const [row] = await db.query<Record<string, unknown>>(`PRAGMA ${name}`);
      return row ? Object.values(row)[0] : undefined;
    };
    expect(await pragma('foreign_keys')).toBe(1);
    expect(await pragma('recursive_triggers')).toBe(1);
    expect(await pragma('busy_timeout')).toBe(5000);
  });

  it('a second driver on the same schema starts empty', async () => {
    const db = await migrated();
    for (const table of ['sales', 'stock_movements', 'ledger_entries', 'outbox'])
      expect(await db.query(`select 1 from ${table}`)).toEqual([]);
  });
});
