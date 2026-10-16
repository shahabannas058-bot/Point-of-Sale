import { beforeEach, describe, expect, it } from 'vitest';
import { InvoiceSchema } from '@pos/shared';
import {
  CHARGER_PRICE,
  IMEI_Y,
  PHONE_COST,
  PHONE_PRICE,
  expectCode,
  makeService,
  type TestService,
} from './helpers';

interface OutboxRow {
  id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload: string;
  created_at: number;
  attempts: number;
  sent_at: number | null;
}

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const outboxCount = async (): Promise<number> =>
  (await t.driver.query<{ n: number }>('select count(*) as n from outbox'))[0]?.n ?? 0;

/** Outbox rows appended after `skip` rows, in write (rowid) order. */
const rowsAfter = (skip: number): Promise<OutboxRow[]> =>
  t.driver.query<OutboxRow>('select * from outbox order by rowid limit -1 offset ?', [skip]);

describe('outbox (spec 12)', () => {
  it('a sale with 2 lines and a khata part writes sale, 2 stock movements and 1 ledger entry', async () => {
    await t.loginAs('owner');
    const skip = await outboxCount();
    const inv = await t.svc.checkout.commit({
      lines: [
        { variantId: t.ids.chargerId, quantity: 2 },
        { phoneUnitId: t.ids.phoneId, quantity: 1 },
      ],
      customerId: t.ids.bilalId,
      payments: [
        { method: 'cash', amount: 3_000_000 },
        { method: 'khata', amount: 300_000 + PHONE_PRICE - 3_000_000 },
      ],
    });
    const rows = await rowsAfter(skip);
    expect(rows.map((r) => r.entity_type).sort()).toEqual([
      'ledger_entry',
      'sale',
      'stock_movement',
      'stock_movement',
    ]);
    expect(rows.every((r) => r.sent_at === null && r.attempts === 0 && r.op === 'insert')).toBe(
      true,
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(4);

    const saleRow = rows.find((r) => r.entity_type === 'sale');
    expect(saleRow?.entity_id).toBe(inv.id);
    const payload = InvoiceSchema.parse(JSON.parse(saleRow?.payload ?? 'null'));
    expect(payload.hash).toBe(inv.hash);
    expect(payload.lines).toHaveLength(2);
    expect(payload.payments).toHaveLength(2);

    const moves = rows.filter((r) => r.entity_type === 'stock_movement');
    const quantities = moves.map((m) => (JSON.parse(m.payload) as { quantity: number }).quantity);
    expect(quantities.sort((a, b) => a - b)).toEqual([-2, -1]);
    const ledger = rows.find((r) => r.entity_type === 'ledger_entry');
    expect(JSON.parse(ledger?.payload ?? '{}')).toMatchObject({
      type: 'sale_credit',
      customerId: t.ids.bilalId,
      saleId: inv.id,
    });
  });

  it('a return writes a sale row plus positive stock movements', async () => {
    await t.loginAs('mgr');
    const sale = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      payments: [{ method: 'cash', amount: 2 * CHARGER_PRICE }],
    });
    const skip = await outboxCount();
    const line = sale.lines[0];
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line?.id ?? '', quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
    });
    const rows = await rowsAfter(skip);
    expect(rows.map((r) => r.entity_type).sort()).toEqual(['sale', 'stock_movement']);
    const move = rows.find((r) => r.entity_type === 'stock_movement');
    expect(JSON.parse(move?.payload ?? '{}')).toMatchObject({ quantity: 1, type: 'return' });
  });

  it('createCustomer emits a customer row (and a ledger row for an opening balance)', async () => {
    await t.loginAs('cash');
    const skip = await outboxCount();
    const c = await t.svc.khata.createCustomer({ name: 'Hamza', openingBalance: 10_000 });
    const rows = await rowsAfter(skip);
    expect(rows.map((r) => r.entity_type).sort()).toEqual(['customer', 'ledger_entry']);
    const customer = rows.find((r) => r.entity_type === 'customer');
    expect(customer?.entity_id).toBe(c.id);
    expect(JSON.parse(customer?.payload ?? '{}')).toMatchObject({ id: c.id, name: 'Hamza' });
  });

  it('firstRun emits a branch row and a user row', async () => {
    const fresh = await makeService({ seed: false });
    const shop = await fresh.svc.setup.firstRun({
      shopName: 'S',
      branchName: 'Main',
      invoicePrefix: 'A',
      owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
    });
    const rows = await fresh.driver.query<OutboxRow>('select * from outbox order by rowid');
    expect(rows.map((r) => [r.entity_type, r.op])).toEqual([
      ['branch', 'insert'],
      ['user', 'insert'],
    ]);
    expect(rows[0]?.entity_id).toBe(shop.branchId);
    expect(JSON.parse(rows[1]?.payload ?? '{}')).toMatchObject({
      username: 'owner',
      role: 'owner',
    });
  });

  it('catalog writes emit product, phone_unit, accessory_variant and stock_movement rows', async () => {
    await t.loginAs('mgr');
    const skip = await outboxCount();
    await t.svc.catalog.createPhoneUnit({
      product: { brand: 'Infinix', name: 'Hot 40' },
      imei1: IMEI_Y,
      ptaStatus: 'approved',
      condition: 'new',
      costPrice: PHONE_COST,
      salePrice: PHONE_PRICE,
    });
    const rows = await rowsAfter(skip);
    expect(rows.map((r) => r.entity_type).sort()).toEqual([
      'phone_unit',
      'product',
      'stock_movement',
    ]);
  });

  it('rows are immutable except attempts / last_error / sent_at; unsent rows cannot be deleted', async () => {
    await t.loginAs('owner');
    await expect(t.driver.exec("UPDATE outbox SET payload = '{}'")).rejects.toThrow(
      /only attempts, last_error/,
    );
    await expect(t.driver.exec('DELETE FROM outbox')).rejects.toThrow(
      /unsent entries cannot be deleted/,
    );
    await t.driver.exec('UPDATE outbox SET attempts = attempts + 1');
    await t.driver.exec('UPDATE outbox SET sent_at = 1');
    await t.driver.exec('DELETE FROM outbox'); // sent rows may be pruned
    expect(await outboxCount()).toBe(0);
  });

  it('a blocked or failed write leaves the outbox untouched', async () => {
    await t.loginAs('owner');
    const before = await outboxCount();
    t.assertCanSell.mockRejectedValueOnce(new Error('locked'));
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'cash', amount: CHARGER_PRICE }],
      }),
      'INTERNAL',
    );
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 99 }],
        payments: [{ method: 'cash', amount: CHARGER_PRICE }],
      }),
      'STOCK_INSUFFICIENT',
    );
    expect(await outboxCount()).toBe(before);
  });

  it('integrity.checks counts unsent outbox rows', async () => {
    await t.loginAs('owner');
    const total = await outboxCount();
    expect((await t.svc.integrity.checks()).unsentOutbox).toBe(total);
    await t.driver.exec('UPDATE outbox SET sent_at = 1 WHERE rowid <= 3');
    expect((await t.svc.integrity.checks()).unsentOutbox).toBe(total - 3);
  });
});
