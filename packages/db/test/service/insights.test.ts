import { beforeEach, describe, expect, it } from 'vitest';
import type { ItemView } from '@pos/shared';
import {
  CHARGER_COST,
  CHARGER_PRICE,
  CARTON_COST,
  CARTON_PRICE,
  expectCode,
  first,
  makeService,
  sellCash,
  type TestService,
} from './helpers';

const DAY = 86_400_000;

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

async function addSupplier(): Promise<string> {
  return (await t.svc.purchasing.createSupplier({ name: 'Hall Road Traders' })).id;
}

async function addChini(openingGrams: number): Promise<ItemView> {
  return t.svc.catalog.createItem({
    product: { brand: 'Loose', name: 'Chini (sugar)', category: 'Grocery' },
    sku: 'CHINI-LOOSE',
    costPrice: 25_000, // Rs 250 per kg
    salePrice: 28_550,
    reorderLevel: 5_000,
    openingQty: openingGrams,
    unit: 'kg',
  });
}

describe('insights: till info', () => {
  it('shows stock, 30-day sales, and the last rate and balance for the customer', async () => {
    await t.loginAs('cash');
    const walkIn = await t.svc.insights.item({ itemId: t.ids.chargerId });
    expect(walkIn).toEqual({
      onHand: 10,
      lastPurchase: null, // cashier has no view_cost
      lastSoldToCustomer: null,
      customerBalance: null,
      soldLast30Days: 0,
    });

    const inv = await sellCash(
      t,
      [{ itemId: t.ids.chargerId, quantity: 3, discountAmount: 3_000 }],
      { customerId: t.ids.bilalId },
    );
    const after = await t.svc.insights.item({
      itemId: t.ids.chargerId,
      customerId: t.ids.bilalId,
    });
    expect(after).toMatchObject({
      onHand: 7,
      soldLast30Days: 3,
      customerBalance: 0, // paid cash
      // what Bilal actually paid per piece, after the line discount
      lastSoldToCustomer: {
        unitPrice: CHARGER_PRICE - 1_000,
        at: inv.createdAt,
        invoiceNo: inv.invoiceNo,
      },
    });
  });

  it('nets out returns and only counts the last 30 days', async () => {
    await t.loginAs('mgr');
    const inv = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 4 }]);
    await t.svc.checkout.createReturn({
      originalSaleId: inv.id,
      lines: [{ lineId: first(inv.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'faulty',
    });
    expect((await t.svc.insights.item({ itemId: t.ids.chargerId })).soldLast30Days).toBe(3);

    t.clock.advance(31 * DAY);
    expect((await t.svc.insights.item({ itemId: t.ids.chargerId })).soldLast30Days).toBe(0);
  });

  it('shows the latest purchase cost to managers', async () => {
    await t.loginAs('mgr');
    const opening = await t.svc.insights.item({ itemId: t.ids.chargerId });
    expect(opening.lastPurchase?.unitCost).toBe(CHARGER_COST);

    await t.svc.purchasing.receive({
      supplierId: await addSupplier(),
      items: [{ itemId: t.ids.chargerId, quantity: 5, unitCost: 95_000 }],
    });
    const bought = await t.svc.insights.item({ itemId: t.ids.chargerId });
    expect(bought.lastPurchase?.unitCost).toBe(95_000);
    expect(bought.onHand).toBe(15);
  });

  it('a single-piece item: on hand goes 1 -> 0, opening stock gives the last cost', async () => {
    await t.loginAs('owner');
    const before = await t.svc.insights.item({ itemId: t.ids.cartonId });
    expect(before.onHand).toBe(1);
    expect(before.lastPurchase?.unitCost).toBe(CARTON_COST);

    const inv = await sellCash(t, [{ itemId: t.ids.cartonId, quantity: 1 }], {
      customerId: t.ids.bilalId,
    });
    const sold = await t.svc.insights.item({
      itemId: t.ids.cartonId,
      customerId: t.ids.bilalId,
    });
    expect(sold).toMatchObject({
      onHand: 0,
      soldLast30Days: 1,
      lastSoldToCustomer: { unitPrice: CARTON_PRICE, invoiceNo: inv.invoiceNo },
    });
  });

  it('gives the last rate per kg for goods sold by weight', async () => {
    await t.loginAs('owner');
    const chini = await addChini(20_000);
    await sellCash(t, [{ itemId: chini.item.id, quantity: 1_500 }], {
      customerId: t.ids.bilalId,
    });
    const info = await t.svc.insights.item({
      itemId: chini.item.id,
      customerId: t.ids.bilalId,
    });
    expect(info.onHand).toBe(18_500);
    expect(info.soldLast30Days).toBe(1_500);
    // 1.5 kg x Rs 285.50 = Rs 428.25; per kg that is the sale price again
    expect(info.lastSoldToCustomer?.unitPrice).toBe(28_550);
  });

  it('rejects bad input and needs a session', async () => {
    await expectCode(t.svc.insights.item({ itemId: t.ids.chargerId }), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    await expectCode(t.svc.insights.item({} as never), 'VALIDATION');
    await expectCode(t.svc.insights.item({ itemId: 42 } as never), 'VALIDATION');
    await expectCode(t.svc.insights.item({ itemId: 'missing' }), 'NOT_FOUND');
    await expectCode(
      t.svc.insights.item({ itemId: t.ids.chargerId, customerId: 'missing' }),
      'NOT_FOUND',
    );
  });
});

describe('insights: reorder suggestions', () => {
  it('lists an item at its reorder level with the suggested quantity', async () => {
    await t.loginAs('mgr');
    await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 7 }]); // 3 left, level 3
    const row = first(await t.svc.insights.reorder());
    expect(row.item.item.id).toBe(t.ids.chargerId);
    expect(row).toMatchObject({
      sold: 7,
      dailyAvg: 0.23,
      daysLeft: Math.floor((3 * 30) / 7),
      // level 3 + ceil(7 x 14 / 30) = 3 + 4, minus 3 on hand
      suggestedQty: 4,
      unitCost: CHARGER_COST,
    });
  });

  it('does not list well-stocked slow items', async () => {
    await t.loginAs('mgr');
    expect(await t.svc.insights.reorder()).toEqual([]);
  });

  it('flags a fast mover that runs out within 7 days even above its level', async () => {
    await t.loginAs('mgr');
    await t.svc.purchasing.receive({
      supplierId: await addSupplier(),
      items: [{ itemId: t.ids.chargerId, quantity: 40, unitCost: 95_000 }],
    });
    await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 44 }]); // 6 left, level 3
    const row = first(await t.svc.insights.reorder());
    expect(row).toMatchObject({
      sold: 44,
      daysLeft: Math.floor((6 * 30) / 44),
      suggestedQty: 3 + Math.ceil((44 * 14) / 30) - 6,
      unitCost: 95_000, // latest purchase beats the opening cost
    });
  });

  it('works in grams for goods sold by weight', async () => {
    await t.loginAs('owner');
    const chini = await addChini(6_000); // 6 kg, reorder at 5 kg
    await sellCash(t, [{ itemId: chini.item.id, quantity: 1_500 }]); // 4.5 kg left
    const row = (await t.svc.insights.reorder()).find((r) => r.item.item.id === chini.item.id);
    expect(row).toMatchObject({
      sold: 1_500,
      // 5 kg + ceil(1500 g x 14 / 30) = 5000 + 700, minus 4500 g on hand
      suggestedQty: 1_200,
      unitCost: 25_000, // per kg
    });
  });

  it('hides cost from cashiers and validates options', async () => {
    await t.loginAs('cash');
    await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 8 }]);
    const rows = await t.svc.insights.reorder({ days: 7, coverDays: 7 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.unitCost === null)).toBe(true);
    await expectCode(t.svc.insights.reorder({ days: 0 }), 'VALIDATION');
    await expectCode(t.svc.insights.reorder({ coverDays: 181 }), 'VALIDATION');
  });
});
