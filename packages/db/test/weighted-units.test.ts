import { afterEach, describe, expect, it } from 'vitest';
import { verifyChain } from '@pos/core';
import { migrate } from '../src/migrate';
import { createNodeSqliteDriver, loadMigrationsFromDir, type NodeSqliteDriver } from '../src/node';
import { buildChain } from '../../core/test/fixtures';
import {
  SHOP,
  count,
  createSeededDb,
  insertInvoices,
  insertRow,
  lineRow,
  newId,
  paymentRow,
  readInvoices,
  saleRow,
  seedShop,
} from './helpers';

const open: NodeSqliteDriver[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()?.close();
});
const track = (db: NodeSqliteDriver): NodeSqliteDriver => {
  open.push(db);
  return db;
};

describe('migration 0006 on a database that already has invoices', () => {
  it('keeps every line, every hash and the chain, and adds unit_scale = 1', async () => {
    const db = track(createNodeSqliteDriver(':memory:'));
    const migrations = loadMigrationsFromDir();
    await migrate(db, migrations.slice(0, 5)); // the schema a shop has today
    await seedShop(db);
    const chain = buildChain(3);
    await insertInvoices(db, chain);
    const linesBefore = await db.query<Record<string, unknown>>(
      'select * from sale_lines order by id',
    );
    expect(linesBefore).toHaveLength(6);

    expect(await migrate(db, migrations)).toEqual([6, 7]); // 0007 (batches) must not disturb the 0006 result

    const linesAfter = await db.query<Record<string, unknown>>(
      'select * from sale_lines order by id',
    );
    expect(linesAfter).toHaveLength(6);
    for (const [i, before] of linesBefore.entries()) {
      expect(linesAfter[i]).toMatchObject({ ...before, unit_scale: 1 });
    }

    const invoices = await readInvoices(db);
    expect(invoices.map((i) => i.hash)).toEqual(chain.map((i) => i.hash));
    expect(invoices.every((i) => i.hashVersion === 1)).toBe(true);
    expect(verifyChain(invoices)).toMatchObject({ ok: true, count: 3 });

    expect(await db.query('PRAGMA foreign_key_check')).toEqual([]);
    expect(await count(db, 'v_sale_line_mismatch')).toBe(0);
  });

  it('the rebuilt sale_lines table is still immutable', async () => {
    const { db } = await createSeededDb();
    track(db);
    const sale = saleRow({ subtotal: 1000, total: 1000 });
    await insertRow(db, 'sales', sale);
    const line = lineRow(sale.id as string);
    await insertRow(db, 'sale_lines', line);
    await expect(
      db.exec(`update sale_lines set description = 'x' where id = '${line.id as string}'`),
    ).rejects.toThrow(/sale_lines is immutable/);
    await expect(
      db.exec(`delete from sale_lines where id = '${line.id as string}'`),
    ).rejects.toThrow(/sale_lines is immutable/);
  });
});

