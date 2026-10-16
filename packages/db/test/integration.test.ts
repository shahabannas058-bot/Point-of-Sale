import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS_HASH, InvoiceSchema, type UnsealedInvoice } from '@pos/shared';
import {
  applyPercentDiscount,
  assertPaymentsMatchTotal,
  formatInvoiceNo,
  paisa,
  phoneUnitState,
  saleTotals,
  sealInvoice,
  stockOnHand,
  verifyChain,
  type MovementLike,
} from '@pos/core';
import { camelizeKeys, migrate } from '../src/index';
import { createNodeSqliteDriver, loadMigrationsFromDir, type NodeSqliteDriver } from '../src/node';
import { BASE_MS, buildChain, makeInvoice, mulberry32, randInt } from '../../core/test/fixtures';
import {
  SHOP,
  addVariant,
  count,
  createMigratedDb,
  createSeededDb,
  insertInvoice,
  insertInvoices,
  insertRow,
  invoiceStatements,
  ledgerRow,
  lineRow,
  movementRow,
  newId,
  outboxRow,
  paymentRow,
  readInvoices,
  receivePhone,
  rowStatement,
  saleRow,
  seedShop,
} from './helpers';

let db: NodeSqliteDriver;
beforeEach(async () => {
  ({ db } = await createSeededDb());
});
afterEach(() => {
  db.close();
});

const allMovements = async (): Promise<MovementLike[]> =>
  (await db.query<Record<string, unknown>>('select * from stock_movements')).map((r) =>
    camelizeKeys<MovementLike>(r),
  );

describe('core stockOnHand and SQL views agree', () => {
  it('matches for 200 random variant movements over 3 variants and 2 branches', async () => {
    const variants = [SHOP.variantId, await addVariant(db, 'V2'), await addVariant(db, 'V3')];
    const branches = [SHOP.branchId, SHOP.branch2Id];
    const rand = mulberry32(1234);
    const rows = [];
    for (let i = 0; i < 200; i++) {
      const kind = randInt(rand, 0, 3);
      const variant = variants[randInt(rand, 0, variants.length - 1)]!;
      const branch = branches[randInt(rand, 0, branches.length - 1)]!;
      const base = { variant_id: variant, branch_id: branch, created_at: BASE_MS + i };
      if (kind === 0)
        rows.push(movementRow({ ...base, type: 'purchase', quantity: randInt(rand, 1, 20) }));
      else if (kind === 1)
        rows.push(movementRow({ ...base, type: 'sale', quantity: -randInt(rand, 1, 5) }));
      else if (kind === 2)
        rows.push(movementRow({ ...base, type: 'return', quantity: randInt(rand, 1, 3) }));
      else
        rows.push(
          movementRow({
            ...base,
            type: 'adjustment',
            quantity: rand() < 0.5 ? randInt(rand, 1, 3) : -randInt(rand, 1, 3),
            reason: 'stock count',
          }),
        );
    }
    await db.batch(rows.map((r) => rowStatement('stock_movements', r)));

    const movements = await allMovements();
    expect(movements).toHaveLength(200);
    const view = await db.query<{ variant_id: string; branch_id: string; on_hand: number }>(
      'select variant_id, branch_id, on_hand from v_variant_on_hand',
    );
    for (const variantId of variants) {
      for (const branchId of branches) {
        const fromView = view.find((r) => r.variant_id === variantId && r.branch_id === branchId);
        expect(fromView?.on_hand ?? 0).toBe(stockOnHand(movements, { variantId, branchId }));
      }
    }
    // and the all-branch total
    for (const variantId of variants) {
      const sqlTotal = view
        .filter((r) => r.variant_id === variantId)
        .reduce((sum, r) => sum + r.on_hand, 0);
      expect(sqlTotal).toBe(stockOnHand(movements, { variantId }));
    }
  });

  it('agrees on phone unit state through a sell and re-acquire cycle', async () => {
    await receivePhone(db);
    expect(phoneUnitState(await allMovements(), SHOP.phoneUnitId)).toBe('in_stock');
    await insertRow(
      db,
      'stock_movements',
      movementRow({
        type: 'sale',
        phone_unit_id: SHOP.phoneUnitId,
        variant_id: null,
        quantity: -1,
      }),
    );
    expect(phoneUnitState(await allMovements(), SHOP.phoneUnitId)).toBe('out');
    expect(await db.query('select * from v_phone_unit_on_hand')).toEqual([]);
    await insertRow(
      db,
      'stock_movements',
      movementRow({
        type: 'return',
        phone_unit_id: SHOP.phoneUnitId,
        variant_id: null,
        quantity: 1,
      }),
    );
    expect(phoneUnitState(await allMovements(), SHOP.phoneUnitId)).toBe('in_stock');
    expect(await db.query('select on_hand from v_phone_unit_on_hand')).toEqual([{ on_hand: 1 }]);
  });
});

