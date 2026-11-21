import { beforeEach, describe, expect, it } from 'vitest';
import { DomainError } from '@pos/core';
import { InvoiceSchema, ServiceError, type ServiceErrorCode } from '@pos/shared';
import { mapError } from '../../src/service';
import { movementRow, paymentRow } from '../helpers';
import {
  CHARGER_PRICE,
  CARTON_PRICE,
  expectCode,
  first,
  makeService,
  sellCash,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

describe('verifyChain / checks', () => {
  it('an empty chain is ok with count 0', async () => {
    await t.loginAs('owner');
    const r = await t.svc.integrity.verifyChain();
    expect(r).toMatchObject({ ok: true, count: 0, headSeq: 0 });
  });

  it('needs a session', async () => {
    await expectCode(t.svc.integrity.verifyChain(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.integrity.checks(), 'NOT_AUTHENTICATED');
  });

  it('is ok after mixed sales, returns and voids', async () => {
    await t.loginAs('mgr');
    const a = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 3 }]);
    await sellCash(t, [{ itemId: t.ids.cartonId, quantity: 1 }], { customerId: t.ids.bilalId });
    await t.svc.checkout.createReturn({
      originalSaleId: a.id,
      lines: [{ lineId: first(a.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
    });
    const r = await t.svc.integrity.verifyChain();
    expect(r).toMatchObject({ ok: true, count: 3, headSeq: 3 });
    expect(await t.svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
    });
  });

  it('a tampered total in the middle of the chain is reported with its seq and invoice number', async () => {
    await t.loginAs('owner');
    for (let i = 0; i < 3; i += 1) await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    await t.driver.exec('DROP TRIGGER trg_sales_no_update');
    await t.driver.exec('UPDATE sales SET note = $x WHERE seq = 2'.replace('$x', "'edited'"));
    const r = await t.svc.integrity.verifyChain();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.seq).toBe(2);
      expect(r.invoiceNo).toBe('A-000002');
      expect(r.reason).toMatch(/hash/i);
    }
  });

  it('a deleted middle invoice is detected', async () => {
    await t.loginAs('owner');
    for (let i = 0; i < 3; i += 1) await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    await t.driver.exec('DROP TRIGGER trg_sales_no_delete');
    await t.driver.exec('PRAGMA foreign_keys = OFF');
    await t.driver.exec('DROP TRIGGER trg_sale_lines_no_delete');
    await t.driver.exec('DROP TRIGGER trg_payments_no_delete');
    await t.driver.exec(
      'DELETE FROM payments WHERE sale_id IN (SELECT id FROM sales WHERE seq = 2); DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE seq = 2); DELETE FROM sales WHERE seq = 2;',
    );
    const r = await t.svc.integrity.verifyChain();
    expect(r.ok).toBe(false);
  });

  it('the database refuses edits and deletes of sales unless the trigger was dropped', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    await expect(t.driver.exec("UPDATE sales SET note = 'x'")).rejects.toThrow(/immutable/);
    await expect(t.driver.exec('DELETE FROM sales')).rejects.toThrow(/immutable/);
  });

  it('checks() sees a payment that does not add up to the total', async () => {
    await t.loginAs('owner');
    const inv = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    await t.driver.batch([
      {
        sql: 'insert into payments (id, sale_id, method, amount, reference, created_at) values (?,?,?,?,?,?)',
        params: [t.newId(), inv.id, 'cash', 5, null, inv.createdAt],
      },
    ]);
    expect((await t.svc.integrity.checks()).salePaymentMismatch).toBe(1);
    expect(paymentRow(inv.id).amount).toBeDefined();
  });
});

