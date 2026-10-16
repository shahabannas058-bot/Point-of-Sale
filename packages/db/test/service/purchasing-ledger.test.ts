import { beforeEach, describe, expect, it } from 'vitest';
import type { NewPhoneUnitInput } from '@pos/shared';
import {
  CHARGER_COST,
  IMEI_Y,
  PHONE_COST,
  PHONE_PRICE,
  expectCode,
  first,
  makeService,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const newPhone = (over: Partial<NewPhoneUnitInput> = {}): NewPhoneUnitInput => ({
  product: { brand: 'Infinix', name: 'Hot 40 Pro' },
  imei1: IMEI_Y,
  ptaStatus: 'approved',
  condition: 'new',
  costPrice: PHONE_COST,
  salePrice: PHONE_PRICE,
  ...over,
});

async function makeSupplier(name = 'Hafeez Centre Traders'): Promise<string> {
  return (await t.svc.purchasing.createSupplier({ name })).id;
}

/** Phone (7 800 000) + 10 chargers (900 000) = 8 700 000, 2 000 000 paid now, supplier invoice INV-9001. */
async function receiveBig(supplierId: string): Promise<void> {
  await t.svc.purchasing.receive({
    supplierId,
    referenceNo: 'INV-9001',
    phones: [newPhone()],
    accessories: [{ variantId: t.ids.chargerId, quantity: 10, unitCost: CHARGER_COST }],
    paidNow: { method: 'cash', amount: 2_000_000 },
  });
}

describe('supplier ledger (getLedger)', () => {
  it('a new supplier has an empty ledger and a zero balance', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    const r = await t.svc.purchasing.getLedger(supplierId);
    expect(r.supplier).toMatchObject({ id: supplierId, name: 'Hafeez Centre Traders' });
    expect(r.balance).toBe(0);
    expect(r.lines).toEqual([]);
  });

  it('lists newest first with a cumulative running balance and the supplier invoice number', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await receiveBig(supplierId);
    await t.svc.purchasing.paySupplier({
      supplierId,
      amount: 6_700_000,
      method: 'bank_transfer',
      note: 'cleared',
    });

    const r = await t.svc.purchasing.getLedger(supplierId);
    expect(r.balance).toBe(0);
    expect(
      r.lines.map((l) => [l.entry.type, l.entry.amount, l.runningBalance, l.referenceNo]),
    ).toEqual([
      ['payment_made', -6_700_000, 0, null], // standalone payment: no purchase behind it
      ['payment_made', -2_000_000, 6_700_000, 'INV-9001'], // paid at receipt
      ['purchase_credit', 8_700_000, 8_700_000, 'INV-9001'],
    ]);
    expect(first(r.lines).entry).toMatchObject({
      supplierId,
      customerId: null,
      method: 'bank_transfer',
      note: 'cleared',
    });
  });

  it('keeps each supplier on its own balance', async () => {
    await t.loginAs('mgr');
    const a = await makeSupplier('Supplier A');
    const b = await makeSupplier('Supplier B');
    await receiveBig(a);
    await t.svc.purchasing.paySupplier({ supplierId: b, amount: 10_000, method: 'cash' });

    const ledgerA = await t.svc.purchasing.getLedger(a);
    const ledgerB = await t.svc.purchasing.getLedger(b);
    expect(ledgerA.balance).toBe(6_700_000);
    expect(ledgerA.lines).toHaveLength(2);
    expect(ledgerB.balance).toBe(-10_000); // advance
    expect(ledgerB.lines.map((l) => l.runningBalance)).toEqual([-10_000]);
  });

  it('pages with limit / beforeCreatedAt and keeps running balances cumulative across pages', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await receiveBig(supplierId); // purchase_credit + payment_made share one timestamp
    await t.svc.purchasing.paySupplier({ supplierId, amount: 100, method: 'cash' });

    const page1 = await t.svc.purchasing.getLedger(supplierId, { limit: 1 });
    expect(page1.lines).toHaveLength(1);
    expect(first(page1.lines).runningBalance).toBe(6_699_900);
    expect(page1.balance).toBe(6_699_900); // the balance is the whole ledger, not the page

    const page2 = await t.svc.purchasing.getLedger(supplierId, {
      beforeCreatedAt: first(page1.lines).entry.createdAt,
    });
    expect(page2.lines.map((l) => l.runningBalance)).toEqual([6_700_000, 8_700_000]);
  });

  it('validates the limit, the supplier and the permission', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await expectCode(t.svc.purchasing.getLedger(supplierId, { limit: 0 }), 'VALIDATION');
    await expectCode(t.svc.purchasing.getLedger(supplierId, { limit: 1001 }), 'VALIDATION');
    await expectCode(t.svc.purchasing.getLedger(t.newId()), 'NOT_FOUND');

    t.svc.auth.logout();
    await expectCode(t.svc.purchasing.getLedger(supplierId), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    await expectCode(t.svc.purchasing.getLedger(supplierId), 'FORBIDDEN');
  });
});

describe('supplier payables (totals)', () => {
  it('is zero without any supplier entries', async () => {
    await t.loginAs('mgr');
    expect(await t.svc.purchasing.totals()).toEqual({ payable: 0, suppliersOwed: 0 });
  });

  it('sums only suppliers the shop owes; an advance does not offset another supplier', async () => {
    await t.loginAs('mgr');
    const a = await makeSupplier('Supplier A');
    const b = await makeSupplier('Supplier B');
    await makeSupplier('Supplier C (no entries)');
    await receiveBig(a); // owes 6 700 000
    await t.svc.purchasing.paySupplier({ supplierId: b, amount: 50_000, method: 'cash' }); // advance

    expect(await t.svc.purchasing.totals()).toEqual({ payable: 6_700_000, suppliersOwed: 1 });

    await t.svc.purchasing.paySupplier({ supplierId: a, amount: 6_700_000, method: 'cash' });
    expect(await t.svc.purchasing.totals()).toEqual({ payable: 0, suppliersOwed: 0 });
  });

  it('is visible to owner and manager but not to a cashier', async () => {
    await t.loginAs('owner');
    expect((await t.svc.purchasing.totals()).suppliersOwed).toBe(0);
    await t.loginAs('cash');
    await expectCode(t.svc.purchasing.totals(), 'FORBIDDEN');
    t.svc.auth.logout();
    await expectCode(t.svc.purchasing.totals(), 'NOT_AUTHENTICATED');
  });
});
