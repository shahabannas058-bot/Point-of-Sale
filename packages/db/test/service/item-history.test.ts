import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemHistoryEntry, ItemHistoryPage, ItemRef } from '@pos/shared';
import { addMilk, receive, shopOf } from './batch-helpers';
import { expectCode, first, makeService, sellCash, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const SUPPLIER_REF = 'SUP-INV-77';

interface Fixture {
  itemId: string;
  invoiceNos: { cashSale: string; bilalSale: string; ret: string };
  /** The clock value just before the return was created (first entry of the "from" window). */
  returnFrom: number;
}

/**
 * A fresh item (no opening stock) with: purchase +10, sale -2 (cashier), sale -3 (owner, Bilal),
 * return +1, adjustment -1 and a write-off -1. Ends logged in as owner. On hand = 4.
 */
async function buildItemFixture(): Promise<Fixture> {
  await t.loginAs('owner');
  const protector = await t.svc.catalog.createItem({
    product: { brand: 'Generic', name: 'Screen Protector', category: 'Protector' },
    sku: 'SP-A55',
    costPrice: 20_000,
    salePrice: 50_000,
    reorderLevel: 2,
  });
  const itemId = protector.item.id;
  const supplier = await t.svc.purchasing.createSupplier({ name: 'Karachi Wholesale' });
  await t.svc.purchasing.receive({
    supplierId: supplier.id,
    referenceNo: SUPPLIER_REF,
    items: [{ itemId, quantity: 10, unitCost: 20_000 }],
  });

  t.svc.auth.logout();
  await t.loginAs('cash');
  const cashSale = await sellCash(t, [{ itemId, quantity: 2 }]);
  t.svc.auth.logout();
  await t.loginAs('owner');
  const bilalSale = await sellCash(t, [{ itemId, quantity: 3 }], { customerId: t.ids.bilalId });

  const returnFrom = t.clock.peek();
  const ret = await t.svc.checkout.createReturn({
    originalSaleId: bilalSale.id,
    lines: [{ lineId: first(bilalSale.lines).id, quantity: 1 }],
    refund: [{ method: 'cash', amount: 50_000 }],
    reason: 'Scratched',
  });
  await t.svc.catalog.adjustStock({ itemId, delta: -1, reason: 'Damaged in store' });

  await t.svc.catalog.adjustStock({ itemId, delta: -1, reason: 'Written off' });

  return {
    itemId,
    invoiceNos: {
      cashSale: cashSale.invoiceNo,
      bilalSale: bilalSale.invoiceNo,
      ret: ret.invoiceNo,
    },
    returnFrom,
  };
}

const kinds = (p: ItemHistoryPage): string[] => p.entries.map((e) => e.kind);
const quantities = (p: ItemHistoryPage): number[] => p.entries.map((e) => e.quantity);
const balances = (p: ItemHistoryPage): number[] => p.entries.map((e) => e.balanceAfter);

describe('catalog.itemHistory: a piece item', () => {
  it('lists every movement newest first with kinds, refs, signed quantities and running balance', async () => {
    const f = await buildItemFixture();

    const page = await t.svc.catalog.itemHistory({ itemId: f.itemId });

    expect(page.entries).toHaveLength(6);
    expect(page.nextBefore).toBeNull();
    expect(kinds(page)).toEqual(['adjustment', 'adjustment', 'return', 'sale', 'sale', 'purchase']);
    expect(quantities(page)).toEqual([-1, -1, 1, -3, -2, 10]);
    expect(balances(page)).toEqual([4, 5, 6, 5, 8, 10]);
    // newest first: created_at strictly descending
    for (let i = 1; i < page.entries.length; i += 1)
      expect(page.entries[i - 1]!.at).toBeGreaterThan(page.entries[i]!.at);

    const [writeOff, adjustment, ret, bilalSale, cashSale, purchase] = page.entries as [
      ItemHistoryEntry,
      ItemHistoryEntry,
      ItemHistoryEntry,
      ItemHistoryEntry,
      ItemHistoryEntry,
      ItemHistoryEntry,
    ];
    expect(writeOff.ref).toEqual({ kind: 'adjustment' });
    expect(writeOff.reason).toBe('Written off');
    expect(adjustment.ref).toEqual({ kind: 'adjustment' });
    expect(adjustment.reason).toBe('Damaged in store');
    expect(ret.ref).toMatchObject({
      kind: 'return',
      invoiceNo: f.invoiceNos.ret,
      customerName: 'Bilal',
    });
    expect(bilalSale.ref).toMatchObject({
      kind: 'sale',
      invoiceNo: f.invoiceNos.bilalSale,
      customerName: 'Bilal',
    });
    expect(cashSale.ref).toMatchObject({
      kind: 'sale',
      invoiceNo: f.invoiceNos.cashSale,
      customerName: null,
    });
    expect(cashSale.by.displayName).toBe('Cashier');
    expect(bilalSale.by).toEqual({ id: t.ids.ownerId, displayName: 'Owner' });
    expect(purchase.ref).toMatchObject({
      kind: 'purchase',
      supplierName: 'Karachi Wholesale',
      referenceNo: SUPPLIER_REF,
    });
    expect(purchase.unitCost).toBe(20_000);
    // the ids of the linked rows are real UUIDs, not just present
    const linked = [ret.ref, bilalSale.ref, cashSale.ref, purchase.ref].map((r) =>
      'saleId' in r ? r.saleId : 'purchaseId' in r ? r.purchaseId : '',
    );
    for (const id of linked) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(purchase.batch).toBeNull();

    expect(page.summary).toEqual({
      purchased: 10,
      sold: 5,
      returned: 1,
      adjusted: -2,
      onHand: 4,
    });
  });

  it('walks every entry exactly once through nextBefore with limit 2', async () => {
    const f = await buildItemFixture();
    const all = await t.svc.catalog.itemHistory({ itemId: f.itemId });

    const seen: string[] = [];
    let before: { at: number; id: string } | undefined;
    let pages = 0;
    do {
      const page = await t.svc.catalog.itemHistory({ itemId: f.itemId }, { limit: 2, before });
      pages += 1;
      expect(page.entries.length).toBeLessThanOrEqual(2);
      seen.push(...page.entries.map((e) => e.id));
      before = page.nextBefore ?? undefined;
    } while (before !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(all.entries.map((e) => e.id));
    expect(new Set(seen).size).toBe(6);
  });

  it('narrows entries with from/to but keeps onHand as the all-time total', async () => {
    const f = await buildItemFixture();

    const page = await t.svc.catalog.itemHistory({ itemId: f.itemId }, { from: f.returnFrom });

    expect(kinds(page)).toEqual(['adjustment', 'adjustment', 'return']);
    // the running balance keeps counting from the full ledger, not from the window
    expect(balances(page)).toEqual([4, 5, 6]);
    expect(page.summary).toEqual({ purchased: 0, sold: 0, returned: 1, adjusted: -2, onHand: 4 });

    const older = await t.svc.catalog.itemHistory({ itemId: f.itemId }, { to: f.returnFrom - 1 });
    expect(kinds(older)).toEqual(['sale', 'sale', 'purchase']);
    expect(older.summary).toEqual({ purchased: 10, sold: 5, returned: 0, adjusted: 0, onHand: 4 });
  });

  it('clamps an out-of-range integer limit instead of rejecting it', async () => {
    const f = await buildItemFixture();
    const page = await t.svc.catalog.itemHistory({ itemId: f.itemId }, { limit: 0 });
    expect(page.entries).toHaveLength(1);
    expect(page.nextBefore).not.toBeNull();
  });
});

describe('catalog.itemHistory: batches (kiryana)', () => {
  it('carries the batch number and expiry of a batch-tracked movement', async () => {
    const k = await shopOf();
    const milk = await addMilk(k);
    await receive(k, milk.item.id, [{ qty: 5, days: 30, batchNo: 'B-30' }]);
    const batch = first(await k.svc.batches.list({ itemId: milk.item.id }), 'batch');

    const page = await k.svc.catalog.itemHistory({ itemId: milk.item.id });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      kind: 'purchase',
      quantity: 5,
      balanceAfter: 5,
      batch: { id: batch.id, batchNo: 'B-30', expiryDate: batch.expiryDate },
    });
    expect(page.entries[0]!.ref).toMatchObject({
      kind: 'purchase',
      supplierName: 'Dairy Distributors',
    });
  });
});

