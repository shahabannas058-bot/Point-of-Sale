import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/migrate';
import { createNodeSqliteDriver, loadMigrationsFromDir } from '../../src/node';
import { createPosService, seedDemoData } from '../../src/service';
import { expectCode, makeService } from './helpers';

async function freshDriver() {
  const driver = createNodeSqliteDriver(':memory:');
  await migrate(driver, loadMigrationsFromDir());
  return driver;
}

describe('seedDemoData', () => {
  it('seeds 12 phones, 25 accessories, 5 customers, 3 suppliers and 6 invoices; chain verifies; shop is flagged demo', async () => {
    const driver = await freshDriver();
    const summary = await seedDemoData({ driver, pinIterations: 1000 });
    expect(summary).toEqual({ phones: 12, accessories: 25, customers: 5, suppliers: 3, sales: 6 });

    const svc = createPosService({ driver, pinIterations: 1000 });
    expect(await svc.setup.isSetUp()).toBe(true);
    const shop = await svc.setup.getShop();
    expect(shop.isDemo).toBe(true);
    expect(shop.invoicePrefix).toBe('A');

    expect((await svc.auth.listLoginUsers()).map((u) => u.username)).toEqual([
      'owner',
      'manager',
      'cashier',
    ]);
    await svc.auth.login('owner', '1234');
    const chain = await svc.integrity.verifyChain();
    expect(chain).toMatchObject({ ok: true, count: 6, headSeq: 6 });
    expect(await svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
      badPhoneUnits: 0,
    });

    expect(await svc.catalog.listPhones()).toHaveLength(12);
    expect(await svc.catalog.listAccessories()).toHaveLength(25);
    expect(await svc.khata.listCustomers()).toHaveLength(5);
    expect(await svc.purchasing.listSuppliers()).toHaveLength(3);
    const kinds = (await svc.checkout.listInvoices()).map((i) => i.kind).sort();
    expect(kinds).toEqual(['return', 'sale', 'sale', 'sale', 'sale', 'sale']);
    driver.close();
  });

  it('a second seed throws ALREADY_SETUP and changes nothing', async () => {
    const driver = await freshDriver();
    await seedDemoData({ driver, pinIterations: 1000 });
    const rows = async () =>
      (await driver.query<{ n: number }>('select count(*) as n from outbox'))[0]?.n;
    const before = await rows();
    await expectCode(seedDemoData({ driver, pinIterations: 1000 }), 'ALREADY_SETUP');
    expect(await rows()).toBe(before);
    driver.close();
  });

  it('refuses to seed over a shop that was set up by hand', async () => {
    const t = await makeService();
    await expectCode(seedDemoData({ driver: t.driver, pinIterations: 1000 }), 'ALREADY_SETUP');
  });

  it('is deterministic: two seeded databases get the same device id and IMEIs', async () => {
    const a = await freshDriver();
    const b = await freshDriver();
    await seedDemoData({ driver: a, pinIterations: 1000 });
    await seedDemoData({ driver: b, pinIterations: 1000 });
    const imeis = (d: typeof a) =>
      d.query<{ imei1: string }>('select imei1 from phone_units order by imei1');
    expect(await imeis(a)).toEqual(await imeis(b));
    const dev = (d: typeof a) =>
      d.query<{ value: string }>("select value from app_meta where key = 'device_id'");
    expect(await dev(a)).toEqual(await dev(b));
    a.close();
    b.close();
  });

  it('the seeded cashier is subject to the 5 % discount limit', async () => {
    const driver = await freshDriver();
    await seedDemoData({ driver, pinIterations: 1000 });
    const svc = createPosService({ driver, pinIterations: 1000 });
    await svc.auth.login('cashier', '3456');
    const phone = (await svc.catalog.listPhones({ inStock: true }))[0];
    expect(phone).toBeDefined();
    const gross = phone?.unit.salePrice ?? 0;
    const preview = await svc.checkout.preview({
      lines: [
        {
          phoneUnitId: phone?.unit.id ?? '',
          quantity: 1,
          discountAmount: Math.floor(gross * 0.06),
        },
      ],
    });
    expect(preview.needsApproval).toEqual(['discount']);
    driver.close();
  });
});