describe('weighted variants and lines (database rules)', () => {
  const WEIGHTED = newId();

  async function seedWeighted(): Promise<NodeSqliteDriver> {
    const { db } = await createSeededDb();
    track(db);
    await insertRow(db, 'accessory_variants', {
      id: WEIGHTED,
      product_id: SHOP.accessoryProductId,
      sku: 'CHINI-LOOSE',
      cost_price: 25_000,
      sale_price: 28_550,
      unit_scale: 1000,
      unit_label: 'kg',
      created_at: 1,
      updated_at: 1,
    });
    return db;
  }

  /** A sale header + one weighted line (+ matching payment) ready to insert. */
  const weightedSale = (o: { quantity?: number; lineTotal?: number } = {}) => {
    const quantity = o.quantity ?? 1250;
    const lineTotal = o.lineTotal ?? 35_688;
    const sale = saleRow({ subtotal: lineTotal, total: lineTotal });
    const line = lineRow(sale.id as string, {
      variant_id: WEIGHTED,
      quantity,
      unit_price: 28_550,
      unit_scale: 1000,
      line_total: lineTotal,
    });
    return { sale, line };
  };

  it('accepts a line whose total follows the rounded rule', async () => {
    const db = await seedWeighted();
    const { sale, line } = weightedSale();
    await insertRow(db, 'sales', sale);
    await insertRow(db, 'sale_lines', line);
    await insertRow(db, 'payments', paymentRow(sale.id as string, { amount: 35_688 }));
    expect(await count(db, 'sale_lines')).toBe(1);
    expect(await count(db, 'v_sale_line_mismatch')).toBe(0);
  });

  it('rounds returns away from zero as well', async () => {
    const db = await seedWeighted();
    const original = weightedSale();
    await insertRow(db, 'sales', original.sale);
    await insertRow(db, 'sale_lines', original.line);
    const ret = saleRow({
      seq: 2,
      invoice_no: 'A-000002',
      kind: 'return',
      original_sale_id: original.sale.id as string,
      subtotal: -35_688,
      total: -35_688,
      prev_hash: original.sale.hash as string,
    });
    await insertRow(db, 'sales', ret);
    await insertRow(
      db,
      'sale_lines',
      lineRow(ret.id as string, {
        variant_id: WEIGHTED,
        quantity: -1250,
        unit_price: 28_550,
        unit_scale: 1000,
        line_total: -35_688,
      }),
    );
    expect(await count(db, 'sale_lines')).toBe(2);
  });

  it.each([35_687, 35_689, 35_687_500])(
    'rejects line_total %d for 1250 g at 28550/kg',
    async (bad) => {
      const db = await seedWeighted();
      const { sale, line } = weightedSale({ lineTotal: bad });
      await insertRow(db, 'sales', sale);
      await expect(insertRow(db, 'sale_lines', line)).rejects.toThrow(/CHECK constraint failed/);
    },
  );

  it('rejects a line that claims a different unit than its variant', async () => {
    const db = await seedWeighted();
    // the piece variant (SHOP.variantId, scale 1) sold as if it were weighed
    const sale = saleRow({ subtotal: 1, total: 1 });
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(
        db,
        'sale_lines',
        lineRow(sale.id as string, {
          variant_id: SHOP.variantId,
          quantity: 1000,
          unit_price: 1,
          unit_scale: 1000,
          line_total: 1,
        }),
      ),
    ).rejects.toThrow(/unit_scale must match the variant/);
    // and the other way round
    const sale2 = saleRow({
      seq: 2,
      invoice_no: 'A-000002',
      subtotal: 1000,
      total: 1000,
      prev_hash: sale.hash as string,
    });
    await insertRow(db, 'sales', sale2);
    await expect(
      insertRow(
        db,
        'sale_lines',
        lineRow(sale2.id as string, {
          variant_id: WEIGHTED,
          quantity: 1000,
          unit_price: 1,
          unit_scale: 1,
          line_total: 1000,
        }),
      ),
    ).rejects.toThrow(/unit_scale must match the variant/);
  });

  it('a phone unit can never be sold by weight', async () => {
    const db = await seedWeighted();
    const sale = saleRow({ subtotal: 8, total: 8 });
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(
        db,
        'sale_lines',
        lineRow(sale.id as string, {
          phone_unit_id: SHOP.phoneUnitId,
          variant_id: null,
          quantity: 1,
          unit_price: 8_500,
          unit_scale: 1000,
          line_total: 9,
        }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('unit_label and unit_scale must agree on a variant', async () => {
    const { db } = await createSeededDb();
    track(db);
    const base = {
      product_id: SHOP.accessoryProductId,
      cost_price: 1,
      sale_price: 2,
      created_at: 1,
      updated_at: 1,
    };
    await expect(
      insertRow(db, 'accessory_variants', {
        ...base,
        id: newId(),
        sku: 'BAD-1',
        unit_scale: 1,
        unit_label: 'kg',
      }),
    ).rejects.toThrow(/unit_scale must match unit_label/);
    await expect(
      insertRow(db, 'accessory_variants', {
        ...base,
        id: newId(),
        sku: 'BAD-2',
        unit_scale: 1000,
        unit_label: 'pcs',
      }),
    ).rejects.toThrow(/unit_scale must match unit_label/);
    await expect(
      insertRow(db, 'accessory_variants', {
        ...base,
        id: newId(),
        sku: 'BAD-3',
        unit_scale: 7,
        unit_label: 'pcs',
      }),
    ).rejects.toThrow(/unit_scale must match unit_label|CHECK constraint failed/);
  });

  it('the unit of a variant is locked once it has stock movements', async () => {
    const db = await seedWeighted();
    // no stock yet: switching is still allowed
    await db.exec(
      `update accessory_variants set unit_scale = 1, unit_label = 'pcs' where id = '${WEIGHTED}'`,
    );
    await db.exec(
      `update accessory_variants set unit_scale = 1000, unit_label = 'kg' where id = '${WEIGHTED}'`,
    );
    await insertRow(db, 'stock_movements', {
      id: newId(),
      branch_id: SHOP.branchId,
      type: 'purchase',
      phone_unit_id: null,
      variant_id: WEIGHTED,
      quantity: 50_000,
      unit_cost: null,
      ref_type: null,
      ref_id: null,
      reason: null,
      created_by: SHOP.cashierId,
      created_at: 1,
    });
    await expect(
      db.exec(
        `update accessory_variants set unit_scale = 1, unit_label = 'pcs' where id = '${WEIGHTED}'`,
      ),
    ).rejects.toThrow(/unit cannot change once stock exists/);
    // prices stay editable
    await db.exec(`update accessory_variants set sale_price = 30000 where id = '${WEIGHTED}'`);
  });
});