describe('khata balance through a sale', () => {
  it('a customer sale with a khata part and its ledger entry gives the right balance', async () => {
    const [invoice] = buildChain(1);
    await insertInvoice(db, invoice!); // khata part 100000 -> sale_credit
    const balance = await db.query<{ balance: number }>(
      'select balance from v_customer_balance where customer_id = ?',
      [SHOP.customerId],
    );
    expect(balance).toEqual([{ balance: 100000 }]);
    await insertRow(
      db,
      'ledger_entries',
      ledgerRow({ type: 'payment_received', amount: -40000, method: 'cash' }),
    );
    const after = await db.query<{ balance: number }>('select balance from v_customer_balance');
    expect(after).toEqual([{ balance: 60000 }]);
  });
});

describe('integrity views', () => {
  it('flag sales whose payments or lines do not add up, and ignore valid sales', async () => {
    const [valid] = buildChain(1);
    await insertInvoice(db, valid!);

    // S1: total 1000 but only 500 paid
    const s1 = saleRow({ seq: 2, invoice_no: 'A-000002', prev_hash: valid!.hash });
    // S2: subtotal 2000 but its only line is worth 1000 (payments match the header)
    const s2 = saleRow({
      seq: 3,
      invoice_no: 'A-000003',
      prev_hash: s1.hash as string,
      subtotal: 2000,
      total: 2000,
    });
    await db.batch([
      rowStatement('sales', s1),
      rowStatement('sale_lines', lineRow(s1.id as string)),
      rowStatement('payments', paymentRow(s1.id as string, { amount: 500 })),
      rowStatement('sales', s2),
      rowStatement('sale_lines', lineRow(s2.id as string)),
      rowStatement('payments', paymentRow(s2.id as string, { amount: 2000 })),
    ]);

    expect(await db.query('select * from v_sale_payment_mismatch')).toEqual([
      { sale_id: s1.id, total: 1000, paid: 500 },
    ]);
    expect(await db.query('select * from v_sale_line_mismatch')).toEqual([
      { sale_id: s2.id, subtotal: 2000, lines_total: 1000 },
    ]);
  });

  it('are empty for a set of valid invoices', async () => {
    await insertInvoices(db, buildChain(3));
    expect(await db.query('select * from v_sale_payment_mismatch')).toEqual([]);
    expect(await db.query('select * from v_sale_line_mismatch')).toEqual([]);
  });

  it('flag a sale with no lines and no payments', async () => {
    const bare = saleRow();
    await insertRow(db, 'sales', bare);
    expect(await db.query('select sale_id from v_sale_payment_mismatch')).toEqual([
      { sale_id: bare.id },
    ]);
    expect(await db.query('select sale_id from v_sale_line_mismatch')).toEqual([
      { sale_id: bare.id },
    ]);
  });
});

