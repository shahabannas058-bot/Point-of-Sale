import { describe, expect, it } from 'vitest';
import type { PosService } from '@pos/shared';
import { demoShop, expectCode } from './helpers';

const DAY = 86_400_000;

async function variantBySku(s: PosService, sku: string) {
  const hit = (await s.catalog.search(sku))[0];
  if (!hit || hit.kind !== 'variant') throw new Error(`no ${sku}`);
  return hit.item;
}

async function bilal(s: PosService) {
  const c = (await s.khata.listCustomers({ q: 'Bilal' }))[0];
  if (!c) throw new Error('no Bilal');
  return c;
}

describe('till insights', () => {
  it('shows stock, the last rate to this customer, their balance and 30-day sales', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const cable = await variantBySku(s, 'CBL-C-1M');
    const b = await bilal(s);

    const before = await s.insights.item({ variantId: cable.variant.id, customerId: b.party.id });
    expect(before).toMatchObject({
      onHand: cable.onHand,
      lastSoldToCustomer: null,
      customerBalance: b.balance,
      soldLast30Days: 2, // the seeded walk-in sale
      lastPurchase: null, // cashier has no view_cost
    });

    const inv = await s.checkout.commit({
      lines: [{ variantId: cable.variant.id, quantity: 3, discountAmount: 30_00 }],
      customerId: b.party.id,
      payments: [{ method: 'khata', amount: 3 * cable.variant.salePrice - 30_00 }],
    });

    const after = await s.insights.item({ variantId: cable.variant.id, customerId: b.party.id });
    expect(after.onHand).toBe(cable.onHand - 3);
    expect(after.soldLast30Days).toBe(5);
    // the rate the customer actually paid per unit, after the line discount
    expect(after.lastSoldToCustomer).toEqual({
      unitPrice: cable.variant.salePrice - 10_00,
      at: inv.createdAt,
      invoiceNo: inv.invoiceNo,
    });
    expect(after.customerBalance).toBe(b.balance + 3 * cable.variant.salePrice - 30_00);

    const walkIn = await s.insights.item({ variantId: cable.variant.id });
    expect(walkIn.lastSoldToCustomer).toBeNull();
    expect(walkIn.customerBalance).toBeNull();
  });

  it('nets out returns and only counts the last 30 days', async () => {
    const { s, clock } = await demoShop();
    await s.auth.login('manager', '2345');
    const cable = await variantBySku(s, 'CBL-C-1M');
    const inv = await s.checkout.commit({
      lines: [{ variantId: cable.variant.id, quantity: 4 }],
      payments: [{ method: 'cash', amount: 4 * cable.variant.salePrice }],
    });
    const line = inv.lines[0];
    if (!line) throw new Error('no line');
    await s.checkout.createReturn({
      originalSaleId: inv.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: [{ method: 'cash', amount: cable.variant.salePrice }],
      reason: 'faulty',
    });
    expect((await s.insights.item({ variantId: cable.variant.id })).soldLast30Days).toBe(2 + 4 - 1);

    clock.now += 31 * DAY;
    expect((await s.insights.item({ variantId: cable.variant.id })).soldLast30Days).toBe(0);
  });

  it('shows the latest purchase cost to managers only', async () => {
    const { s } = await demoShop();
    await s.auth.login('manager', '2345');
    const glass = await variantBySku(s, 'GLS-A55');
    const opening = await s.insights.item({ variantId: glass.variant.id });
    expect(opening.lastPurchase?.unitCost).toBe(glass.variant.costPrice);

    const supplier = (await s.purchasing.listSuppliers())[0];
    if (!supplier) throw new Error('no supplier');
    await s.purchasing.receive({
      supplierId: supplier.party.id,
      phones: [],
      accessories: [{ variantId: glass.variant.id, quantity: 10, unitCost: 123_00 }],
    });
    const bought = await s.insights.item({ variantId: glass.variant.id });
    expect(bought.lastPurchase?.unitCost).toBe(123_00);
    expect(bought.onHand).toBe(glass.onHand + 10);
  });

  it('works for a phone unit: in stock = 1, last rate for the same model', async () => {
    const { s } = await demoShop();
    await s.auth.login('owner', '1234');
    const b = await bilal(s);
    const phones = await s.catalog.listPhones({ inStock: true });
    const [first, second] = phones.filter((p) => p.product.id === phones[0]?.product.id);
    const unit = first ?? phones[0];
    if (!unit) throw new Error('no phone');

    const inv = await s.checkout.commit({
      lines: [{ phoneUnitId: unit.unit.id, quantity: 1 }],
      customerId: b.party.id,
      payments: [{ method: 'cash', amount: unit.unit.salePrice }],
    });
    const sold = await s.insights.item({ phoneUnitId: unit.unit.id, customerId: b.party.id });
    expect(sold.onHand).toBe(0);
    expect(sold.lastPurchase?.unitCost).toBe(unit.unit.costPrice);
    expect(sold.lastSoldToCustomer).toEqual({
      unitPrice: unit.unit.salePrice,
      at: inv.createdAt,
      invoiceNo: inv.invoiceNo,
    });
    if (second) {
      const sibling = await s.insights.item({
        phoneUnitId: second.unit.id,
        customerId: b.party.id,
      });
      expect(sibling.onHand).toBe(1);
      expect(sibling.lastSoldToCustomer?.invoiceNo).toBe(inv.invoiceNo);
    }
  });

  it('rejects bad input and needs a session', async () => {
    const { s } = await demoShop();
    await expectCode(s.insights.item({ variantId: 'x' }), 'NOT_AUTHENTICATED');
    await s.auth.login('cashier', '3456');
    const cable = await variantBySku(s, 'CBL-C-1M');
    await expectCode(s.insights.item({}), 'VALIDATION');
    await expectCode(
      s.insights.item({ variantId: cable.variant.id, phoneUnitId: 'x' }),
      'VALIDATION',
    );
    await expectCode(s.insights.item({ variantId: 'missing' }), 'NOT_FOUND');
    await expectCode(s.insights.item({ phoneUnitId: 'missing' }), 'NOT_FOUND');
  });
});

