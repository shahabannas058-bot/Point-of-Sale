import { beforeEach, describe, expect, it } from 'vitest';
import type { NewItemInput } from '@pos/shared';
import {
  CHARGER_COST,
  CHARGER_PRICE,
  CARTON_PRICE,
  expectCode,
  first,
  makeService,
  snapshotCounts,
  stockSum,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const itemInput = (over: Partial<NewItemInput> = {}): NewItemInput => ({
  product: { brand: 'Shan', name: 'Biryani Masala' },
  sku: 'SHAN-BIR',
  costPrice: 9_000,
  salePrice: 12_000,
  ...over,
});

describe('createItem validation', () => {
  it('a non-integer price is MONEY_INVALID, a negative price VALIDATION', async () => {
    await t.loginAs('mgr');
    await expectCode(t.svc.catalog.createItem(itemInput({ salePrice: 10.5 })), 'MONEY_INVALID');
    await expectCode(t.svc.catalog.createItem(itemInput({ costPrice: 10.5 })), 'MONEY_INVALID');
    await expectCode(t.svc.catalog.createItem(itemInput({ costPrice: -1 })), 'VALIDATION');
  });

  it('opening stock is a +qty adjustment; without it the item has no stock', async () => {
    await t.loginAs('mgr');
    const inStock = await t.svc.catalog.createItem(itemInput({ openingQty: 4 }));
    expect(inStock.onHand).toBe(4);
    expect(inStock.label).toContain('Biryani Masala');
    expect(await stockSum(t.driver, { itemId: inStock.item.id })).toBe(4);

    const out = await t.svc.catalog.createItem(itemInput({ sku: 'SHAN-BIR-2' }));
    expect(out.onHand).toBe(0);
    expect(await stockSum(t.driver, { itemId: out.item.id })).toBe(0);
  });

  it('reuses the product for the same brand and name (case-insensitive)', async () => {
    await t.loginAs('mgr');
    const a = await t.svc.catalog.createItem(itemInput({ sku: 'A1' }));
    const b = await t.svc.catalog.createItem(
      itemInput({ sku: 'A2', product: { brand: 'SHAN', name: 'biryani masala' } }),
    );
    expect(b.product.id).toBe(a.product.id);
    const rows = await t.driver.query<{ n: number }>('select count(*) as n from products');
    expect(rows[0]?.n).toBe(3); // Dalda + Generic (seed) + Shan
  });
});

describe('createItem, updates and stock adjustments', () => {
  it('createItem books opening stock and low-stock flag follows on hand <= reorder level', async () => {
    await t.loginAs('mgr');
    const v = await t.svc.catalog.createItem({
      product: { brand: 'Generic', name: 'Cable Type-C' },
      sku: 'CBL-1',
      barcode: '8961111111111',
      model: 'Universal',
      colour: 'White',
      costPrice: 40_000,
      salePrice: 80_000,
      reorderLevel: 5,
      openingQty: 5,
    });
    expect(v).toMatchObject({ onHand: 5, lowStock: true });
    const full = await t.svc.catalog.adjustStock({
      itemId: v.item.id,
      delta: 1,
      reason: 'Found one',
    });
    expect(full).toMatchObject({ onHand: 6, lowStock: false });
  });

  it('a duplicate SKU or barcode is DUPLICATE', async () => {
    await t.loginAs('mgr');
    const base = {
      product: { brand: 'Generic', name: 'Fast Charger 25W' },
      costPrice: 1,
      salePrice: 2,
    };
    const sku = await expectCode(
      t.svc.catalog.createItem({ ...base, sku: 'CHG-25W' }),
      'DUPLICATE',
    );
    expect(sku.details).toMatchObject({ field: 'sku' });
    const barcode = await expectCode(
      t.svc.catalog.createItem({ ...base, sku: 'NEW-SKU', barcode: '8961234567890' }),
      'DUPLICATE',
    );
    expect(barcode.details).toMatchObject({ field: 'barcode' });
  });

  it('a scanner code is unique across SKU and barcode: one code finds one item', async () => {
    await t.loginAs('mgr');
    const before = await snapshotCounts(t.driver);
    // barcode = the charger's SKU
    const a = await expectCode(
      t.svc.catalog.createItem(itemInput({ sku: 'CBL-1', barcode: 'CHG-25W' })),
      'DUPLICATE',
    );
    expect(a.details).toMatchObject({ table: 'items', field: 'barcode' });
    // SKU = the charger's barcode
    const b = await expectCode(
      t.svc.catalog.createItem(itemInput({ sku: '8961234567890' })),
      'DUPLICATE',
    );
    expect(b.details).toMatchObject({ table: 'items', field: 'sku' });
    expect(await snapshotCounts(t.driver)).toEqual(before);
    const hits = await t.svc.catalog.search('CHG-25W');
    expect(hits.filter((h) => h.matchedBy !== 'name')).toHaveLength(1);
  });

  it('updateItem refuses a barcode equal to another item SKU or barcode, but allows its own SKU', async () => {
    await t.loginAs('mgr');
    const e = await expectCode(
      t.svc.catalog.updateItem(t.ids.cartonId, { barcode: 'CHG-25W' }),
      'DUPLICATE',
    );
    expect(e.details).toMatchObject({ field: 'barcode' });
    await expectCode(
      t.svc.catalog.updateItem(t.ids.cartonId, { barcode: '8961234567890' }),
      'DUPLICATE',
    );
    const own = await t.svc.catalog.updateItem(t.ids.cartonId, { barcode: 'GHEE-CTN' });
    expect(own.item.barcode).toBe('GHEE-CTN');
    const same = await t.svc.catalog.updateItem(t.ids.chargerId, { barcode: '8961234567890' });
    expect(same.item.barcode).toBe('8961234567890');
  });

  it('adjustStock needs a reason, refuses to go below zero and logs the movement', async () => {
    await t.loginAs('mgr');
    await expectCode(
      t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: -1, reason: '  ' }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: 0, reason: 'x' }),
      'VALIDATION',
    );
    const e = await expectCode(
      t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: -11, reason: 'Lost' }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 10, requested: 11 });
    const after = await t.svc.catalog.adjustStock({
      itemId: t.ids.chargerId,
      delta: -4,
      reason: 'Damaged in transit',
    });
    expect(after.onHand).toBe(6);
    const moves = await t.driver.query<{ type: string; quantity: number; reason: string }>(
      'select type, quantity, reason from stock_movements where item_id = ? and quantity < 0',
      [t.ids.chargerId],
    );
    expect(moves).toEqual([{ type: 'adjustment', quantity: -4, reason: 'Damaged in transit' }]);
    await expectCode(
      t.svc.catalog.adjustStock({ itemId: t.newId(), delta: 1, reason: 'x' }),
      'NOT_FOUND',
    );
  });

  it('updateItem changes prices without touching stock', async () => {
    await t.loginAs('mgr');
    const carton = await t.svc.catalog.updateItem(t.ids.cartonId, {
      salePrice: 9_000_000,
      model: '16kg tin',
    });
    expect(carton.item).toMatchObject({ salePrice: 9_000_000, model: '16kg tin' });
    expect(carton.onHand).toBe(1);
    const item = await t.svc.catalog.updateItem(t.ids.chargerId, {
      salePrice: 160_000,
      reorderLevel: 8,
    });
    expect(item.item).toMatchObject({ salePrice: 160_000, reorderLevel: 8 });
    expect(item.onHand).toBe(10);
    await expectCode(
      t.svc.catalog.updateItem(t.ids.chargerId, { salePrice: 1.5 }),
      'MONEY_INVALID',
    );
    await expectCode(t.svc.catalog.updateItem(t.newId(), { salePrice: 1 }), 'NOT_FOUND');
    // sold invoices keep the price at the time of sale
    await t.loginAs('owner');
    const preview = await t.svc.checkout.preview({
      lines: [{ itemId: t.ids.chargerId, quantity: 1 }],
    });
    expect(preview.total).toBe(160_000);
  });

  it('only edit_catalog roles may create or update; stock-entry hook is consulted', async () => {
    await t.loginAs('cash');
    await expectCode(
      t.svc.catalog.createItem({
        product: { brand: 'G', name: 'N' },
        sku: 'Z1',
        costPrice: 1,
        salePrice: 2,
      }),
      'FORBIDDEN',
    );
    await expectCode(t.svc.catalog.updateItem(t.ids.chargerId, { salePrice: 1 }), 'FORBIDDEN');
    t.svc.auth.logout();
    await t.loginAs('mgr');
    await t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: 1, reason: 'x' });
    expect(t.assertCanSell).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'stock_entry' }),
    );
    t.assertCanSell.mockRejectedValueOnce(new Error('locked'));
    const before = await snapshotCounts(t.driver);
    await expectCode(
      t.svc.catalog.adjustStock({ itemId: t.ids.chargerId, delta: 1, reason: 'x' }),
      'INTERNAL',
    );
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });
});

