import { describe, expect, it } from 'vitest';
import { MODULE_PRESETS } from '@pos/shared';
import { migrate } from '../../src/migrate';
import { createNodeSqliteDriver, loadMigrationsFromDir } from '../../src/node';
import { createPosService, seedDemoData } from '../../src/service';
import { expectCode } from './helpers';

async function freshDriver() {
  const driver = createNodeSqliteDriver(':memory:');
  await migrate(driver, loadMigrationsFromDir());
  return driver;
}

async function seededKiryana() {
  const driver = await freshDriver();
  const summary = await seedDemoData({ driver, pinIterations: 1000 }, { businessType: 'kiryana' });
  const svc = createPosService({ driver, pinIterations: 1000 });
  return { driver, summary, svc };
}

describe('seedDemoData for a kiryana shop', () => {
  it('creates a demo shop that is a kiryana shop with the kiryana modules and no phones', async () => {
    const { driver, summary, svc } = await seededKiryana();
    const shop = await svc.setup.getShop();
    expect(shop).toMatchObject({
      isDemo: true,
      businessType: 'kiryana',
      modules: MODULE_PRESETS.kiryana,
    });
    expect(summary.phones).toBe(0);
    expect(summary.accessories).toBeGreaterThanOrEqual(15);
    expect(summary.customers).toBeGreaterThanOrEqual(4);
    expect(summary.suppliers).toBeGreaterThanOrEqual(2);
    expect((await svc.auth.listLoginUsers()).map((u) => u.username)).toEqual([
      'owner',
      'manager',
      'cashier',
    ]);
    driver.close();
  });

  it('stocks loose goods per kg / litre and packed goods per piece with a barcode', async () => {
    const { driver, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    const items = await svc.catalog.listAccessories();
    const loose = items.filter((i) => i.variant.unitScale === 1000);
    const packed = items.filter((i) => i.variant.unitScale === 1);
    expect(loose.length).toBeGreaterThanOrEqual(6);
    expect(packed.length).toBeGreaterThanOrEqual(8);
    expect(loose.some((i) => i.variant.unitLabel === 'L')).toBe(true);
    expect(loose.some((i) => i.variant.unitLabel === 'kg')).toBe(true);
    expect(packed.every((i) => i.variant.barcode !== null)).toBe(true);
    expect(items.every((i) => i.onHand > 0)).toBe(true);
    expect(await svc.catalog.listPhones()).toEqual([]);
    driver.close();
  });

  it('has a few low-stock items so the weekly wholesale list is not empty', async () => {
    const { driver, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    const low = await svc.catalog.listAccessories({ lowStockOnly: true });
    expect(low.length).toBeGreaterThanOrEqual(2);
    driver.close();
  });

  it('has sample sales including a weighed line in grams; chain and integrity checks are clean', async () => {
    const { driver, summary, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    const invoices = await svc.checkout.listInvoices();
    expect(invoices.length).toBe(summary.sales);
    expect(summary.sales).toBeGreaterThanOrEqual(5);
    expect(await svc.integrity.verifyChain()).toMatchObject({ ok: true, count: summary.sales });
    expect(await svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
      badPhoneUnits: 0,
    });
    const weighed = await driver.query<{ n: number }>(
      'select count(*) as n from sale_lines where unit_scale = 1000 and quantity % 1000 <> 0',
    );
    expect(weighed[0]?.n).toBeGreaterThanOrEqual(1);
    driver.close();
  });

  it('has dairy batches: one expired, one expiring this week, and the rest comfortably fresh', async () => {
    const { driver, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    const batches = await svc.batches.list();
    expect(batches.length).toBeGreaterThanOrEqual(4);
    expect(batches.some((b) => b.daysLeft < 0)).toBe(true);
    expect(batches.some((b) => b.daysLeft >= 0 && b.daysLeft <= 7)).toBe(true);
    expect(batches.some((b) => b.daysLeft > 30)).toBe(true);
    expect(batches.map((b) => b.daysLeft)).toEqual(
      [...batches.map((b) => b.daysLeft)].sort((a, b) => a - b),
    );
    // a batch of a perishable item never exceeds the stock the item has on hand
    const items = await svc.catalog.listAccessories();
    for (const b of batches) {
      const item = items.find((i) => i.variant.id === b.variantId);
      expect(item?.onHand ?? 0).toBeGreaterThanOrEqual(b.onHand);
    }
    driver.close();
  });

  it('has a customer with an open khata balance and a supplier we owe money', async () => {
    const { driver, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    const customers = await svc.khata.listCustomers();
    expect(customers.some((c) => c.balance > 0)).toBe(true);
    const suppliers = await svc.purchasing.listSuppliers();
    expect(suppliers.some((s) => s.balance > 0)).toBe(true);
    driver.close();
  });

  it('still refuses mobile-shop features: repairs are MODULE_DISABLED', async () => {
    const { driver, svc } = await seededKiryana();
    await svc.auth.login('owner', '1234');
    await expectCode(svc.repairs.list(), 'MODULE_DISABLED');
    driver.close();
  });

  it('is deterministic: two kiryana seeds get the same SKUs, barcodes and device id', async () => {
    const a = await seededKiryana();
    const b = await seededKiryana();
    const skus = (d: typeof a.driver) =>
      d.query<{ sku: string; barcode: string | null }>(
        'select sku, barcode from accessory_variants order by sku',
      );
    expect(await skus(a.driver)).toEqual(await skus(b.driver));
    const dev = (d: typeof a.driver) =>
      d.query<{ value: string }>("select value from app_meta where key = 'device_id'");
    expect(await dev(a.driver)).toEqual(await dev(b.driver));
    a.driver.close();
    b.driver.close();
  });

  it('a second kiryana seed throws ALREADY_SETUP', async () => {
    const { driver } = await seededKiryana();
    await expectCode(
      seedDemoData({ driver, pinIterations: 1000 }, { businessType: 'kiryana' }),
      'ALREADY_SETUP',
    );
    driver.close();
  });

  it('the default seed is still the mobile shop (no option = unchanged behaviour)', async () => {
    const driver = await freshDriver();
    const summary = await seedDemoData({ driver, pinIterations: 1000 });
    expect(summary.phones).toBe(12);
    const svc = createPosService({ driver, pinIterations: 1000 });
    expect((await svc.setup.getShop()).businessType).toBe('custom');
    driver.close();
  });
});
