import { beforeEach, describe, expect, it } from 'vitest';
import type { NewPhoneUnitInput } from '@pos/shared';
import { isValidImei, imeiCheckDigit, luhnValid } from '../../src/service/catalog';
import {
  CHARGER_COST,
  CHARGER_PRICE,
  IMEI_X,
  IMEI_Y,
  PHONE_COST,
  PHONE_PRICE,
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

type PhoneInput = NewPhoneUnitInput & { openingStock?: boolean };
const phoneInput = (over: Partial<PhoneInput> = {}): PhoneInput => ({
  product: { brand: 'Infinix', name: 'Hot 40' },
  imei1: IMEI_Y,
  ptaStatus: 'approved',
  condition: 'new',
  costPrice: PHONE_COST,
  salePrice: PHONE_PRICE,
  ...over,
});

describe('IMEI helpers', () => {
  it('validates the Luhn check digit and length', () => {
    expect(luhnValid(IMEI_X)).toBe(true);
    expect(isValidImei(IMEI_X)).toBe(true);
    expect(isValidImei(IMEI_Y)).toBe(true);
    expect(isValidImei('356938035643808')).toBe(false);
    expect(isValidImei('35693803564380')).toBe(false);
    expect(isValidImei('35693803564380a')).toBe(false);
    expect(imeiCheckDigit('35693803564380')).toBe('9');
  });
});

describe('createPhoneUnit validation (spec 14)', () => {
  it('a duplicate IMEI gives DUPLICATE {field: imei1} and writes nothing', async () => {
    await t.loginAs('mgr');
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ imei1: IMEI_X })),
      'DUPLICATE',
    );
    expect(e.details).toMatchObject({ field: 'imei1', value: IMEI_X });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('an IMEI failing Luhn (or the wrong length) is VALIDATION', async () => {
    await t.loginAs('mgr');
    const bad = await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ imei1: '356938035643808' })),
      'VALIDATION',
    );
    expect(bad.details).toMatchObject({ field: 'imei1' });
    await expectCode(t.svc.catalog.createPhoneUnit(phoneInput({ imei1: '12345' })), 'VALIDATION');
  });

  it('a non-integer price is MONEY_INVALID, a negative price VALIDATION', async () => {
    await t.loginAs('mgr');
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ salePrice: 10.5 })),
      'MONEY_INVALID',
    );
    await expectCode(
      t.svc.catalog.createAccessory({
        product: { brand: 'G', name: 'N' },
        sku: 'S1',
        costPrice: 10.5,
        salePrice: 20,
      }),
      'MONEY_INVALID',
    );
    await expectCode(t.svc.catalog.createPhoneUnit(phoneInput({ costPrice: -1 })), 'VALIDATION');
  });

  it('needs an IMEI or a serial, a second IMEI needs the first, and the two must differ', async () => {
    await t.loginAs('mgr');
    await expectCode(t.svc.catalog.createPhoneUnit(phoneInput({ imei1: null })), 'VALIDATION');
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ imei1: null, imei2: IMEI_Y })),
      'VALIDATION',
    );
    await expectCode(t.svc.catalog.createPhoneUnit(phoneInput({ imei2: IMEI_Y })), 'VALIDATION');
    const serialOnly = await t.svc.catalog.createPhoneUnit(
      phoneInput({ imei1: null, serial: 'SN-0001' }),
    );
    expect(serialOnly.unit.serial).toBe('SN-0001');
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ imei1: null, serial: 'SN-0001' })),
      'DUPLICATE',
    );
  });

  it('unknown PTA status / condition and an out-of-range battery are VALIDATION', async () => {
    await t.loginAs('mgr');
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ ptaStatus: 'maybe' as never })),
      'VALIDATION',
    );
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ condition: 'broken' as never })),
      'VALIDATION',
    );
    await expectCode(
      t.svc.catalog.createPhoneUnit(phoneInput({ batteryHealthPct: 101 })),
      'VALIDATION',
    );
  });

  it('creates the unit with a +1 opening movement; openingStock:false leaves it out of stock', async () => {
    await t.loginAs('mgr');
    const inStock = await t.svc.catalog.createPhoneUnit(phoneInput());
    expect(inStock.inStock).toBe(true);
    expect(inStock.label).toContain('Hot 40');
    expect(await stockSum(t.driver, { phoneUnitId: inStock.unit.id })).toBe(1);

    const out = await t.svc.catalog.createPhoneUnit(
      phoneInput({ imei1: null, serial: 'NOSTOCK-1', openingStock: false }),
    );
    expect(out.inStock).toBe(false);
  });

  it('reuses the product for the same brand and name (case-insensitive)', async () => {
    await t.loginAs('mgr');
    const a = await t.svc.catalog.createPhoneUnit(phoneInput({ imei1: null, serial: 'A1' }));
    const b = await t.svc.catalog.createPhoneUnit(
      phoneInput({ imei1: null, serial: 'A2', product: { brand: 'INFINIX', name: 'hot 40' } }),
    );
    expect(b.product.id).toBe(a.product.id);
    const rows = await t.driver.query<{ n: number }>(
      "select count(*) as n from products where kind = 'phone'",
    );
    expect(rows[0]?.n).toBe(2); // Samsung (seed) + Infinix
  });
});

