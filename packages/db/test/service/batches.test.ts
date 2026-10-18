import { describe, expect, it } from 'vitest';
import type { BusinessType, VariantView } from '@pos/shared';
import {
  PINS,
  expectCode,
  first,
  makeService,
  sellCash,
  snapshotCounts,
  stockSum,
  type TestService,
} from './helpers';

const DAY = 86_400_000;
const PKT_OFFSET = 5 * 3_600_000; // Pakistan time, UTC+5
/** Calendar date (YYYY-MM-DD) in Pakistan time. Deliberately re-implemented here to cross-check the service. */
const ymd = (ms: number): string => new Date(ms + PKT_OFFSET).toISOString().slice(0, 10);
/** The date `n` days from the test clock's now (negative = in the past). */
const inDays = (t: TestService, n: number): string => ymd(t.clock.peek() + n * DAY);

async function shopOf(type: BusinessType): Promise<TestService> {
  const t = await makeService({ seed: false });
  await t.svc.setup.firstRun({
    shopName: 'Test Store',
    branchName: 'Main',
    invoicePrefix: 'K',
    owner: { username: 'owner', displayName: 'Owner', pin: PINS.owner },
    businessType: type,
  });
  await t.loginAs('owner');
  await t.svc.auth.createUser({
    username: 'cash',
    displayName: 'Cashier',
    role: 'cashier',
    pin: PINS.cash,
  });
  return t;
}

async function addMilk(t: TestService): Promise<VariantView> {
  return t.svc.catalog.createAccessory({
    product: { brand: 'Olpers', name: 'Milk 1L' },
    sku: 'MILK-1L',
    costPrice: 29_000,
    salePrice: 32_000,
    reorderLevel: 2,
  });
}

async function addSupplier(t: TestService): Promise<string> {
  return (await t.svc.purchasing.createSupplier({ name: 'Dairy Distributors' })).id;
}

interface Delivery {
  qty: number;
  days: number;
  batchNo?: string | null;
}
/** One purchase with one line per delivery; read the batches back with `batches.list`. */
async function receive(t: TestService, variantId: string, deliveries: Delivery[]): Promise<void> {
  const supplierId = await addSupplier(t);
  await t.svc.purchasing.receive({
    supplierId,
    phones: [],
    accessories: deliveries.map((d) => ({
      variantId,
      quantity: d.qty,
      unitCost: 29_000,
      batch: { batchNo: d.batchNo ?? null, expiryDate: inDays(t, d.days) },
    })),
  });
}

const batchOnHand = async (t: TestService, batchNo: string): Promise<number> =>
  (await t.svc.batches.list()).find((b) => b.batchNo === batchNo)?.onHand ?? 0;

describe('receiving stock with a batch and expiry date', () => {
  it('creates a batch whose on-hand and days left are readable', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [{ qty: 10, days: 10, batchNo: 'L-01' }]);

    const rows = await t.svc.batches.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      variantId: milk.variant.id,
      batchNo: 'L-01',
      expiryDate: inDays(t, 10),
      onHand: 10,
      daysLeft: 10,
      unitScale: 1,
      unitLabel: 'pcs',
    });
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(10);
  });

  it('a batch number is optional', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [{ qty: 3, days: 4 }]);
    expect((await t.svc.batches.list())[0]).toMatchObject({ batchNo: null, onHand: 3 });
  });

  it('rejects a bad or missing expiry date and writes nothing', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    const supplierId = await addSupplier(t);
    const before = await snapshotCounts(t.driver);
    const line = (batch: unknown) => ({
      supplierId,
      phones: [],
      accessories: [
        {
          variantId: milk.variant.id,
          quantity: 5,
          unitCost: 29_000,
          batch: batch as { expiryDate: string },
        },
      ],
    });
    await expectCode(t.svc.purchasing.receive(line({ expiryDate: '2026-02-30' })), 'VALIDATION');
    await expectCode(t.svc.purchasing.receive(line({ expiryDate: 'kal' })), 'VALIDATION');
    await expectCode(t.svc.purchasing.receive(line({ expiryDate: '12/05/2026' })), 'VALIDATION');
    await expectCode(t.svc.purchasing.receive(line({ batchNo: 'X' })), 'VALIDATION');
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('works for loose goods: a 10 kg batch is held in grams', async () => {
    const t = await shopOf('kiryana');
    const atta = await t.svc.catalog.createAccessory({
      product: { brand: 'Loose', name: 'Atta' },
      sku: 'ATTA',
      costPrice: 13_500,
      salePrice: 15_000,
      unit: 'kg',
    });
    await receive(t, atta.variant.id, [{ qty: 10_000, days: 60, batchNo: 'A-1' }]);
    await sellCash(t, [{ variantId: atta.variant.id, quantity: 1_250 }]);
    expect(await t.svc.batches.list()).toEqual([
      expect.objectContaining({ batchNo: 'A-1', onHand: 8_750, unitScale: 1000, unitLabel: 'kg' }),
    ]);
  });

  it('writes a stock_batch row and a batch-carrying movement to the outbox', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [{ qty: 6, days: 9, batchNo: 'L-02' }]);
    const rows = await t.driver.query<{ entity_type: string; payload: string }>(
      "select entity_type, payload from outbox where entity_type in ('stock_batch', 'stock_movement') order by id",
    );
    const batch = rows.find((r) => r.entity_type === 'stock_batch');
    expect(JSON.parse(batch?.payload ?? '{}')).toMatchObject({
      batchNo: 'L-02',
      expiryDate: inDays(t, 9),
      variantId: milk.variant.id,
    });
    const batchId = (JSON.parse(batch?.payload ?? '{}') as { id: string }).id;
    const movement = rows
      .filter((r) => r.entity_type === 'stock_movement')
      .map((r) => JSON.parse(r.payload) as { batchId?: string | null })
      .find((m) => m.batchId === batchId);
    expect(movement).toBeDefined();
  });
});

