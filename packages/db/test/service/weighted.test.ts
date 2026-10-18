import { describe, expect, it } from 'vitest';
import { verifyChain } from '@pos/core';
import { MODULE_IDS, type BusinessType, type VariantView } from '@pos/shared';
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

/** A migrated, empty database with the shop set up as `type` and the owner logged in. */
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
  return t;
}

const CHINI = { cost: 25_000, price: 28_550 }; // Rs 250.00 and Rs 285.50 per kg

async function addChini(t: TestService, openingGrams = 50_000): Promise<VariantView> {
  return t.svc.catalog.createAccessory({
    product: { brand: 'Loose', name: 'Chini (sugar)', category: 'Grocery' },
    sku: 'CHINI-LOOSE',
    costPrice: CHINI.cost,
    salePrice: CHINI.price,
    reorderLevel: 5_000,
    openingQty: openingGrams,
    unit: 'kg',
  });
}

async function addPens(t: TestService, qty = 20): Promise<VariantView> {
  return t.svc.catalog.createAccessory({
    product: { brand: 'Reynolds', name: 'Pen' },
    sku: 'PEN-BLUE',
    costPrice: 1_500,
    salePrice: 2_500,
    openingQty: qty,
  });
}

describe('business type and modules', () => {
  it('a kiryana shop gets the kiryana preset', async () => {
    const t = await shopOf('kiryana');
    expect(await t.svc.setup.getShop()).toMatchObject({
      businessType: 'kiryana',
      modules: ['weight_units', 'batch_expiry'],
    });
  });

  it('a shop set up without a business type is custom and owns every module', async () => {
    const t = await makeService();
    const shop = await t.svc.setup.getShop();
    expect(shop.businessType).toBe('custom');
    expect(shop.modules).toEqual([...MODULE_IDS]);
  });

  it('a shop that has no module rows at all (created before modules existed) keeps everything', async () => {
    const t = await shopOf('kiryana');
    await t.driver.exec("delete from app_meta where key in ('business_type', 'modules')");
    const shop = await t.svc.setup.getShop();
    expect(shop.businessType).toBe('custom');
    expect(shop.modules).toEqual([...MODULE_IDS]);
    await addChini(t); // so weighted items work again
  });

  it('rejects an unknown business type', async () => {
    const t = await makeService({ seed: false });
    await expectCode(
      t.svc.setup.firstRun({
        shopName: 'X',
        branchName: 'Y',
        invoicePrefix: 'A',
        owner: { username: 'owner', displayName: 'Owner', pin: PINS.owner },
        businessType: 'bakery' as BusinessType,
      }),
      'VALIDATION',
    );
  });

  it('a kiryana shop is refused phones, repairs and warranty with MODULE_DISABLED', async () => {
    const t = await shopOf('kiryana');
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.catalog.createPhoneUnit({
        product: { brand: 'Samsung', name: 'A55' },
        imei1: '356938035643809',
        ptaStatus: 'approved',
        condition: 'new',
        costPrice: 1,
        salePrice: 2,
      }),
      'MODULE_DISABLED',
    );
    expect(e.details).toMatchObject({ module: 'imei' });
    await expectCode(t.svc.repairs.list(), 'MODULE_DISABLED');
    await expectCode(t.svc.warranty.listExpiring(30), 'MODULE_DISABLED');
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('a kiryana shop cannot receive phones in a purchase, but can receive loose goods', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t, 0);
    const supplier = await t.svc.purchasing.createSupplier({ name: 'Mandi Traders' });
    await expectCode(
      t.svc.purchasing.receive({
        supplierId: supplier.id,
        phones: [
          {
            product: { brand: 'Samsung', name: 'A55' },
            imei1: '356938035643809',
            ptaStatus: 'approved',
            condition: 'new',
            costPrice: 1,
            salePrice: 2,
          },
        ],
        accessories: [],
      }),
      'MODULE_DISABLED',
    );
    const ok = await t.svc.purchasing.receive({
      supplierId: supplier.id,
      phones: [],
      accessories: [{ variantId: chini.variant.id, quantity: 10_000, unitCost: CHINI.cost }],
    });
    expect(ok.purchase.total).toBe(250_000); // 10 kg x Rs 250
  });

  it('a mobile shop is refused loose goods sold by weight', async () => {
    const t = await shopOf('mobile');
    const e = await expectCode(addChini(t), 'MODULE_DISABLED');
    expect(e.details).toMatchObject({ module: 'weight_units' });
    await addPens(t); // pieces are core
  });

  it('removing a module takes effect immediately, without restarting the service', async () => {
    const t = await shopOf('kiryana');
    await addChini(t);
    await t.driver.exec("update app_meta set value = '' where key = 'modules'");
    await expectCode(
      t.svc.catalog.createAccessory({
        product: { brand: 'Loose', name: 'Atta' },
        sku: 'ATTA-LOOSE',
        costPrice: 1,
        salePrice: 2,
        unit: 'kg',
      }),
      'MODULE_DISABLED',
    );
  });

  it('an unknown unit is rejected', async () => {
    const t = await shopOf('kiryana');
    await expectCode(
      t.svc.catalog.createAccessory({
        product: { brand: 'Loose', name: 'Atta' },
        sku: 'ATTA',
        costPrice: 1,
        salePrice: 2,
        unit: 'dozen' as 'kg',
      }),
      'VALIDATION',
    );
  });
});