describe('createAccessory, updates and stock adjustments', () => {
  it('createAccessory books opening stock and low-stock flag follows on hand <= reorder level', async () => {
    await t.loginAs('mgr');
    const v = await t.svc.catalog.createAccessory({
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
      variantId: v.variant.id,
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
      t.svc.catalog.createAccessory({ ...base, sku: 'CHG-25W' }),
      'DUPLICATE',
    );
    expect(sku.details).toMatchObject({ field: 'sku' });
    const barcode = await expectCode(
      t.svc.catalog.createAccessory({ ...base, sku: 'NEW-SKU', barcode: '8961234567890' }),
      'DUPLICATE',
    );
    expect(barcode.details).toMatchObject({ field: 'barcode' });
  });

  it('adjustStock needs a reason, refuses to go below zero and logs the movement', async () => {
    await t.loginAs('mgr');
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: -1, reason: '  ' }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: 0, reason: 'x' }),
      'VALIDATION',
    );
    const e = await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: -11, reason: 'Lost' }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 10, requested: 11 });
    const after = await t.svc.catalog.adjustStock({
      variantId: t.ids.chargerId,
      delta: -4,
      reason: 'Damaged in transit',
    });
    expect(after.onHand).toBe(6);
    const moves = await t.driver.query<{ type: string; quantity: number; reason: string }>(
      'select type, quantity, reason from stock_movements where variant_id = ? and quantity < 0',
      [t.ids.chargerId],
    );
    expect(moves).toEqual([{ type: 'adjustment', quantity: -4, reason: 'Damaged in transit' }]);
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.newId(), delta: 1, reason: 'x' }),
      'NOT_FOUND',
    );
  });

  it('updatePhoneUnit and updateVariant change prices without touching stock', async () => {
    await t.loginAs('mgr');
    const phone = await t.svc.catalog.updatePhoneUnit(t.ids.phoneId, {
      salePrice: 9_000_000,
      ptaStatus: 'non_pta',
      note: 'Price up',
    });
    expect(phone.unit).toMatchObject({
      salePrice: 9_000_000,
      ptaStatus: 'non_pta',
      note: 'Price up',
    });
    expect(phone.inStock).toBe(true);
    const variant = await t.svc.catalog.updateVariant(t.ids.chargerId, {
      salePrice: 160_000,
      reorderLevel: 8,
    });
    expect(variant.variant).toMatchObject({ salePrice: 160_000, reorderLevel: 8 });
    expect(variant.onHand).toBe(10);
    await expectCode(
      t.svc.catalog.updateVariant(t.ids.chargerId, { salePrice: 1.5 }),
      'MONEY_INVALID',
    );
    await expectCode(t.svc.catalog.updatePhoneUnit(t.newId(), { salePrice: 1 }), 'NOT_FOUND');
    // sold invoices keep the price at the time of sale
    await t.loginAs('owner');
    const preview = await t.svc.checkout.preview({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
    });
    expect(preview.total).toBe(160_000);
  });

  it('only edit_catalog roles may create or update; stock-entry hook is consulted', async () => {
    await t.loginAs('cash');
    await expectCode(
      t.svc.catalog.createAccessory({
        product: { brand: 'G', name: 'N' },
        sku: 'Z1',
        costPrice: 1,
        salePrice: 2,
      }),
      'FORBIDDEN',
    );
    await expectCode(t.svc.catalog.updateVariant(t.ids.chargerId, { salePrice: 1 }), 'FORBIDDEN');
    await expectCode(t.svc.catalog.updatePhoneUnit(t.ids.phoneId, { salePrice: 1 }), 'FORBIDDEN');
    t.svc.auth.logout();
    await t.loginAs('mgr');
    await t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: 1, reason: 'x' });
    expect(t.assertCanSell).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'stock_entry' }),
    );
    t.assertCanSell.mockRejectedValueOnce(new Error('locked'));
    const before = await snapshotCounts(t.driver);
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: 1, reason: 'x' }),
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

  it('a barcode scan returns exactly one exact hit; so do SKU and IMEI', async () => {
    await t.loginAs('cash');
    const byBarcode = await t.svc.catalog.search('8961234567890');
    expect(byBarcode).toHaveLength(1);
    expect(byBarcode[0]).toMatchObject({ kind: 'variant', matchedBy: 'barcode' });
    const bySku = await t.svc.catalog.search('CHG-25W');
    expect(bySku[0]).toMatchObject({ kind: 'variant', matchedBy: 'sku' });
    const byImei = await t.svc.catalog.search(IMEI_X);
    expect(byImei).toHaveLength(1);
    expect(byImei[0]).toMatchObject({ kind: 'phone_unit', matchedBy: 'imei' });
  });

  it('text search is multi-word, case-insensitive and honours inStockOnly and limit', async () => {
    await t.loginAs('cash');
    expect((await t.svc.catalog.search('samsung a55')).map((h) => h.kind)).toEqual(['phone_unit']);
    expect(await t.svc.catalog.search('nokia')).toEqual([]);
    expect(await t.svc.catalog.search('   ')).toEqual([]);
    expect(await t.svc.catalog.search('%')).toEqual([]); // LIKE wildcards are escaped
    await t.loginAs('owner');
    await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      payments: [{ method: 'cash', amount: PHONE_PRICE }],
    });
    expect(await t.svc.catalog.search('samsung', { inStockOnly: true })).toEqual([]);
    expect(await t.svc.catalog.search('samsung')).toHaveLength(1);
    expect(await t.svc.catalog.search('e', { limit: 1 })).toHaveLength(1);
  });

  it('listPhones filters by stock, PTA and condition; listAccessories by low stock', async () => {
    await t.loginAs('mgr');
    await t.svc.catalog.createPhoneUnit(
      phoneInput({ imei1: null, serial: 'USED-1', ptaStatus: 'non_pta', condition: 'used' }),
    );
    expect(await t.svc.catalog.listPhones()).toHaveLength(2);
    expect((await t.svc.catalog.listPhones({ pta: 'non_pta' })).map((p) => p.unit.serial)).toEqual([
      'USED-1',
    ]);
    expect(await t.svc.catalog.listPhones({ condition: 'new' })).toHaveLength(1);
    expect(await t.svc.catalog.listPhones({ inStock: false })).toEqual([]);
    expect(await t.svc.catalog.listPhones({ q: 'galaxy' })).toHaveLength(1);

    expect(await t.svc.catalog.listAccessories({ lowStockOnly: true })).toEqual([]);
    await t.svc.catalog.adjustStock({
      variantId: t.ids.chargerId,
      delta: -7,
      reason: 'Sold elsewhere',
    });
    const low = await t.svc.catalog.listAccessories({ lowStockOnly: true });
    expect(low.map((v) => v.variant.id)).toEqual([t.ids.chargerId]);
    expect(first(low)).toMatchObject({ onHand: 3, lowStock: true });
  });

  it('the seeded charger prices are what the tests assume', async () => {
    await t.loginAs('cash');
    const [v] = await t.svc.catalog.listAccessories();
    expect(v?.variant).toMatchObject({
      costPrice: CHARGER_COST,
      salePrice: CHARGER_PRICE,
      reorderLevel: 3,
    });
    expect(v?.onHand).toBe(10);
  });
});