describe('selling batch-tracked stock (first expiry, first out)', () => {
  it('takes from the batch that expires first, even if it was received last', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [
      { qty: 10, days: 20, batchNo: 'LATE' },
      { qty: 4, days: 5, batchNo: 'SOON' },
    ]);
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 6 }]);

    expect(await batchOnHand(t, 'SOON')).toBe(0);
    expect(await batchOnHand(t, 'LATE')).toBe(8);
    const sold = await t.driver.query<{ quantity: number }>(
      "select quantity from stock_movements where type = 'sale' order by quantity",
    );
    expect(sold.map((m) => m.quantity)).toEqual([-4, -2]);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(8);
  });

  it('two cart lines of the same item consume the batches one after the other', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [
      { qty: 4, days: 5, batchNo: 'SOON' },
      { qty: 10, days: 20, batchNo: 'LATE' },
    ]);
    await sellCash(t, [
      { variantId: milk.variant.id, quantity: 3 },
      { variantId: milk.variant.id, quantity: 3 },
    ]);
    expect(await batchOnHand(t, 'SOON')).toBe(0);
    expect(await batchOnHand(t, 'LATE')).toBe(8);
  });

  it('never sells an expired batch: it is skipped, and short stock reports the expired quantity', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [
      { qty: 5, days: -2, batchNo: 'OLD' },
      { qty: 3, days: 10, batchNo: 'FRESH' },
    ]);
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 3 }]);
    expect(await batchOnHand(t, 'FRESH')).toBe(0);
    expect(await batchOnHand(t, 'OLD')).toBe(5);

    const e = await expectCode(
      sellCash(t, [{ variantId: milk.variant.id, quantity: 1 }]),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 0, expiredOnHand: 5 });
  });

  it('sells batches first and stock without a batch last', async () => {
    const t = await shopOf('kiryana');
    const milk = await t.svc.catalog.createAccessory({
      product: { brand: 'Olpers', name: 'Milk 1L' },
      sku: 'MILK-1L',
      costPrice: 29_000,
      salePrice: 32_000,
      openingQty: 4, // counted before batches were tracked: no batch
    });
    await receive(t, milk.variant.id, [{ qty: 3, days: 10, batchNo: 'B1' }]);
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 5 }]);

    const sold = await t.driver.query<{ batch_id: string | null; quantity: number }>(
      "select batch_id, quantity from stock_movements where type = 'sale' order by quantity",
    );
    expect(sold.map((m) => m.quantity)).toEqual([-3, -2]);
    expect(sold.filter((m) => m.batch_id === null).map((m) => m.quantity)).toEqual([-2]);
    expect(await batchOnHand(t, 'B1')).toBe(0);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(2);
  });

  it('with negative stock allowed, the shortfall goes to the no-batch bucket', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [{ qty: 3, days: 10, batchNo: 'B1' }]);
    await t.svc.settings.update({ allowNegativeStock: true });
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 5 }]);
    const sold = await t.driver.query<{ batch_id: string | null; quantity: number }>(
      "select batch_id, quantity from stock_movements where type = 'sale' order by quantity",
    );
    expect(sold.map((m) => m.quantity)).toEqual([-3, -2]);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(-2);
  });
});

describe('returning batch-tracked goods', () => {
  async function soldSix(t: TestService, milk: VariantView) {
    await receive(t, milk.variant.id, [
      { qty: 4, days: 5, batchNo: 'SOON' },
      { qty: 10, days: 20, batchNo: 'LATE' },
    ]);
    return sellCash(t, [{ variantId: milk.variant.id, quantity: 6 }]);
  }
  async function giveBack(t: TestService, saleId: string, lineId: string, quantity: number) {
    const preview = await t.svc.checkout.previewReturn(saleId, [{ lineId, quantity }]);
    return t.svc.checkout.createReturn({
      originalSaleId: saleId,
      lines: [{ lineId, quantity }],
      refund: preview.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
      reason: 'Customer changed mind',
    });
  }

  it('puts the goods back into the batches they came from, in the order they left', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    const sale = await soldSix(t, milk);
    const line = first(sale.lines, 'sale line');

    await giveBack(t, sale.id, line.id, 5);
    expect(await batchOnHand(t, 'SOON')).toBe(4); // 4 had left, all 4 are back
    expect(await batchOnHand(t, 'LATE')).toBe(9); // 2 had left, 1 is back
  });

  it('a second partial return does not overfill a batch', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    const sale = await soldSix(t, milk);
    const line = first(sale.lines, 'sale line');

    await giveBack(t, sale.id, line.id, 5);
    await giveBack(t, sale.id, line.id, 1);
    expect(await batchOnHand(t, 'SOON')).toBe(4);
    expect(await batchOnHand(t, 'LATE')).toBe(10);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(14);
  });
});