describe('search and listing', () => {
  it('needs a session but no specific permission (cashier is fine)', async () => {
    await expectCode(t.svc.catalog.search('charger'), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    expect(await t.svc.catalog.search('charger')).toHaveLength(1);
  });

  it('a barcode scan returns exactly one exact hit; so does a SKU', async () => {
    await t.loginAs('cash');
    const byBarcode = await t.svc.catalog.search('8961234567890');
    expect(byBarcode).toHaveLength(1);
    expect(byBarcode[0]).toMatchObject({ kind: 'item', matchedBy: 'barcode' });
    const bySku = await t.svc.catalog.search('GHEE-CTN');
    expect(bySku).toHaveLength(1);
    expect(bySku[0]).toMatchObject({ kind: 'item', matchedBy: 'sku' });
  });

  it('text search is multi-word, case-insensitive and honours inStockOnly and limit', async () => {
    await t.loginAs('cash');
    expect((await t.svc.catalog.search('dalda ghee')).map((h) => h.item.item.id)).toEqual([
      t.ids.cartonId,
    ]);
    expect(await t.svc.catalog.search('nokia')).toEqual([]);
    expect(await t.svc.catalog.search('   ')).toEqual([]);
    expect(await t.svc.catalog.search('%')).toEqual([]); // LIKE wildcards are escaped
    await t.loginAs('owner');
    await t.svc.checkout.commit({
      lines: [{ itemId: t.ids.cartonId, quantity: 1 }],
      payments: [{ method: 'cash', amount: CARTON_PRICE }],
    });
    expect(await t.svc.catalog.search('dalda', { inStockOnly: true })).toEqual([]);
    expect(await t.svc.catalog.search('dalda')).toHaveLength(1);
    expect(await t.svc.catalog.search('e', { limit: 1 })).toHaveLength(1);
  });

  it('names that start with the typed text come first; prefixOnly drops the rest', async () => {
    await t.loginAs('mgr');
    const add = (brand: string, name: string, sku: string): Promise<unknown> =>
      t.svc.catalog.createItem({
        product: { brand, name },
        sku,
        costPrice: 100,
        salePrice: 150,
        openingQty: 5,
      });
    // inserted in the order that the old brand/name sort would show them: Fizz Cap, Zinc Plate, Zed Cable
    await add('Generic', 'Fizz Cap', 'FZ-2'); // z only inside a word
    await add('Generic', 'Zinc Plate', 'ZP-1'); // a word starts with z
    await add('Zed', 'Cable', 'ZC-1'); // the whole label starts with z
    const skus = (hits: Awaited<ReturnType<typeof t.svc.catalog.search>>): string[] =>
      hits.map((h) => h.item.item.sku);
    expect(skus(await t.svc.catalog.search('z', { inStockOnly: true }))).toEqual([
      'ZC-1',
      'ZP-1',
      'FZ-2',
    ]);
    expect(skus(await t.svc.catalog.search('Z', { prefixOnly: true }))).toEqual(['ZC-1', 'ZP-1']);
    // one more letter still lists the shorter-prefix match first and never drops a word match
    expect(skus(await t.svc.catalog.search('zi', { prefixOnly: true }))).toEqual(['ZP-1']);
  });

  it('listItems filters by text and by low stock', async () => {
    await t.loginAs('mgr');
    expect(await t.svc.catalog.listItems()).toHaveLength(2);
    expect((await t.svc.catalog.listItems({ q: 'ghee' })).map((v) => v.item.id)).toEqual([
      t.ids.cartonId,
    ]);
    // the carton (1 on hand, reorder level 0) is not low; neither is the charger (10 > 3)
    expect(await t.svc.catalog.listItems({ lowStockOnly: true })).toEqual([]);
    await t.svc.catalog.adjustStock({
      itemId: t.ids.chargerId,
      delta: -7,
      reason: 'Sold elsewhere',
    });
    const low = await t.svc.catalog.listItems({ lowStockOnly: true });
    expect(low.map((v) => v.item.id)).toEqual([t.ids.chargerId]);
    expect(first(low)).toMatchObject({ onHand: 3, lowStock: true });
  });

  it('the seeded charger prices are what the tests assume', async () => {
    await t.loginAs('mgr'); // a cashier gets cost 0 (cost-visibility.test.ts)
    const v = (await t.svc.catalog.listItems()).find((x) => x.item.id === t.ids.chargerId);
    expect(v?.item).toMatchObject({
      costPrice: CHARGER_COST,
      salePrice: CHARGER_PRICE,
      reorderLevel: 3,
    });
    expect(v?.onHand).toBe(10);
  });
});
