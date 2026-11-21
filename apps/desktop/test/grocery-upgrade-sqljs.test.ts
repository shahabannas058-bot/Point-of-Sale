import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import {
  migrate,
  migrationsFromFiles,
  type SqlDriver,
  type SqlValue,
  type Statement,
} from '@pos/db';
import { createPosService, seedDemoData } from '@pos/db/service';
import { isGroceryUpgradeRefused } from '../src/bootstrap';
import { createOwnerPinCheck, legacyActions } from '../src/db/legacy-gate';
import { createSqlJsDriver, type SqlJsDriver } from '../src/db/sqljs-driver';

/**
 * Migration 0009 (accessory_variants -> items, phone / repair / warranty tables dropped) on sql.js, the engine a
 * browser database is opened with. A kiryana database on 0008 must keep its data and keep selling; one that still
 * holds mobile-shop data must be refused and stay on 0008.
 */
const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const ALL = migrationsFromFiles(files);
const UP_TO_8 = ALL.filter((m) => m.version <= 8);
const PIN_ITERATIONS = 1000;

/**
 * Lets today's service write into a 0008 database, where items were `accessory_variants` and the column `variant_id`
 * (same idea as packages/db/test/legacy-driver.ts).
 */
const toLegacySql = (sql: string): string =>
  sql.replace(/\bitems\b/g, 'accessory_variants').replace(/\bitem_id\b/g, 'variant_id');
const legacy = (inner: SqlDriver): SqlDriver => ({
  exec: (script) => inner.exec(toLegacySql(script)),
  query: async <T extends object = Record<string, SqlValue>>(
    sql: string,
    params?: readonly SqlValue[],
  ): Promise<T[]> => {
    const rows = await inner.query<Record<string, unknown>>(toLegacySql(sql), params);
    return rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k === 'variant_id' ? 'item_id' : k, v]),
      ),
    ) as T[];
  },
  batch: (statements: readonly Statement[]) =>
    inner.batch(statements.map((s) => ({ ...s, sql: toLegacySql(s.sql) }))),
});

async function kiryanaAt8(): Promise<SqlJsDriver> {
  const SQL = await initSqlJs();
  const driver = createSqlJsDriver(new SQL.Database());
  await migrate(driver, UP_TO_8);
  await seedDemoData({ driver: legacy(driver), pinIterations: PIN_ITERATIONS });
  return driver;
}

const version = async (db: SqlDriver): Promise<number | undefined> =>
  (await db.query<{ v: number }>('select max(version) as v from schema_migrations'))[0]?.v;

const countOf = async (db: SqlDriver, table: string): Promise<number> =>
  (await db.query<{ n: number }>(`select count(*) as n from ${table}`))[0]?.n ?? -1;