describe('read-back and tamper detection', () => {
  it('invoices read back from SQLite parse and verify', async () => {
    const chain = buildChain(3);
    await insertInvoices(db, chain);
    const loaded = await readInvoices(db);
    expect(loaded).toHaveLength(3);
    expect(verifyChain(loaded)).toEqual({
      ok: true,
      count: 3,
      headSeq: 3,
      headHash: chain[2]!.hash,
    });
    expect(verifyChain(loaded, { expectedHeadHash: chain[2]!.hash }).ok).toBe(true);
    // what went in is exactly what comes out
    expect(loaded.map((i) => i.hash)).toEqual(chain.map((i) => i.hash));
    expect(loaded[1]!.lines.map((l) => l.lineTotal)).toEqual(
      chain[1]!.lines.map((l) => l.lineTotal),
    );
  });

  it('triggers deter: editing a stored invoice is blocked while they are installed', async () => {
    await insertInvoices(db, buildChain(2));
    await expect(
      db.query('update sales set created_at = created_at - 1 where seq = 1'),
    ).rejects.toThrow(/immutable/);
    expect(verifyChain(await readInvoices(db)).ok).toBe(true);
  });

  it('the hash detects: after DROP TRIGGER and a raw edit, verifyChain reports hash_mismatch', async () => {
    const chain = buildChain(3);
    await insertInvoices(db, chain);
    await db.exec('drop trigger trg_sales_no_update');
    await db.exec('update sales set created_at = created_at - 86400000 where seq = 2');
    const result = verifyChain(await readInvoices(db));
    expect(result).toMatchObject({
      ok: false,
      reason: 'hash_mismatch',
      index: 1,
      invoiceId: chain[1]!.id,
    });
  });

  it('a raw edit of a line is detected too', async () => {
    const chain = buildChain(2);
    await insertInvoices(db, chain);
    await db.exec('drop trigger trg_sale_lines_no_update');
    await db.exec(
      "update sale_lines set description = 'something else' where sale_id = (select id from sales where seq = 1)",
    );
    expect(verifyChain(await readInvoices(db))).toMatchObject({
      ok: false,
      reason: 'hash_mismatch',
      index: 0,
    });
  });

  it('deleting the last invoice after dropping the triggers needs the remembered head hash', async () => {
    const chain = buildChain(3);
    await insertInvoices(db, chain, { ledger: false });
    await db.exec('drop trigger trg_sales_no_delete');
    await db.exec('drop trigger trg_sale_lines_no_delete');
    await db.exec('drop trigger trg_payments_no_delete');
    await db.exec('delete from payments where sale_id = (select id from sales where seq = 3)');
    await db.exec('delete from sale_lines where sale_id = (select id from sales where seq = 3)');
    await db.exec('delete from sales where seq = 3');
    const remaining = await readInvoices(db);
    expect(verifyChain(remaining).ok).toBe(true); // the documented local limitation
    expect(verifyChain(remaining, { expectedHeadHash: chain[2]!.hash })).toMatchObject({
      ok: false,
      reason: 'head_mismatch',
    });
  });
});

describe('atomic commit', () => {
  const stockUp = async (): Promise<void> => {
    await insertRow(db, 'stock_movements', movementRow({ type: 'purchase', quantity: 10 }));
    await receivePhone(db);
  };
  const tables = ['sales', 'sale_lines', 'payments', 'ledger_entries', 'outbox'] as const;

  it('rolls back every table when the last statement of the batch violates a CHECK', async () => {
    await stockUp();
    const before = await count(db, 'stock_movements');
    const [invoice] = buildChain(1);
    const statements = [
      ...invoiceStatements(invoice!, { movements: true }),
      rowStatement(
        'outbox',
        outboxRow({ entity_id: invoice!.id, payload: JSON.stringify(invoice) }),
      ),
      rowStatement('outbox', outboxRow({ payload: 'not json' })), // violates json_valid CHECK
    ];
    await expect(db.batch(statements)).rejects.toThrow(/CHECK constraint failed/);
    for (const table of tables) expect(await count(db, table), table).toBe(0);
    expect(await count(db, 'stock_movements')).toBe(before);
    expect(
      await db.query('select on_hand from v_variant_on_hand where variant_id = ?', [
        SHOP.variantId,
      ]),
    ).toEqual([{ on_hand: 10 }]);
  });

  it('rolls back when a guard trigger aborts mid-batch (selling the same phone twice)', async () => {
    await stockUp();
    const chain = buildChain(2);
    // both invoices contain the same phone unit; the second sale must fail and take its sibling rows with it
    await insertInvoice(db, chain[0]!, { movements: true });
    const salesBefore = await count(db, 'sales');
    const movementsBefore = await count(db, 'stock_movements');
    await expect(insertInvoice(db, chain[1]!, { movements: true })).rejects.toThrow(
      /within 0\.\.1/,
    );
    expect(await count(db, 'sales')).toBe(salesBefore);
    expect(await count(db, 'stock_movements')).toBe(movementsBefore);
  });

  it('commits the full sale (header, lines, payments, movements, ledger, outbox) together', async () => {
    await stockUp();
    const [invoice] = buildChain(1);
    await db.batch([
      ...invoiceStatements(invoice!, { movements: true }),
      rowStatement(
        'outbox',
        outboxRow({ entity_id: invoice!.id, payload: JSON.stringify(invoice) }),
      ),
    ]);
    expect(await count(db, 'sales')).toBe(1);
    expect(await count(db, 'sale_lines')).toBe(2);
    expect(await count(db, 'payments')).toBe(2);
    expect(await count(db, 'ledger_entries')).toBe(1);
    expect(await count(db, 'outbox')).toBe(1);
    // stock: 10 chargers - 2 sold = 8; the phone is out
    expect(
      await db.query('select on_hand from v_variant_on_hand where variant_id = ?', [
        SHOP.variantId,
      ]),
    ).toEqual([{ on_hand: 8 }]);
    expect(await db.query('select * from v_phone_unit_on_hand')).toEqual([]);
    const [queued] = await db.query<{ payload: string }>('select payload from outbox');
    expect(InvoiceSchema.parse(JSON.parse(queued!.payload)).id).toBe(invoice!.id);
  });
});