describe('setup and settings', () => {
  it('NOT_SETUP before firstRun; firstRun twice gives ALREADY_SETUP', async () => {
    const t = await makeService({ seed: false });
    expect(await t.svc.setup.isSetUp()).toBe(false);
    await expectCode(t.svc.setup.getShop(), 'NOT_SETUP');
    const input = {
      shopName: 'Shop',
      branchName: 'Main',
      invoicePrefix: 'B',
      owner: { username: 'boss', displayName: 'Boss', pin: '1234' },
    };
    const info = await t.svc.setup.firstRun(input);
    expect(info).toMatchObject({ branchName: 'Main', invoicePrefix: 'B', isDemo: false });
    expect(info.shopName).toBe('Shop');
    expect(info.createdAt).toBeGreaterThan(0);
    await expectCode(t.svc.setup.firstRun(input), 'ALREADY_SETUP');
    expect(await t.svc.setup.getShop()).toEqual(info);
  });

  it('firstRun validates prefix, username, PIN and names', async () => {
    const t = await makeService({ seed: false });
    const ok = {
      shopName: 'Shop',
      branchName: 'Main',
      invoicePrefix: 'A',
      owner: { username: 'boss', displayName: 'Boss', pin: '1234' },
    };
    await expectCode(t.svc.setup.firstRun({ ...ok, invoicePrefix: 'abc' }), 'VALIDATION');
    await expectCode(t.svc.setup.firstRun({ ...ok, invoicePrefix: 'TOOLONG' }), 'VALIDATION');
    await expectCode(t.svc.setup.firstRun({ ...ok, shopName: ' ' }), 'VALIDATION');
    await expectCode(
      t.svc.setup.firstRun({ ...ok, owner: { ...ok.owner, pin: '12' } }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.setup.firstRun({ ...ok, owner: { ...ok.owner, username: 'Bad Name' } }),
      'VALIDATION',
    );
    expect(await t.svc.setup.isSetUp()).toBe(false);
  });

  it('two parallel firstRun calls set up exactly once', async () => {
    const t = await makeService({ seed: false });
    const input = {
      shopName: 'Shop',
      branchName: 'Main',
      invoicePrefix: 'A',
      owner: { username: 'boss', displayName: 'Boss', pin: '1234' },
    };
    const settled = await Promise.allSettled([
      t.svc.setup.firstRun(input),
      t.svc.setup.firstRun(input),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const users = await t.driver.query<{ n: number }>('select count(*) as n from users');
    expect(users[0]?.n).toBe(1);
  });

  it('settings: defaults, owner update, validation, and manager is forbidden', async () => {
    const t = await makeService();
    await t.loginAs('owner');
    expect(await t.svc.settings.get()).toEqual({
      shopName: 'Test Mobile Centre',
      address: null,
      phone: null,
      receiptFooter: null,
      receiptFooterUr: null,
      cashierMaxDiscountBps: 500,
      allowNegativeStock: false,
    });
    const updated = await t.svc.settings.update({
      shopName: 'Al-Madina Mobiles',
      address: 'Hall Road, Lahore',
      receiptFooter: 'Thank you',
      receiptFooterUr: 'شکریہ',
      cashierMaxDiscountBps: 300,
    });
    expect(updated).toMatchObject({
      shopName: 'Al-Madina Mobiles',
      address: 'Hall Road, Lahore',
      receiptFooterUr: 'شکریہ',
      cashierMaxDiscountBps: 300,
    });
    const cleared = await t.svc.settings.update({ address: null });
    expect(cleared.address).toBeNull();
    await expectCode(t.svc.settings.update({ cashierMaxDiscountBps: 10_001 }), 'VALIDATION');
    await expectCode(t.svc.settings.update({ cashierMaxDiscountBps: 1.5 }), 'VALIDATION');
    await expectCode(t.svc.settings.update({ shopName: '' }), 'VALIDATION');
    await expectCode(
      t.svc.settings.update({ allowNegativeStock: 'yes' as unknown as boolean }),
      'VALIDATION',
    );
    t.svc.auth.logout();
    await t.loginAs('cash');
    expect((await t.svc.settings.get()).cashierMaxDiscountBps).toBe(300); // reads need only a session
    await expectCode(t.svc.settings.update({ shopName: 'X' }), 'FORBIDDEN');
  });
});