describe('selling loose goods by weight', () => {
  it('stores the unit and counts stock in grams', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    expect(chini.variant).toMatchObject({ unitScale: 1000, unitLabel: 'kg', reorderLevel: 5_000 });
    expect(chini.onHand).toBe(50_000);
    expect(await stockSum(t.driver, { variantId: chini.variant.id })).toBe(50_000);
  });

  it('prices 1.25 kg at Rs 285.50/kg exactly: 35,688 paisa, hash version 2, stock down 1,250 g', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const lines = [{ variantId: chini.variant.id, quantity: 1250 }];

    const preview = await t.svc.checkout.preview({ lines });
    expect(first(preview.lines)).toMatchObject({
      quantity: 1250,
      unitScale: 1000,
      unitPrice: CHINI.price,
      lineTotal: 35_688,
    });
    expect(preview.total).toBe(35_688);

    const invoice = await sellCash(t, lines);
    expect(invoice.total).toBe(35_688);
    expect(invoice.hashVersion).toBe(2);
    expect(first(invoice.lines)).toMatchObject({
      quantity: 1250,
      unitScale: 1000,
      unitPrice: CHINI.price,
      costPrice: CHINI.cost,
      lineTotal: 35_688,
    });
    expect(await stockSum(t.driver, { variantId: chini.variant.id })).toBe(48_750);

    const reloaded = await t.svc.checkout.getInvoice(invoice.id);
    expect(reloaded.invoice).toEqual(invoice);
  });

  it('prices piece and weighted lines together on one invoice', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const pens = await addPens(t);
    const invoice = await sellCash(t, [
      { variantId: pens.variant.id, quantity: 3 },
      { variantId: chini.variant.id, quantity: 1250 },
    ]);
    expect(invoice.lines.map((l) => [l.unitScale, l.lineTotal])).toEqual([
      [1, 7_500],
      [1000, 35_688],
    ]);
    expect(invoice.total).toBe(43_188);
  });

  it('applies a line discount to the rounded gross', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const invoice = await sellCash(t, [
      { variantId: chini.variant.id, quantity: 2500, discountAmount: 1_000 },
    ]);
    // 2.5 kg x 285.50 = 713.75 -> 71,375 paisa, less Rs 10
    expect(first(invoice.lines)).toMatchObject({ lineTotal: 70_375, discountAmount: 1_000 });
  });

  it('refuses to sell more grams than are on hand', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const e = await expectCode(
      t.svc.checkout.preview({ lines: [{ variantId: chini.variant.id, quantity: 60_000 }] }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 50_000 });
  });

  it('rejects a quantity above the cap for the unit', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const pens = await addPens(t);
    await t.svc.settings.update({ allowNegativeStock: true });
    await expectCode(
      t.svc.checkout.preview({ lines: [{ variantId: pens.variant.id, quantity: 1_000_001 }] }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.checkout.preview({ lines: [{ variantId: chini.variant.id, quantity: 100_000_001 }] }),
      'VALIDATION',
    );
  });

  it('a partial return refunds the rounded share and puts the grams back', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const sale = await sellCash(t, [{ variantId: chini.variant.id, quantity: 1250 }]);
    const line = first(sale.lines);

    const preview = await t.svc.checkout.previewReturn(sale.id, [
      { lineId: line.id, quantity: 500 },
    ]);
    expect(preview.total).toBe(-14_275); // 0.5 kg x 285.50
    expect(first(preview.lines)).toMatchObject({
      soldQty: 1250,
      remainingQty: 1250,
      unitScale: 1000,
    });

    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 500 }],
      refund: [{ method: 'cash', amount: 14_275 }],
      reason: 'kharab',
    });
    expect(ret).toMatchObject({ kind: 'return', total: -14_275, hashVersion: 2 });
    expect(first(ret.lines)).toMatchObject({ quantity: -500, unitScale: 1000, lineTotal: -14_275 });
    expect(await stockSum(t.driver, { variantId: chini.variant.id })).toBe(49_250);

    // the rest: 750 g -> 21,412.5 -> 21,413; the two refunds add up to the original 35,688
    const rest = await t.svc.checkout.previewReturn(sale.id, [{ lineId: line.id, quantity: 750 }]);
    expect(rest.total).toBe(-21_413);
    expect(14_275 + 21_413).toBe(sale.total);
  });

  it('cannot return more grams than were sold', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const sale = await sellCash(t, [{ variantId: chini.variant.id, quantity: 1250 }]);
    await expectCode(
      t.svc.checkout.previewReturn(sale.id, [{ lineId: first(sale.lines).id, quantity: 1251 }]),
      'ALREADY_RETURNED',
    );
  });

  it('voiding a weighted sale mirrors it exactly and restores the stock', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const sale = await sellCash(t, [{ variantId: chini.variant.id, quantity: 1250 }]);
    const voided = await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'galat bill' });
    expect(voided).toMatchObject({ kind: 'void', total: -35_688 });
    expect(await stockSum(t.driver, { variantId: chini.variant.id })).toBe(50_000);
  });

  it('keeps the chain valid and every integrity check at zero', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const pens = await addPens(t);
    const a = await sellCash(t, [{ variantId: chini.variant.id, quantity: 333 }]);
    await sellCash(t, [
      { variantId: pens.variant.id, quantity: 2 },
      { variantId: chini.variant.id, quantity: 4_150 },
    ]);
    await t.svc.checkout.voidSale({ originalSaleId: a.id, reason: 'test' });
    expect(await t.svc.integrity.verifyChain()).toMatchObject({ ok: true, count: 3 });
    expect(await t.svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
    });
  });

  it('reports use the unit scale for gross, cost and profit', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    await sellCash(t, [{ variantId: chini.variant.id, quantity: 1250 }]);
    const s = await t.svc.reports.summary({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER });
    expect(s.grossSales).toBe(35_688);
    expect(s.netSales).toBe(35_688);
    expect(s.estimatedCogs).toBe(31_250); // 1.25 kg x Rs 250 cost
    expect(s.estimatedProfit).toBe(4_438);
  });

  it('low-stock alerts compare grams with a gram reorder level', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t, 6_000); // 6 kg, reorder at 5 kg
    expect(chini.lowStock).toBe(false);
    await sellCash(t, [{ variantId: chini.variant.id, quantity: 1_500 }]); // 4.5 kg left
    const list = await t.svc.catalog.listAccessories({ lowStockOnly: true });
    expect(list.map((v) => v.variant.sku)).toEqual(['CHINI-LOOSE']);
  });

  it('adjustments are in grams and capped per unit', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const after = await t.svc.catalog.adjustStock({
      variantId: chini.variant.id,
      delta: -250,
      reason: 'sookh gaya',
    });
    expect(after.onHand).toBe(49_750);
    await expectCode(
      t.svc.catalog.adjustStock({ variantId: chini.variant.id, delta: 100_000_001, reason: 'x' }),
      'VALIDATION',
    );
  });
});