describe('mapError taxonomy', () => {
  const code = (msg: string): ServiceErrorCode => mapError(new Error(msg)).code;

  it('passes ServiceError through untouched', () => {
    const e = new ServiceError('LICENCE_BLOCKED', 'x', { state: 'LOCKED' });
    expect(mapError(e)).toBe(e);
  });

  it('maps core DomainErrors', () => {
    const cases: [ConstructorParameters<typeof DomainError>[0], ServiceErrorCode][] = [
      ['MONEY_INVALID', 'MONEY_INVALID'],
      ['DISCOUNT_INVALID', 'DISCOUNT_INVALID'],
      ['PAYMENT_MISMATCH', 'PAYMENT_MISMATCH'],
      ['STOCK_INSUFFICIENT', 'STOCK_INSUFFICIENT'],
      ['LEDGER_CORRUPT', 'LEDGER_CORRUPT'],
      ['STOCK_INVALID', 'VALIDATION'],
      ['CANONICAL_INVALID', 'INTERNAL'],
      ['INVOICE_NO_INVALID', 'INTERNAL'],
    ];
    for (const [domain, expected] of cases)
      expect(mapError(new DomainError(domain, 'm')).code, domain).toBe(expected);
  });

  it('maps a Zod error to VALIDATION with the first failing field', () => {
    const parsed = InvoiceSchema.safeParse({ id: 'nope' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const e = mapError(parsed.error);
      expect(e.code).toBe('VALIDATION');
      expect(typeof e.details.field).toBe('string');
      expect(Array.isArray(e.details.issues)).toBe(true);
    }
  });

  it('maps each SQLite trigger / constraint message', () => {
    expect(code('sales: seq must be previous seq + 1 for this device')).toBe('CHAIN_CONFLICT');
    expect(code('sales: prev_hash must equal the hash of the previous invoice')).toBe(
      'CHAIN_CONFLICT',
    );
    expect(code('payments: khata requires a sale with a customer')).toBe('KHATA_NEEDS_CUSTOMER');
    expect(code('sales: original_sale_id must reference a kind=sale invoice')).toBe(
      'RETURN_NOT_ALLOWED',
    );
    expect(code('sales is immutable: corrections are return/void invoices')).toBe(
      'IMMUTABLE_RECORD',
    );
    expect(code('ledger_entries is append-only')).toBe('IMMUTABLE_RECORD');
    expect(code('outbox: only attempts, last_error and sent_at may change')).toBe(
      'IMMUTABLE_RECORD',
    );
    expect(code('FOREIGN KEY constraint failed')).toBe('NOT_FOUND');
    expect(code('CHECK constraint failed: quantity <> 0')).toBe('DB_CONSTRAINT');
    expect(code('NOT NULL constraint failed: users.pin_hash')).toBe('DB_CONSTRAINT');
    expect(code('something unforeseen')).toBe('INTERNAL');
    expect(mapError('a string').code).toBe('INTERNAL');
    expect(mapError(undefined).code).toBe('INTERNAL');
  });

  it('extracts table and field from a UNIQUE violation', () => {
    const e = mapError(new Error('UNIQUE constraint failed: items.sku'));
    expect(e.code).toBe('DUPLICATE');
    expect(e.details).toEqual({ table: 'items', field: 'sku' });
  });

  it('real database errors map through the same rules', async () => {
    await t.loginAs('owner');
    const sale = await sellCash(t, [{ itemId: t.ids.cartonId, quantity: 1 }]);
    const errOf = async (p: Promise<unknown>): Promise<ServiceError> => {
      try {
        await p;
      } catch (e) {
        return mapError(e);
      }
      throw new Error('expected the statement to fail');
    };
    // a sale movement must take stock out: the CHECK is the backstop for the service
    const positiveSale = await errOf(
      t.driver.batch([
        {
          sql: 'insert into stock_movements (id, branch_id, type, item_id, quantity, created_by, created_at) values (?,?,?,?,?,?,?)',
          params: [t.newId(), t.ids.branchId, 'sale', t.ids.cartonId, 1, t.ids.ownerId, 1],
        },
      ]),
    );
    expect(positiveSale.code).toBe('DB_CONSTRAINT');
    expect((await errOf(t.driver.exec("UPDATE sales SET note = 'x'"))).code).toBe(
      'IMMUTABLE_RECORD',
    );
    // a cash sale writes no ledger row, and a row-level trigger needs a row: book one first
    await t.svc.khata.createCustomer({ name: 'Old Debtor', openingBalance: 1_000 });
    expect((await errOf(t.driver.exec('DELETE FROM ledger_entries'))).code).toBe(
      'IMMUTABLE_RECORD',
    );
    expect((await errOf(t.driver.exec("UPDATE outbox SET payload = '{}'"))).code).toBe(
      'IMMUTABLE_RECORD',
    );
    const dup = await errOf(
      t.driver.exec(
        `INSERT INTO items (id, product_id, sku, cost_price, sale_price, created_at, updated_at)
         SELECT '${t.newId()}', product_id, sku, cost_price, sale_price, created_at, updated_at
         FROM items WHERE id = '${t.ids.cartonId}'`,
      ),
    );
    expect(dup.code).toBe('DUPLICATE');
    // khata payment on a sale without customer
    const khata = await errOf(
      t.driver.batch([
        {
          sql: 'insert into payments (id, sale_id, method, amount, reference, created_at) values (?,?,?,?,?,?)',
          params: [t.newId(), sale.id, 'khata', 1, null, 1],
        },
      ]),
    );
    expect(khata.code).toBe('KHATA_NEEDS_CUSTOMER');
    const fk = await errOf(
      t.driver.batch([
        {
          sql: 'insert into sale_lines (id, sale_id, line_no, product_id, item_id, description, quantity, unit_price, cost_price, discount_amount, line_total, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?)',
          params: [t.newId(), t.newId(), 1, t.newId(), t.newId(), 'd', 1, 1, 1, 0, 1, 1],
        },
      ]),
    );
    expect(['NOT_FOUND', 'DB_CONSTRAINT', 'IMMUTABLE_RECORD']).toContain(fk.code);
    expect(movementRow().quantity).toBe(1);
  });

  it('every API call surfaces only ServiceError, never a raw Error', async () => {
    await t.loginAs('owner');
    const raw = [
      t.svc.checkout.getInvoice(t.newId()),
      t.svc.khata.getLedger(t.newId()),
      t.svc.catalog.updateItem(t.newId(), { salePrice: 1 }),
      t.svc.checkout.previewReturn(t.newId(), []),
    ];
    for (const p of raw) {
      const e = await p.then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ServiceError);
    }
    expect(CARTON_PRICE).toBeGreaterThan(0);
  });
});