describe('offline durability on a file database', () => {
  it('a committed sale survives close and reopen, and the chain still verifies', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pos-db-test-'));
    const file = join(dir, 'shop.sqlite');
    try {
      const first = await createMigratedDb(file);
      await seedShop(first);
      const chain = buildChain(3);
      await insertInvoices(first, chain);
      first.close();

      const reopened = createNodeSqliteDriver(file); // no network involved anywhere
      try {
        expect(await migrate(reopened, loadMigrationsFromDir())).toEqual([]);
        const loaded = await readInvoices(reopened);
        expect(verifyChain(loaded)).toEqual({
          ok: true,
          count: 3,
          headSeq: 3,
          headHash: chain[2]!.hash,
        });
        expect(await count(reopened, 'ledger_entries')).toBe(3);
        // triggers and pragmas survive too
        await expect(reopened.query('delete from sales')).rejects.toThrow(/immutable/);
      } finally {
        reopened.close();
      }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the WAL file briefly; the OS temp folder is cleaned up eventually.
      }
    }
  });
});

describe('end to end: price, split, seal, store, verify', () => {
  it('sells a phone with 5% off plus two chargers, part cash and part khata', async () => {
    await receivePhone(db);
    await insertRow(db, 'stock_movements', movementRow({ type: 'purchase', quantity: 10 }));

    const phonePrice = paisa(8_500_000);
    const phoneDiscount = applyPercentDiscount(phonePrice, 500).discount; // 425000
    const totals = saleTotals(
      [
        { quantity: 1, unitPrice: phonePrice, discountAmount: phoneDiscount },
        { quantity: 2, unitPrice: paisa(150_000), discountAmount: paisa(0) },
      ],
      paisa(0),
    );
    expect(totals.subtotal).toBe(8_375_000);
    const payments = [
      { method: 'cash' as const, amount: paisa(5_000_000) },
      { method: 'khata' as const, amount: paisa(totals.total - 5_000_000) },
    ];
    assertPaymentsMatchTotal(totals.total, payments);

    const saleId = newId();
    const base = makeInvoice({ id: saleId as UnsealedInvoice['id'] });
    const unsealed = {
      ...base,
      invoiceNo: formatInvoiceNo('A', 1),
      subtotal: totals.subtotal,
      total: totals.total,
      lines: [
        {
          ...base.lines[1]!,
          unitPrice: phonePrice,
          costPrice: paisa(7_800_000),
          discountAmount: phoneDiscount,
          lineTotal: totals.lineTotals[0]!,
        },
        {
          ...base.lines[0]!,
          lineNo: 2,
          unitPrice: paisa(150_000),
          costPrice: paisa(90_000),
          lineTotal: totals.lineTotals[1]!,
        },
      ].map((l, i) => ({ ...l, lineNo: i + 1 })),
      payments: payments.map((p, i) => ({ ...base.payments[i]!, ...p })),
    } as unknown as UnsealedInvoice;
    const invoice = InvoiceSchema.parse(sealInvoice(GENESIS_HASH, unsealed));
    await insertInvoice(db, invoice, { movements: true });

    expect(verifyChain(await readInvoices(db)).ok).toBe(true);
    expect(await db.query('select balance from v_customer_balance')).toEqual([
      { balance: totals.total - 5_000_000 },
    ]);
    expect(
      await db.query('select on_hand from v_variant_on_hand where variant_id = ?', [
        SHOP.variantId,
      ]),
    ).toEqual([{ on_hand: 8 }]);
    expect(await db.query('select * from v_phone_unit_on_hand')).toEqual([]);
  });
});
