import { describe, expect, it } from 'vitest';
import type { TestService } from './helpers';
import { addMilk, batchOnHand, batchedOnHand, receive, shopOf } from './batch-helpers';
import { expectCode, makeService, sellCash, snapshotCounts, stockSum } from './helpers';

interface Movement {
  batch_id: string | null;
  quantity: number;
}
const adjustments = (t: TestService, itemId: string): Promise<Movement[]> =>
  t.driver.query<Movement>(
    `SELECT batch_id, quantity FROM stock_movements
     WHERE type = 'adjustment' AND item_id = ? AND reason <> 'Opening stock' ORDER BY quantity`,
    [itemId],
  );

/** For a batch-tracked item, every unit on hand belongs to a batch unless the test put it outside one on purpose. */
async function expectInvariant(t: TestService, itemId: string, unbatched = 0): Promise<void> {
  const onHand = await stockSum(t.driver, { itemId });
  expect(await batchedOnHand(t, itemId)).toBe(onHand - unbatched);
}

describe('stock adjustments on a batch-tracked item', () => {
  it('takes a negative adjustment from the batches, nearest expiry first, one movement per batch', async () => {
    const t = await shopOf();
    const milk = await addMilk(t);
    await receive(t, milk.item.id, [
      { qty: 10, days: 20, batchNo: 'LATE' },
      { qty: 4, days: 5, batchNo: 'SOON' },
    ]);

    const view = await t.svc.catalog.adjustStock({
      itemId: milk.item.id,
      delta: -6,
      reason: 'Damaged in transit',
    });

    expect(view.onHand).toBe(8);
    expect(await batchOnHand(t, 'SOON')).toBe(0);
    expect(await batchOnHand(t, 'LATE')).toBe(8);
    const moves = await adjustments(t, milk.item.id);
    expect(moves.map((m) => m.quantity)).toEqual([-4, -2]);
    expect(moves.every((m) => m.batch_id !== null)).toBe(true);
    await expectInvariant(t, milk.item.id);
  });

  it('may remove expired stock, so the fresh batch becomes sellable again', async () => {
    const t = await shopOf();
    const milk = await addMilk(t);
    await receive(t, milk.item.id, [
      { qty: 5, days: -2, batchNo: 'OLD' },
      { qty: 3, days: 10, batchNo: 'FRESH' },
    ]);

    // The owner throws the 5 expired packets away through the ordinary adjust dialog, not writeOff.
    await t.svc.catalog.adjustStock({ itemId: milk.item.id, delta: -5, reason: 'Expired' });

    expect(await batchOnHand(t, 'OLD')).toBe(0);
    expect(await batchOnHand(t, 'FRESH')).toBe(3);
    await expectInvariant(t, milk.item.id);
    // Before the fix the -5 landed outside the batches, so the expiry list still showed OLD and the
    // sellable quantity was (3 + 5 - 5) - 5 = -2: the fresh milk could not be sold.
    await sellCash(t, [{ itemId: milk.item.id, quantity: 3 }]);
    expect(await batchOnHand(t, 'FRESH')).toBe(0);
    await expectInvariant(t, milk.item.id);
  });

  it('spills what the batches cannot cover into stock without a batch', async () => {
    const t = await shopOf();
    const milk = await t.svc.catalog.createItem({
      product: { brand: 'Olpers', name: 'Milk 1L' },
      sku: 'MILK-1L',
      costPrice: 29_000,
      salePrice: 32_000,
      openingQty: 4, // counted before batches were tracked: no batch
    });
    await receive(t, milk.item.id, [{ qty: 3, days: 10, batchNo: 'B1' }]);

    await t.svc.catalog.adjustStock({ itemId: milk.item.id, delta: -5, reason: 'Recount' });

    const moves = await adjustments(t, milk.item.id);
    expect(moves.map((m) => m.quantity)).toEqual([-3, -2]);
    expect(moves.filter((m) => m.batch_id === null).map((m) => m.quantity)).toEqual([-2]);
    expect(await batchOnHand(t, 'B1')).toBe(0);
    expect(await stockSum(t.driver, { itemId: milk.item.id })).toBe(2);
    await expectInvariant(t, milk.item.id, 2);
  });

  it('still refuses to go below zero and writes nothing', async () => {
    const t = await shopOf();
    const milk = await addMilk(t);
    await receive(t, milk.item.id, [{ qty: 3, days: 10, batchNo: 'B1' }]);
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.catalog.adjustStock({ itemId: milk.item.id, delta: -4, reason: 'Recount' }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 3, requested: 4 });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('a positive adjustment has no expiry date: it is stock without a batch, sold after the batches', async () => {
    const t = await shopOf();
    const milk = await addMilk(t);
    await receive(t, milk.item.id, [{ qty: 3, days: 10, batchNo: 'B1' }]);

    const view = await t.svc.catalog.adjustStock({
      itemId: milk.item.id,
      delta: 2,
      reason: 'Found on the back shelf',
    });

    expect(view.onHand).toBe(5);
    expect(await batchOnHand(t, 'B1')).toBe(3);
    expect(await adjustments(t, milk.item.id)).toEqual([{ batch_id: null, quantity: 2 }]);
    await expectInvariant(t, milk.item.id, 2);
    // the whole 5 can be sold: 3 from the batch, then the 2 without one
    await sellCash(t, [{ itemId: milk.item.id, quantity: 5 }]);
    expect(await stockSum(t.driver, { itemId: milk.item.id })).toBe(0);
    expect(await batchOnHand(t, 'B1')).toBe(0);
  });

  it('an item without batches still gets exactly one movement without a batch', async () => {
    const t = await makeService(); // seeded shop: the charger never had a batch
    await t.loginAs('owner');
    await t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: -2, reason: 'Broken' });
    await t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: 1, reason: 'Found' });
    expect(await adjustments(t, t.ids.chargerId)).toEqual([
      { batch_id: null, quantity: -2 },
      { batch_id: null, quantity: 1 },
    ]);
  });
});