describe('buying loose goods from a supplier', () => {
  it('books the total with the same rounding and keeps the latest cost per kg', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t, 0);
    const supplier = await t.svc.purchasing.createSupplier({ name: 'Mandi Traders' });
    // 333 g at Rs 249.99/kg = 8,324.667 paisa -> 8,325
    const result = await t.svc.purchasing.receive({
      supplierId: supplier.id,
      phones: [],
      accessories: [{ variantId: chini.variant.id, quantity: 333, unitCost: 24_999 }],
    });
    expect(result.purchase.total).toBe(8_325);
    expect(result.supplierBalance).toBe(8_325);
    expect(await stockSum(t.driver, { variantId: chini.variant.id })).toBe(333);
    const [row] = await t.svc.catalog.listAccessories({ q: 'CHINI' });
    expect(row?.variant.costPrice).toBe(24_999);
  });

  it('a 25 kg bag at Rs 250/kg is Rs 6,250', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t, 0);
    const supplier = await t.svc.purchasing.createSupplier({ name: 'Mandi Traders' });
    const result = await t.svc.purchasing.receive({
      supplierId: supplier.id,
      phones: [],
      accessories: [{ variantId: chini.variant.id, quantity: 25_000, unitCost: CHINI.cost }],
      paidNow: { method: 'cash', amount: 500_000 },
    });
    expect(result.purchase.total).toBe(625_000);
    expect(result.supplierBalance).toBe(125_000);
  });

  it('refuses a purchase line for an item that does not exist', async () => {
    const t = await shopOf('kiryana');
    const supplier = await t.svc.purchasing.createSupplier({ name: 'Mandi Traders' });
    await expectCode(
      t.svc.purchasing.receive({
        supplierId: supplier.id,
        phones: [],
        accessories: [{ variantId: t.newId(), quantity: 1, unitCost: 1 }],
      }),
      'NOT_FOUND',
    );
  });
});

describe('the chain still verifies from raw rows', () => {
  it('re-reading weighted invoices from SQLite gives the same hashes', async () => {
    const t = await shopOf('kiryana');
    const chini = await addChini(t);
    const a = await sellCash(t, [{ variantId: chini.variant.id, quantity: 1250 }]);
    const b = await sellCash(t, [{ variantId: chini.variant.id, quantity: 333 }]);
    const { readInvoices } = await import('../helpers');
    const stored = await readInvoices(t.driver);
    expect(stored.map((i) => i.hash)).toEqual([a.hash, b.hash]);
    expect(verifyChain(stored)).toMatchObject({ ok: true, count: 2 });
  });
});