describe('grocery upgrade (0009) on sql.js', () => {
  it('keeps the kiryana data of a 0008 database and still sells afterwards', async () => {
    const db = await kiryanaAt8();
    expect(await version(db)).toBe(8);
    const itemsBefore = await countOf(db, 'accessory_variants');
    const movesBefore = await countOf(db, 'stock_movements');
    const salesBefore = await countOf(db, 'sales');
    const linesBefore = await countOf(db, 'sale_lines');
    const batchesBefore = await countOf(db, 'stock_batches');
    expect(itemsBefore).toBeGreaterThan(0);
    expect(salesBefore).toBeGreaterThan(0);

    expect(await migrate(db, ALL)).toEqual([9]);
    expect(await version(db)).toBe(9);
    expect(await countOf(db, 'items')).toBe(itemsBefore);
    expect(await countOf(db, 'stock_movements')).toBe(movesBefore);
    expect(await countOf(db, 'sales')).toBe(salesBefore);
    expect(await countOf(db, 'sale_lines')).toBe(linesBefore);
    expect(await countOf(db, 'stock_batches')).toBe(batchesBefore);

    const svc = createPosService({ driver: db, pinIterations: PIN_ITERATIONS });
    await svc.auth.login('owner', '1234');
    expect(await svc.integrity.verifyChain()).toMatchObject({ ok: true, count: salesBefore });
    const [piece] = (await svc.catalog.listItems()).filter(
      (v) => v.item.unitScale === 1 && v.onHand >= 2,
    );
    if (piece === undefined) throw new Error('demo data has no piece item with stock');
    const lines = [{ itemId: piece.item.id, quantity: 2 }];
    const preview = await svc.checkout.preview({ lines });
    const sale = await svc.checkout.commit({
      lines,
      payments: [{ method: 'cash', amount: preview.total }],
    });
    expect(sale.lines[0]).toMatchObject({ itemId: piece.item.id, quantity: 2 });
    const [after] = (await svc.catalog.listItems({ q: piece.item.sku })).filter(
      (v) => v.item.id === piece.item.id,
    );
    expect(after?.onHand).toBe(piece.onHand - 2);
    expect(await svc.integrity.verifyChain()).toMatchObject({ ok: true });
  });

  it('refuses a 0008 database that still holds a phone unit and leaves it on 0008', async () => {
    const db = await kiryanaAt8();
    const now = Date.now();
    await db.exec(`
      INSERT INTO products (id, kind, brand, name, category, is_active, created_at, updated_at)
      VALUES ('0199c82c-0000-7000-8000-000000000001', 'phone', 'Samsung', 'Galaxy A15', 'Phone', 1, ${now}, ${now});
      INSERT INTO phone_units (id, product_id, imei1, pta_status, condition, cost_price, sale_price, created_at, updated_at)
      VALUES ('0199c82c-0000-7000-8000-000000000002', '0199c82c-0000-7000-8000-000000000001', '356938035643809',
              'approved', 'new', 4000000, 4500000, ${now}, ${now});
    `);

    const failure = await migrate(db, ALL).then(
      () => null,
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/grocery upgrade refused: phone_units has rows/);
    expect(isGroceryUpgradeRefused(failure)).toBe(true);
    expect(isGroceryUpgradeRefused(new Error('no such table: items'))).toBe(false);
    expect(isGroceryUpgradeRefused('grocery upgrade refused')).toBe(false);

    expect(await version(db)).toBe(8);
    expect(await countOf(db, 'phone_units')).toBe(1);
    const tables = await db.query<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name in ('items', 'accessory_variants')",
    );
    expect(tables.map((t) => t.name)).toEqual(['accessory_variants']);
  });
});

/** The boot screen for a refused database: download, restore and reset wait for the owner PIN (security review). */
describe('legacy boot screen gate', () => {
  it('nothing is offered before the owner PIN; reset waits for a downloaded copy', () => {
    expect(legacyActions({ unlocked: false, downloaded: false })).toEqual({
      download: false,
      restore: false,
      reset: false,
    });
    expect(legacyActions({ unlocked: false, downloaded: true }).reset).toBe(false);
    expect(legacyActions({ unlocked: true, downloaded: false })).toEqual({
      download: true,
      restore: true,
      reset: false,
    });
    expect(legacyActions({ unlocked: true, downloaded: true }).reset).toBe(true);
  });

  it('checks the PIN against the stored 0008 owner without migrating or changing the bytes', async () => {
    const SQL = await initSqlJs();
    const bytes = (await kiryanaAt8()).exportBytes();
    const before = Uint8Array.from(bytes);
    const check = createOwnerPinCheck(SQL, bytes);

    await expect(check('1234')).resolves.toBeUndefined();
    await expect(check('3456')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' }); // the cashier's PIN
    await expect(check('0000')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(bytes).toEqual(before);
    const reopened = createSqlJsDriver(new SQL.Database(bytes));
    expect(await version(reopened)).toBe(8);
  });

  it('locks after repeated wrong PINs, like the login screen', async () => {
    const SQL = await initSqlJs();
    const check = createOwnerPinCheck(SQL, (await kiryanaAt8()).exportBytes());
    for (let i = 0; i < 5; i += 1) await check('0000').catch(() => undefined);
    await expect(check('1234')).rejects.toMatchObject({ code: 'LOGIN_LOCKED' });
  });
});