describe('catalog.itemHistory: validation and access', () => {
  it('rejects a bad ref, limit, range or cursor with VALIDATION and an unknown item with NOT_FOUND', async () => {
    await t.loginAs('owner');
    const h = (ref: unknown, q?: unknown): Promise<ItemHistoryPage> =>
      t.svc.catalog.itemHistory(ref as ItemRef, q as undefined);

    await expectCode(h({}), 'VALIDATION');
    await expectCode(h(null), 'VALIDATION');
    await expectCode(h({ itemId: 'not-a-uuid' }), 'VALIDATION');
    await expectCode(h({ itemId: 42 }), 'VALIDATION');
    await expectCode(h({ itemId: t.ids.chargerId }, { limit: 'many' }), 'VALIDATION');
    await expectCode(h({ itemId: t.ids.chargerId }, { limit: 2.5 }), 'VALIDATION');
    await expectCode(h({ itemId: t.ids.chargerId }, { from: -1 }), 'VALIDATION');
    await expectCode(h({ itemId: t.ids.chargerId }, { from: 10, to: 5 }), 'VALIDATION');
    await expectCode(
      h({ itemId: t.ids.chargerId }, { before: { at: 1, id: 'nope' } }),
      'VALIDATION',
    );
    await expectCode(h({ itemId: t.newId() }), 'NOT_FOUND');
  });

  it('needs a session, and a cashier may read it', async () => {
    await expectCode(t.svc.catalog.itemHistory({ itemId: t.ids.chargerId }), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    const page = await t.svc.catalog.itemHistory({ itemId: t.ids.chargerId });
    // the seeded charger has its opening stock as one adjustment
    expect(kinds(page)).toEqual(['adjustment']);
    expect(page.summary.onHand).toBe(10);
  });
  it('unitCost is hidden from roles without view_cost', async () => {
    await t.loginAs('owner');
    const owner = await t.svc.catalog.itemHistory({ itemId: t.ids.chargerId });
    expect(owner.entries.some((e) => e.unitCost !== null)).toBe(true);
    await t.loginAs('cash');
    const cashier = await t.svc.catalog.itemHistory({ itemId: t.ids.chargerId });
    expect(cashier.entries.every((e) => e.unitCost === null)).toBe(true);
  });
});
