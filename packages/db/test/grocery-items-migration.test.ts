import { afterEach, describe, expect, it } from 'vitest';
import { verifyChain } from '@pos/core';
import { migrate } from '../src/migrate';
import { createNodeSqliteDriver, loadMigrationsFromDir, type NodeSqliteDriver } from '../src/node';
import { createPosService, seedDemoData } from '../src/service';
import type { SqlDriver } from '../src/types';
import { count, readInvoices } from './helpers';
import { legacyDriver } from './legacy-driver';

const open: NodeSqliteDriver[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});

const PIN_ITERATIONS = 1000;
const LOGIN = { owner: '1234', manager: '2345', cashier: '3456' } as const;
const MOBILE_TABLES = [
  'phone_units',
  'repair_tickets',
  'repair_status_history',
  'repair_parts',
  'repair_payments',
  'warranties',
];

/** A database on schema 0008 (the last mobile-era schema) with a migrator that stops there. */
async function dbAt8(): Promise<NodeSqliteDriver> {
  const db = createNodeSqliteDriver(':memory:');
  open.push(db);
  await migrate(db, loadMigrationsFromDir().slice(0, 8));
  return db;
}

async function tableNames(db: SqlDriver): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
  );
  return rows.map((r) => r.name);
}

/** Row count per table; on the old schema accessory_variants is reported as items. */
async function rowCounts(db: SqlDriver): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of await tableNames(db)) {
    if (name === 'schema_migrations' || MOBILE_TABLES.includes(name)) continue;
    out[name === 'accessory_variants' ? 'items' : name] = await count(db, name);
  }
  return out;
}

/** On-hand per item and branch, from the ledger (works on both schemas through `legacyDriver`). */
async function onHand(db: SqlDriver): Promise<Record<string, number>> {
  const rows = await db.query<{ item_id: string; branch_id: string; n: number }>(
    'select item_id, branch_id, sum(quantity) as n from stock_movements group by item_id, branch_id',
  );
  return Object.fromEntries(rows.map((r) => [`${r.item_id}@${r.branch_id}`, r.n]));
}

/** A kiryana shop as the pre-0009 app left it: demo data (kg items, batches, sales, a return, khata) + a day close. */
async function kiryanaShopAt8(db: NodeSqliteDriver): Promise<void> {
  const old = legacyDriver(db);
  await seedDemoData({ driver: old, pinIterations: PIN_ITERATIONS });
  const svc = createPosService({ driver: old, pinIterations: PIN_ITERATIONS });
  await svc.auth.login('cashier', LOGIN.cashier);
  await svc.cash.addEntry({ type: 'expense', category: 'tea_food', amount: 15_000, note: 'Chai' });
  const drawer = await svc.cash.drawer();
  const counted = Math.max(drawer.expected, 0); // demo supplier payments can leave the drawer below zero
  await svc.cash.closeDay({ counted, carriedForward: 0, note: 'Upgrade test' });
  svc.auth.logout();
}

describe('migration 0009 on a kiryana database', () => {
  it('keeps every row, every on-hand and every invoice hash', async () => {
    const db = await dbAt8();
    await kiryanaShopAt8(db);
    const old = legacyDriver(db);

    const countsBefore = await rowCounts(db);
    const stockBefore = await onHand(old);
    const invoicesBefore = await readInvoices(old);
    // the data really covers what the upgrade has to carry
    expect(countsBefore.items).toBeGreaterThanOrEqual(15);
    expect(countsBefore.stock_batches).toBeGreaterThan(0);
    expect(countsBefore.day_closes).toBe(1);
    expect(countsBefore.ledger_entries).toBeGreaterThan(0);
    expect(invoicesBefore.some((i) => i.kind === 'return')).toBe(true);
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*) as n from accessory_variants where unit_scale = 1000',
        )
      )[0]?.n,
    ).toBeGreaterThan(0);
    expect(
      (
        await db.query<{ n: number }>(
          'select count(*) as n from stock_movements where batch_id is not null',
        )
      )[0]?.n,
    ).toBeGreaterThan(0);

    expect(await migrate(db, loadMigrationsFromDir())).toEqual([9]);

    const names = await tableNames(db);
    expect(names).toContain('items');
    for (const gone of [...MOBILE_TABLES, 'accessory_variants']) expect(names).not.toContain(gone);
    expect(await rowCounts(db)).toEqual(countsBefore);
    expect(await onHand(db)).toEqual(stockBefore);

    const invoicesAfter = await readInvoices(db);
    expect(invoicesAfter).toEqual(invoicesBefore);
    expect(verifyChain(invoicesAfter)).toMatchObject({ ok: true, count: invoicesBefore.length });
    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);

    const svc = createPosService({ driver: db, pinIterations: PIN_ITERATIONS });
    await svc.auth.login('owner', LOGIN.owner);
    expect(await svc.integrity.verifyChain()).toMatchObject({
      ok: true,
      count: invoicesBefore.length,
    });
    expect(await svc.integrity.checks()).toEqual({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
      unsentOutbox: countsBefore.outbox,
    });
  });

  it('the service sells and takes a return after the upgrade', async () => {
    const db = await dbAt8();
    await kiryanaShopAt8(db);
    await migrate(db, loadMigrationsFromDir());
    const svc = createPosService({ driver: db, pinIterations: PIN_ITERATIONS });

    await svc.auth.login('cashier', LOGIN.cashier);
    const [loose] = (await svc.catalog.listItems()).filter(
      (v) => v.item.unitScale === 1000 && v.onHand >= 2000,
    );
    if (loose === undefined) throw new Error('demo data has no loose item with 2 kg in stock');
    const draft = { lines: [{ itemId: loose.item.id, quantity: 1500 }] };
    const preview = await svc.checkout.preview(draft);
    const sale = await svc.checkout.commit({
      ...draft,
      payments: [{ method: 'cash', amount: preview.total }],
    });
    expect(sale.lines[0]).toMatchObject({ itemId: loose.item.id, quantity: 1500, unitScale: 1000 });
    const [afterSale] = (await svc.catalog.listItems({ q: loose.item.sku })).filter(
      (v) => v.item.id === loose.item.id,
    );
    expect(afterSale?.onHand).toBe(loose.onHand - 1500);
    svc.auth.logout();

    await svc.auth.login('manager', LOGIN.manager);
    const line = sale.lines[0];
    if (line === undefined) throw new Error('sale has no line');
    const ret = await svc.checkout.previewReturn(sale.id, [{ lineId: line.id, quantity: 500 }]);
    const returned = await svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 500 }],
      refund: ret.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
      reason: 'Too much',
    });
    expect(returned.kind).toBe('return');
    const [afterReturn] = (await svc.catalog.listItems({ q: loose.item.sku })).filter(
      (v) => v.item.id === loose.item.id,
    );
    expect(afterReturn?.onHand).toBe(loose.onHand - 1000);
    expect(await svc.integrity.verifyChain()).toMatchObject({ ok: true });
    expect(await count(db, 'v_sale_line_mismatch')).toBe(0);
  });
});

