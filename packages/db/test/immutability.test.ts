import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GENESIS_HASH, type Invoice } from '@pos/shared';
import { sealInvoice } from '@pos/core';
import { createNodeSqliteDriver, type NodeSqliteDriver } from '../src/node';
import { BASE_MS, buildChain, makeInvoice } from '../../core/test/fixtures';
import {
  SHOP,
  count,
  createMigratedDb,
  createSeededDb,
  insertInvoice,
  insertInvoices,
  insertRow,
  ledgerRow,
  lineRow,
  makeReturnUnsealed,
  movementRow,
  newId,
  outboxRow,
  paymentRow,
  purchaseRow,
  receivePhone,
  saleRow,
} from './helpers';

let db: NodeSqliteDriver;
beforeEach(async () => {
  ({ db } = await createSeededDb());
});
afterEach(() => {
  db.close();
});

const unitMove = (quantity: 1 | -1, over: Record<string, string | number | null> = {}) =>
  movementRow({
    type: quantity === 1 ? 'purchase' : 'sale',
    phone_unit_id: SHOP.phoneUnitId,
    variant_id: null,
    quantity,
    ...over,
  });

describe('stock_movements is append-only', () => {
  it('rejects UPDATE and DELETE', async () => {
    const row = movementRow({ quantity: 5 });
    await insertRow(db, 'stock_movements', row);
    await expect(
      db.query('update stock_movements set quantity = 99 where id = ?', [row.id as string]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query('delete from stock_movements where id = ?', [row.id as string]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query('delete from stock_movements')).rejects.toThrow(/append-only/);
    expect(await count(db, 'stock_movements')).toBe(1);
  });

  it('rejects INSERT OR REPLACE over an existing id (needs recursive_triggers)', async () => {
    const row = movementRow({ quantity: 5 });
    await insertRow(db, 'stock_movements', row);
    await expect(
      db.query(
        'insert or replace into stock_movements (id, branch_id, type, variant_id, quantity, created_by, created_at) values (?,?,?,?,?,?,?)',
        [row.id as string, SHOP.branchId, 'purchase', SHOP.variantId, 999, SHOP.cashierId, 1],
      ),
    ).rejects.toThrow(/append-only/);
    const [still] = await db.query<{ quantity: number }>(
      'select quantity from stock_movements where id = ?',
      [row.id as string],
    );
    expect(still?.quantity).toBe(5);
  });

  it('documents why: without recursive_triggers the same REPLACE silently rewrites history', async () => {
    const weak = createNodeSqliteDriver();
    try {
      await weak.exec('PRAGMA recursive_triggers = OFF');
      await weak.exec(
        `CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER) STRICT;
         CREATE TRIGGER t_no_delete BEFORE DELETE ON t BEGIN SELECT RAISE(ABORT, 'no delete'); END;
         INSERT INTO t VALUES (1, 1);`,
      );
      await weak.exec('INSERT OR REPLACE INTO t VALUES (1, 2)');
      expect(await weak.query('select v from t')).toEqual([{ v: 2 }]);
    } finally {
      weak.close();
    }
  });

  it('applies the same protection to purchases', async () => {
    const row = purchaseRow();
    await insertRow(db, 'purchases', row);
    await expect(db.query('update purchases set total = 1')).rejects.toThrow(/append-only/);
    await expect(db.query('delete from purchases')).rejects.toThrow(/append-only/);
  });

  it('enforces CHECK rules at the database level', async () => {
    await expect(
      insertRow(db, 'stock_movements', movementRow({ type: 'adjustment', quantity: -1 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(
        db,
        'stock_movements',
        movementRow({ type: 'adjustment', quantity: -1, reason: '' }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await insertRow(
      db,
      'stock_movements',
      movementRow({ type: 'adjustment', quantity: -1, reason: 'damaged' }),
    );
    await expect(
      insertRow(db, 'stock_movements', movementRow({ type: 'sale', quantity: 1 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'stock_movements', movementRow({ type: 'purchase', quantity: -1 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'stock_movements', movementRow({ type: 'purchase', quantity: 0 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    // neither target / both targets
    await expect(
      insertRow(db, 'stock_movements', movementRow({ variant_id: null, phone_unit_id: null })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'stock_movements', movementRow({ phone_unit_id: SHOP.phoneUnitId })),
    ).rejects.toThrow(/CHECK constraint failed/);
    // transfer needs ref_type = 'transfer'; ref_type and ref_id come together
    await expect(
      insertRow(
        db,
        'stock_movements',
        movementRow({ type: 'transfer', quantity: -1, ref_type: 'sale', ref_id: newId() }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'stock_movements', movementRow({ ref_type: 'sale' })),
    ).rejects.toThrow(/CHECK constraint failed/);
    // phone units move one at a time
    await expect(
      insertRow(
        db,
        'stock_movements',
        movementRow({ phone_unit_id: SHOP.phoneUnitId, variant_id: null, quantity: 2 }),
      ),
    ).rejects.toThrow(/CHECK constraint failed|within 0\.\.1/); // the guard trigger fires before CHECKs
    expect(await count(db, 'stock_movements')).toBe(1);
  });
});

describe('transfer movements require a ref_type', () => {
  // 0002_stock.sql: CHECK (type <> 'transfer' OR ref_type IS 'transfer') so a NULL ref_type no longer slips through.
  it('rejects a transfer movement whose ref_type is NULL', async () => {
    await expect(
      insertRow(db, 'stock_movements', movementRow({ type: 'transfer', quantity: -1 })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

describe('phone unit guard', () => {
  it('allows +1 then -1 but aborts a second -1', async () => {
    await insertRow(db, 'stock_movements', unitMove(1));
    await insertRow(db, 'stock_movements', unitMove(-1));
    await expect(insertRow(db, 'stock_movements', unitMove(-1))).rejects.toThrow(/within 0\.\.1/);
    expect(await count(db, 'stock_movements')).toBe(2);
  });

  it('aborts a second +1 (the same IMEI cannot be in stock twice)', async () => {
    await insertRow(db, 'stock_movements', unitMove(1));
    await expect(insertRow(db, 'stock_movements', unitMove(1))).rejects.toThrow(/within 0\.\.1/);
  });

  it('aborts selling a unit that was never received', async () => {
    await expect(insertRow(db, 'stock_movements', unitMove(-1))).rejects.toThrow(/within 0\.\.1/);
  });

  it('a transfer works when the -1 at the source comes before the +1 at the destination', async () => {
    await receivePhone(db, SHOP.phoneUnitId, SHOP.branchId);
    const ref = newId();
    await insertRow(
      db,
      'stock_movements',
      unitMove(-1, { type: 'transfer', ref_type: 'transfer', ref_id: ref }),
    );
    await insertRow(
      db,
      'stock_movements',
      unitMove(1, {
        type: 'transfer',
        ref_type: 'transfer',
        ref_id: ref,
        branch_id: SHOP.branch2Id,
      }),
    );
    const where = await db.query<{ branch_id: string; on_hand: number }>(
      'select branch_id, on_hand from v_phone_unit_on_hand where phone_unit_id = ?',
      [SHOP.phoneUnitId],
    );
    expect(where).toEqual([{ branch_id: SHOP.branch2Id, on_hand: 1 }]);
  });

  it('the reverse transfer order (+1 destination first) aborts', async () => {
    await receivePhone(db);
    const ref = newId();
    await expect(
      insertRow(
        db,
        'stock_movements',
        unitMove(1, {
          type: 'transfer',
          ref_type: 'transfer',
          ref_id: ref,
          branch_id: SHOP.branch2Id,
        }),
      ),
    ).rejects.toThrow(/within 0\.\.1/);
  });

  it('re-acquiring a unit (+1, -1 sale, +1 return) reuses the same unit row', async () => {
    await insertRow(db, 'stock_movements', unitMove(1));
    await insertRow(db, 'stock_movements', unitMove(-1));
    await insertRow(db, 'stock_movements', unitMove(1, { type: 'return' }));
    const onHand = await db.query<{ on_hand: number }>(
      'select on_hand from v_phone_unit_on_hand where phone_unit_id = ?',
      [SHOP.phoneUnitId],
    );
    expect(onHand).toEqual([{ on_hand: 1 }]);
    expect(await count(db, 'phone_units')).toBe(1);
  });

  it('a duplicate imei1 insert into phone_units fails with a unique violation', async () => {
    await expect(
      insertRow(db, 'phone_units', {
        id: newId(),
        product_id: SHOP.productId,
        imei1: '356938035643809',
        pta_status: 'non_pta',
        condition: 'used',
        cost_price: 1,
        sale_price: 2,
        created_at: 1,
        updated_at: 1,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: phone_units\.imei1/);
  });

  it('a duplicate serial, imei2 or barcode also fails', async () => {
    const unit = (over: Record<string, string | number | null>) => ({
      id: newId(),
      product_id: SHOP.productId,
      pta_status: 'non_pta',
      condition: 'used',
      cost_price: 1,
      sale_price: 2,
      created_at: 1,
      updated_at: 1,
      ...over,
    });
    await insertRow(db, 'phone_units', unit({ serial: 'SN-1' }));
    await expect(insertRow(db, 'phone_units', unit({ serial: 'SN-1' }))).rejects.toThrow(/UNIQUE/);
    await insertRow(
      db,
      'phone_units',
      unit({ imei1: '490154203237518', imei2: '490154203237526' }),
    );
    await expect(
      insertRow(db, 'phone_units', unit({ imei1: '490154203237534', imei2: '490154203237526' })),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      insertRow(db, 'accessory_variants', {
        id: newId(),
        product_id: SHOP.accessoryProductId,
        sku: 'OTHER-SKU',
        barcode: '8961234567890',
        cost_price: 1,
        sale_price: 2,
        created_at: 1,
        updated_at: 1,
      }),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('phone unit CHECKs: needs imei1 or serial, imei2 needs imei1, imei2 differs', async () => {
    const unit = (over: Record<string, string | number | null>) => ({
      id: newId(),
      product_id: SHOP.productId,
      pta_status: 'non_pta',
      condition: 'used',
      cost_price: 1,
      sale_price: 2,
      created_at: 1,
      updated_at: 1,
      ...over,
    });
    await expect(insertRow(db, 'phone_units', unit({}))).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'phone_units', unit({ serial: 'S', imei2: '490154203237518' })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'phone_units', unit({ imei1: '490154203237518', imei2: '490154203237518' })),
    ).rejects.toThrow(/CHECK/);
    await expect(insertRow(db, 'phone_units', unit({ imei1: '1234567890123a5' }))).rejects.toThrow(
      /CHECK/,
    );
  });
});

describe('invoices are immutable', () => {
  const tables = ['sales', 'sale_lines', 'payments', 'ledger_entries', 'purchases'] as const;

  beforeEach(async () => {
    await insertInvoices(db, buildChain(3));
    await insertRow(db, 'purchases', purchaseRow());
  });

  it('starts with 3 sealed invoices, their lines, payments and khata entries', async () => {
    expect(await count(db, 'sales')).toBe(3);
    expect(await count(db, 'sale_lines')).toBe(6);
    expect(await count(db, 'payments')).toBe(6);
    expect(await count(db, 'ledger_entries')).toBe(3);
  });

  const updates: Record<(typeof tables)[number], string> = {
    sales: 'update sales set total = 1',
    sale_lines: 'update sale_lines set quantity = 99',
    payments: 'update payments set amount = 1',
    ledger_entries: 'update ledger_entries set amount = 1',
    purchases: 'update purchases set total = 1',
  };

  it.each(tables)('UPDATE on %s throws', async (table) => {
    await expect(db.query(updates[table])).rejects.toThrow(/immutable|append-only/);
  });

  it.each(tables)('DELETE on %s throws', async (table) => {
    await expect(db.query(`delete from ${table}`)).rejects.toThrow(/immutable|append-only/);
  });

  it('even a single-column no-op style update is blocked', async () => {
    await expect(db.query('update sales set note = note')).rejects.toThrow(/immutable/);
  });

  it('INSERT OR REPLACE cannot overwrite an invoice either', async () => {
    const [first] = await db.query<{ id: string }>('select id from sales where seq = 1');
    await expect(
      db.query(
        'insert or replace into sales (id, device_id, seq, invoice_no, kind, branch_id, cashier_id, subtotal, total, created_at, prev_hash, hash) values (?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          first!.id,
          SHOP.deviceId,
          1,
          'A-000001',
          'sale',
          SHOP.branchId,
          SHOP.cashierId,
          0,
          0,
          1,
          GENESIS_HASH,
          'f'.repeat(64),
        ],
      ),
    ).rejects.toThrow();
    expect(await count(db, 'sales')).toBe(3);
  });

  it('nothing changed after all the failed attempts', async () => {
    for (const table of tables) {
      await db.query(updates[table]).catch(() => undefined);
      await db.query(`delete from ${table}`).catch(() => undefined);
    }
    expect(await count(db, 'sales')).toBe(3);
    expect(await count(db, 'sale_lines')).toBe(6);
    expect(await count(db, 'payments')).toBe(6);
    expect(await count(db, 'ledger_entries')).toBe(3);
    expect(await count(db, 'purchases')).toBe(1);
  });
});

describe('chain guard', () => {
  it('rejects seq 3 after seq 1 (gap)', async () => {
    const chain = buildChain(3);
    await insertInvoice(db, chain[0]!);
    await expect(insertInvoice(db, chain[2]!)).rejects.toThrow(/seq must be previous seq \+ 1/);
    expect(await count(db, 'sales')).toBe(1);
  });

  it('rejects a duplicate seq', async () => {
    const chain = buildChain(2);
    await insertInvoice(db, chain[0]!);
    await expect(insertInvoice(db, chain[0]!)).rejects.toThrow();
    expect(await count(db, 'sales')).toBe(1);
  });

  it('rejects a wrong prev_hash', async () => {
    const chain = buildChain(1);
    await insertInvoice(db, chain[0]!);
    const forged = sealInvoice('1'.repeat(64), makeInvoice({ seq: 2, invoiceNo: 'A-000002' }));
    await expect(insertInvoice(db, forged)).rejects.toThrow(/prev_hash must equal/);
  });

  it('rejects seq 1 with a non-genesis prev_hash', async () => {
    const forged = sealInvoice('1'.repeat(64), makeInvoice());
    await expect(insertInvoice(db, forged)).rejects.toThrow(/prev_hash must equal/);
  });

  it('rejects a duplicate hash via UNIQUE', async () => {
    const chain = buildChain(2);
    await insertInvoice(db, chain[0]!);
    const second: Invoice = { ...chain[1]!, hash: chain[0]!.hash };
    await expect(insertInvoice(db, second)).rejects.toThrow(
      /UNIQUE constraint failed: sales\.hash/,
    );
    expect(await count(db, 'sales')).toBe(1);
  });

  it('chains are tracked per device', async () => {
    const otherDevice = newId();
    const otherChain = buildChain(1, otherDevice as Invoice['deviceId']);
    await insertInvoices(db, buildChain(2));
    await insertInvoice(db, otherChain[0]!); // seq 1 for the other device is fine
    expect(await count(db, 'sales')).toBe(3);
  });
});

describe('return and void rules', () => {
  it('accepts a return of a sale, but a return of a return aborts', async () => {
    const [sale] = buildChain(1);
    await insertInvoice(db, sale!);
    const ret = sealInvoice(
      sale!.hash,
      makeReturnUnsealed(sale!, { seq: 2, invoiceNo: 'A-000002' }),
    );
    await insertInvoice(db, ret);
    expect(await count(db, 'sales')).toBe(2);

    const returnOfReturn = sealInvoice(
      ret.hash,
      makeReturnUnsealed(ret, { seq: 3, invoiceNo: 'A-000003' }),
    );
    await expect(insertInvoice(db, returnOfReturn)).rejects.toThrow(
      /original_sale_id must reference a kind=sale/,
    );
  });

  it('rejects a return that points at an unknown original (foreign key / guard)', async () => {
    await expect(
      insertRow(
        db,
        'sales',
        saleRow({
          kind: 'return',
          original_sale_id: newId(),
          subtotal: -1000,
          total: -1000,
        }),
      ),
    ).rejects.toThrow();
  });

  it('a sale with a negative total fails CHECK', async () => {
    await expect(
      insertRow(db, 'sales', saleRow({ subtotal: -1000, total: -1000 })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('a sale with an original_sale_id fails CHECK', async () => {
    const [sale] = buildChain(1);
    await insertInvoice(db, sale!);
    await expect(
      insertRow(
        db,
        'sales',
        saleRow({
          seq: 2,
          invoice_no: 'A-000002',
          prev_hash: sale!.hash,
          original_sale_id: sale!.id,
        }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('a return with a positive total fails CHECK', async () => {
    const [sale] = buildChain(1);
    await insertInvoice(db, sale!);
    await expect(
      insertRow(
        db,
        'sales',
        saleRow({
          seq: 2,
          invoice_no: 'A-000002',
          prev_hash: sale!.hash,
          kind: 'return',
          original_sale_id: sale!.id,
        }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('total <> subtotal - discount_total fails CHECK', async () => {
    await expect(insertRow(db, 'sales', saleRow({ subtotal: 1000, total: 999 }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(
      insertRow(db, 'sales', saleRow({ subtotal: 1000, discount_total: 100, total: 1000 })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('a mismatched line_total fails CHECK', async () => {
    const sale = saleRow();
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(db, 'sale_lines', lineRow(sale.id as string, { line_total: 999 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(
        db,
        'sale_lines',
        lineRow(sale.id as string, {
          quantity: 2,
          unit_price: 500,
          discount_amount: 100,
          line_total: 900,
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('sale_lines CHECKs: zero quantity, both unit and variant, negative price', async () => {
    const sale = saleRow();
    await insertRow(db, 'sales', sale);
    const id = sale.id as string;
    await expect(
      insertRow(db, 'sale_lines', lineRow(id, { quantity: 0, line_total: 0 })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'sale_lines', lineRow(id, { phone_unit_id: SHOP.phoneUnitId })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'sale_lines', lineRow(id, { unit_price: -1, line_total: -1 })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(
        db,
        'sale_lines',
        lineRow(id, {
          variant_id: null,
          phone_unit_id: SHOP.phoneUnitId,
          quantity: 2,
          unit_price: 500,
          line_total: 1000,
        }),
      ),
    ).rejects.toThrow(/CHECK/);
  });
});

describe('khata guard and ledger CHECKs', () => {
  it('rejects a khata payment on a walk-in sale', async () => {
    const sale = saleRow({ customer_id: null });
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(db, 'payments', paymentRow(sale.id as string, { method: 'khata' })),
    ).rejects.toThrow(/khata requires a sale with a customer/);
    await insertRow(db, 'payments', paymentRow(sale.id as string, { method: 'cash' }));
  });

  it('accepts a khata payment when the sale has a customer', async () => {
    const sale = saleRow();
    await insertRow(db, 'sales', sale);
    await insertRow(db, 'payments', paymentRow(sale.id as string, { method: 'khata' }));
    expect(await count(db, 'payments')).toBe(1);
  });

  it('payment CHECKs: zero amount and unknown method', async () => {
    const sale = saleRow();
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(db, 'payments', paymentRow(sale.id as string, { amount: 0 })),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'payments', paymentRow(sale.id as string, { method: 'bitcoin' })),
    ).rejects.toThrow(/CHECK/);
  });

  it('rejects a payment_received with a positive amount', async () => {
    await expect(
      insertRow(db, 'ledger_entries', ledgerRow({ type: 'payment_received', amount: 100 })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'ledger_entries', ledgerRow({ type: 'sale_credit', amount: -100 })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('rejects a supplier row with a customer-only type', async () => {
    await expect(
      insertRow(
        db,
        'ledger_entries',
        ledgerRow({ customer_id: null, supplier_id: SHOP.supplierId, type: 'sale_credit' }),
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      insertRow(db, 'ledger_entries', ledgerRow({ type: 'purchase_credit' })),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it('rejects both parties or neither, a zero amount and method khata', async () => {
    await expect(
      insertRow(db, 'ledger_entries', ledgerRow({ supplier_id: SHOP.supplierId })),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertRow(db, 'ledger_entries', ledgerRow({ customer_id: null }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertRow(db, 'ledger_entries', ledgerRow({ amount: 0 }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertRow(db, 'ledger_entries', ledgerRow({ method: 'khata' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('customer balance example: +150000 -50000 -20000 = 80000', async () => {
    await insertRow(db, 'ledger_entries', ledgerRow({ type: 'sale_credit', amount: 150000 }));
    await insertRow(
      db,
      'ledger_entries',
      ledgerRow({ type: 'payment_received', amount: -50000, method: 'cash' }),
    );
    await insertRow(db, 'ledger_entries', ledgerRow({ type: 'return_credit', amount: -20000 }));
    const rows = await db.query<{ customer_id: string; balance: number }>(
      'select customer_id, balance from v_customer_balance',
    );
    expect(rows).toEqual([{ customer_id: SHOP.customerId, balance: 80000 }]);
  });

  it('supplier balance: positive means the shop owes the supplier', async () => {
    await insertRow(
      db,
      'ledger_entries',
      ledgerRow({
        customer_id: null,
        supplier_id: SHOP.supplierId,
        type: 'purchase_credit',
        amount: 900000,
      }),
    );
    await insertRow(
      db,
      'ledger_entries',
      ledgerRow({
        customer_id: null,
        supplier_id: SHOP.supplierId,
        type: 'payment_made',
        amount: -400000,
        method: 'bank_transfer',
      }),
    );
    const rows = await db.query<{ balance: number }>('select balance from v_supplier_balance');
    expect(rows).toEqual([{ balance: 500000 }]);
  });
});

describe('outbox', () => {
  it('rejects DELETE of an unsent row', async () => {
    const row = outboxRow();
    await insertRow(db, 'outbox', row);
    await expect(db.query('delete from outbox where id = ?', [row.id as string])).rejects.toThrow(
      /unsent entries cannot be deleted/,
    );
  });

  it('rejects UPDATE of payload and the other frozen columns', async () => {
    const row = outboxRow();
    await insertRow(db, 'outbox', row);
    const id = row.id as string;
    await expect(db.query("update outbox set payload = '{}' where id = ?", [id])).rejects.toThrow(
      /only attempts, last_error and sent_at may change/,
    );
    await expect(db.query("update outbox set op = 'update' where id = ?", [id])).rejects.toThrow(
      /only attempts/,
    );
    await expect(db.query('update outbox set created_at = 1 where id = ?', [id])).rejects.toThrow(
      /only attempts/,
    );
    await expect(
      db.query('update outbox set entity_id = ? where id = ?', [newId(), id]),
    ).rejects.toThrow(/only attempts/);
  });

  it('allows UPDATE of attempts, last_error and sent_at, then DELETE once sent', async () => {
    const row = outboxRow();
    await insertRow(db, 'outbox', row);
    const id = row.id as string;
    await db.query('update outbox set attempts = attempts + 1 where id = ?', [id]);
    await db.query("update outbox set last_error = 'timeout' where id = ?", [id]);
    await db.query('update outbox set sent_at = ? where id = ?', [BASE_MS, id]);
    const [after] = await db.query<{ attempts: number; last_error: string; sent_at: number }>(
      'select attempts, last_error, sent_at from outbox where id = ?',
      [id],
    );
    expect(after).toEqual({ attempts: 1, last_error: 'timeout', sent_at: BASE_MS });
    await db.query('delete from outbox where id = ?', [id]);
    expect(await count(db, 'outbox')).toBe(0);
  });

  it('rejects invalid JSON payloads and op = delete', async () => {
    await expect(insertRow(db, 'outbox', outboxRow({ payload: '{not json' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertRow(db, 'outbox', outboxRow({ op: 'delete' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertRow(db, 'outbox', outboxRow({ attempts: -1 }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('drains pending rows in id order (partial index)', async () => {
    const ids = [newId(), newId(), newId()];
    for (const id of [ids[2]!, ids[0]!, ids[1]!]) await insertRow(db, 'outbox', outboxRow({ id }));
    await db.query('update outbox set sent_at = 1 where id = ?', [ids[0]!]);
    const pending = await db.query<{ id: string }>(
      'select id from outbox where sent_at is null order by id',
    );
    expect(pending.map((r) => r.id)).toEqual([ids[1], ids[2]]);
  });
});

describe('foreign keys and users', () => {
  it('a sale_lines row referencing an unknown product fails', async () => {
    const sale = saleRow();
    await insertRow(db, 'sales', sale);
    await expect(
      insertRow(db, 'sale_lines', lineRow(sale.id as string, { product_id: newId() })),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it('a sale for an unknown branch, customer or cashier fails', async () => {
    await expect(insertRow(db, 'sales', saleRow({ branch_id: newId() }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await expect(insertRow(db, 'sales', saleRow({ customer_id: newId() }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
    await expect(insertRow(db, 'sales', saleRow({ cashier_id: newId() }))).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  const user = (over: Record<string, string | number | null>) => ({
    id: newId(),
    username: 'sara',
    display_name: 'Sara',
    role: 'manager',
    pin_hash: 'x',
    is_active: 1,
    created_at: 1,
    updated_at: 1,
    ...over,
  });

  it('rejects a role outside owner/manager/cashier', async () => {
    await expect(insertRow(db, 'users', user({ role: 'admin' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    for (const role of ['owner', 'manager', 'cashier'])
      await insertRow(db, 'users', user({ role, username: `u_${role}` }));
  });

  it('rejects a duplicate username', async () => {
    await expect(insertRow(db, 'users', user({ username: 'ali' }))).rejects.toThrow(
      /UNIQUE constraint failed: users\.username/,
    );
  });

  it('rejects an uppercase or too-short username', async () => {
    await expect(insertRow(db, 'users', user({ username: 'Sara' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
    await expect(insertRow(db, 'users', user({ username: 'ab' }))).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it('master-data CHECKs: CNIC format, boolean flags, product kind', async () => {
    await expect(
      insertRow(db, 'customers', {
        id: newId(),
        name: 'X',
        cnic: '35201-1234567-1',
        created_at: 1,
        updated_at: 1,
      }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'products', {
        id: newId(),
        kind: 'laptop',
        brand: 'B',
        name: 'N',
        created_at: 1,
        updated_at: 1,
      }),
    ).rejects.toThrow(/CHECK/);
    await expect(
      insertRow(db, 'products', {
        id: newId(),
        kind: 'phone',
        brand: 'B',
        name: 'N',
        is_active: 2,
        created_at: 1,
        updated_at: 1,
      }),
    ).rejects.toThrow(/CHECK/);
  });

  it('a migrated empty database (no seed) has no rows to protect', async () => {
    const empty = await createMigratedDb();
    try {
      expect(await count(empty, 'users')).toBe(0);
    } finally {
      empty.close();
    }
  });
});