describe('reorder suggestions', () => {
  it('lists items at or below the reorder level with the suggested quantity', async () => {
    const { s } = await demoShop();
    await s.auth.login('manager', '2345');
    const cable = await variantBySku(s, 'CBL-C-1M'); // 2 sold in the seed
    await s.catalog.updateVariant(cable.variant.id, { reorderLevel: cable.onHand });

    const rows = await s.insights.reorder();
    const row = rows.find((r) => r.item.variant.id === cable.variant.id);
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      sold: 2,
      dailyAvg: 0.07,
      daysLeft: Math.floor((cable.onHand * 30) / 2), // integer maths, no float drift
      // reorderLevel + ceil(avg * 14) - onHand = onHand + 1 - onHand
      suggestedQty: 1,
      unitCost: cable.variant.costPrice,
    });
    // well-stocked, slow items are not listed
    expect(
      rows.every((r) => r.item.onHand <= r.item.variant.reorderLevel || (r.daysLeft ?? 99) <= 7),
    ).toBe(true);
  });

  it('flags fast movers that run out within 7 days even above the reorder level', async () => {
    const { s } = await demoShop();
    await s.auth.login('manager', '2345');
    const charger = await variantBySku(s, 'CHG-25-BLK'); // 14 opening, 2 sold in the seed
    const supplier = (await s.purchasing.listSuppliers())[0];
    if (!supplier) throw new Error('no supplier');
    await s.purchasing.receive({
      supplierId: supplier.party.id,
      phones: [],
      accessories: [{ variantId: charger.variant.id, quantity: 40, unitCost: 950_00 }],
    });
    const onHand = charger.onHand + 40;
    const sellNow = onHand - 6; // leave 6, just above the level of 5
    await s.checkout.commit({
      lines: [{ variantId: charger.variant.id, quantity: sellNow }],
      payments: [{ method: 'cash', amount: sellNow * charger.variant.salePrice }],
    });
    const sold = 2 + sellNow;
    const rows = await s.insights.reorder();
    const row = rows.find((r) => r.item.variant.id === charger.variant.id);
    expect(row).toMatchObject({
      sold,
      dailyAvg: Math.round((sold / 30) * 100) / 100,
      daysLeft: Math.floor((6 * 30) / sold),
      suggestedQty: 5 + Math.ceil((sold * 14) / 30) - 6,
      unitCost: 950_00, // latest purchase beats the item cost
    });
    expect(row?.daysLeft).toBeLessThanOrEqual(7);
    // most urgent first
    const days = rows.map((r) => r.daysLeft ?? Number.POSITIVE_INFINITY);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
  });

  it('hides cost from cashiers and validates options', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const rows = await s.insights.reorder({ days: 7, coverDays: 7 });
    expect(rows.every((r) => r.unitCost === null)).toBe(true);
    await expectCode(s.insights.reorder({ days: 0 }), 'VALIDATION');
    await expectCode(s.insights.reorder({ coverDays: 181 }), 'VALIDATION');
  });
});