describe('migration 0009 refuses a database with mobile-shop data', () => {
  it('a phone unit stops the upgrade, rolls everything back and keeps the phone', async () => {
    const db = await dbAt8();
    await kiryanaShopAt8(db);
    const now = Date.now();
    await db.exec(`
      INSERT INTO products (id, kind, brand, name, category, is_active, created_at, updated_at)
      VALUES ('0199c82c-0000-7000-8000-000000000001', 'phone', 'Samsung', 'Galaxy A15', 'Phone', 1, ${now}, ${now});
      INSERT INTO phone_units (id, product_id, imei1, pta_status, condition, cost_price, sale_price, created_at, updated_at)
      VALUES ('0199c82c-0000-7000-8000-000000000002', '0199c82c-0000-7000-8000-000000000001', '356938035643809',
              'approved', 'new', 4000000, 4500000, ${now}, ${now});
    `);
    const countsBefore = await rowCounts(db);

    await expect(migrate(db, loadMigrationsFromDir())).rejects.toThrow(
      /Migration 9 \(grocery_items\) failed: CHECK constraint failed: grocery upgrade refused: phone_units has rows/,
    );

    const versions = await db.query<{ v: number }>(
      'select max(version) as v from schema_migrations',
    );
    expect(versions[0]?.v).toBe(8);
    expect(await count(db, 'phone_units')).toBe(1);
    const names = await tableNames(db);
    expect(names).toEqual(expect.arrayContaining(['accessory_variants', ...MOBILE_TABLES]));
    expect(names).not.toContain('items');
    expect(await rowCounts(db)).toEqual(countsBefore);
    expect(
      await db.query("select name from sqlite_temp_master where name = '_guard_0009'"),
    ).toEqual([]);
  });

  it.each([
    [
      'repair_tickets',
      `INSERT INTO repair_tickets (id, ticket_seq, ticket_no, branch_id, customer_name, device_brand, device_model,
         problem, estimated_cost, status, created_by, created_at, updated_at)
       SELECT '0199c82c-0000-7000-8000-000000000003', 1, 'R-1', (SELECT id FROM branches LIMIT 1), 'Walk-in',
         'Nokia', '3310', 'Screen', 0, 'received', (SELECT id FROM users LIMIT 1), 1, 1`,
    ],
    [
      'products has phone products',
      `INSERT INTO products (id, kind, brand, name, category, is_active, created_at, updated_at)
       VALUES ('0199c82c-0000-7000-8000-000000000004', 'phone', 'Tecno', 'Spark', NULL, 1, 1, 1)`,
    ],
  ])('%s blocks the upgrade too', async (what, sql) => {
    const db = await dbAt8();
    await kiryanaShopAt8(db);
    await db.exec(sql);
    await expect(migrate(db, loadMigrationsFromDir())).rejects.toThrow(
      new RegExp(`grocery upgrade refused: ${what}`),
    );
    const versions = await db.query<{ v: number }>(
      'select max(version) as v from schema_migrations',
    );
    expect(versions[0]?.v).toBe(8);
  });
});