describe('the expiry list and writing off expired goods', () => {
  it('lists batches that still have stock, earliest expiry first, and filters by days left', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [
      { qty: 4, days: 20, batchNo: 'D20' },
      { qty: 4, days: -3, batchNo: 'GONE' },
      { qty: 4, days: 5, batchNo: 'D5' },
      { qty: 1, days: 1, batchNo: 'SOLD-OUT' },
    ]);
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 1 }]); // empties SOLD-OUT (soonest valid)

    expect((await t.svc.batches.list()).map((b) => b.batchNo)).toEqual(['GONE', 'D5', 'D20']);
    expect((await t.svc.batches.list({ withinDays: 7 })).map((b) => b.batchNo)).toEqual([
      'GONE',
      'D5',
    ]);
    expect((await t.svc.batches.list())[0]?.daysLeft).toBe(-3);
    expect((await t.svc.batches.list({ variantId: 'no-such-item' })).map((b) => b.batchNo)).toEqual(
      [],
    );
  });

  it('writeOff removes the whole batch from stock with a reason and keeps the ledger intact', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [
      { qty: 5, days: -2, batchNo: 'OLD' },
      { qty: 3, days: 10, batchNo: 'FRESH' },
    ]);
    const old = first(
      (await t.svc.batches.list()).filter((b) => b.batchNo === 'OLD'),
      'old batch',
    );

    await t.svc.batches.writeOff({ batchId: old.id, reason: 'Expired, thrown away' });

    expect((await t.svc.batches.list()).map((b) => b.batchNo)).toEqual(['FRESH']);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(3);
    const adj = await t.driver.query<{ quantity: number; reason: string; batch_id: string }>(
      "select quantity, reason, batch_id from stock_movements where type = 'adjustment' and batch_id is not null",
    );
    expect(adj).toEqual([{ quantity: -5, reason: 'Expired, thrown away', batch_id: old.id }]);
  });

  it('writeOff needs a reason, a real batch with stock, and the adjust-stock permission', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await receive(t, milk.variant.id, [{ qty: 5, days: -2, batchNo: 'OLD' }]);
    const old = first(await t.svc.batches.list(), 'batch');

    await expectCode(t.svc.batches.writeOff({ batchId: old.id, reason: ' ' }), 'VALIDATION');
    await expectCode(t.svc.batches.writeOff({ batchId: 'nope', reason: 'x' }), 'NOT_FOUND');

    t.svc.auth.logout();
    await t.loginAs('cash');
    await expectCode(t.svc.batches.writeOff({ batchId: old.id, reason: 'x' }), 'FORBIDDEN');
    expect(await t.svc.batches.list()).toHaveLength(1); // reading the list needs only a session

    t.svc.auth.logout();
    await t.loginAs('owner');
    await t.svc.batches.writeOff({ batchId: old.id, reason: 'Expired' });
    await expectCode(t.svc.batches.writeOff({ batchId: old.id, reason: 'again' }), 'VALIDATION');
  });
});

describe('the batch_expiry module', () => {
  it('a mobile shop cannot receive batches or read the expiry list', async () => {
    const t = await shopOf('mobile');
    const pens = await t.svc.catalog.createAccessory({
      product: { brand: 'Reynolds', name: 'Pen' },
      sku: 'PEN',
      costPrice: 1_500,
      salePrice: 2_500,
    });
    const supplierId = await addSupplier(t);
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        phones: [],
        accessories: [
          {
            variantId: pens.variant.id,
            quantity: 5,
            unitCost: 1_500,
            batch: { batchNo: 'X', expiryDate: inDays(t, 30) },
          },
        ],
      }),
      'MODULE_DISABLED',
    );
    expect(e.details).toMatchObject({ module: 'batch_expiry' });
    await expectCode(t.svc.batches.list(), 'MODULE_DISABLED');
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('a plain receive (no batch) still works in a kiryana shop and sells as before', async () => {
    const t = await shopOf('kiryana');
    const milk = await addMilk(t);
    await t.svc.purchasing.receive({
      supplierId: await addSupplier(t),
      phones: [],
      accessories: [{ variantId: milk.variant.id, quantity: 5, unitCost: 29_000 }],
    });
    await sellCash(t, [{ variantId: milk.variant.id, quantity: 2 }]);
    expect(await stockSum(t.driver, { variantId: milk.variant.id })).toBe(3);
    expect(await t.svc.batches.list()).toEqual([]);
  });
});
