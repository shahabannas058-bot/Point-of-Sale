import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_MS } from '../../../core/test/fixtures';
import { CHARGER_PRICE, expectCode, first, makeService, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const WIDE = { fromMs: 0, toMs: 2 * BASE_MS };

describe('daily report arithmetic (spec 8)', () => {
  /**
   * A = 2 chargers, line discount 10 000 (gross 300 000, total 290 000, cash)
   * B = phone X, invoice discount 100 000 (total 8 400 000: cash 5 000 000 + khata 3 400 000 to Bilal)
   * return 1 charger from A (-145 000), Bilal pays 1 000 000 cash.
   */
  async function scenario(): Promise<void> {
    await t.loginAs('owner');
    const a = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2, discountAmount: 10_000 }],
      payments: [{ method: 'cash', amount: 290_000 }],
    });
    await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      customerId: t.ids.bilalId,
      invoiceDiscount: 100_000,
      payments: [
        { method: 'cash', amount: 5_000_000 },
        { method: 'khata', amount: 3_400_000 },
      ],
    });
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: a.id,
      lines: [{ lineId: first(a.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: 145_000 }],
      reason: 'One faulty',
    });
    expect(ret.total).toBe(-145_000);
    await t.svc.khata.receivePayment({
      customerId: t.ids.bilalId,
      amount: 1_000_000,
      method: 'cash',
    });
  }

  it('matches the hand-computed figures', async () => {
    await scenario();
    const s = await t.svc.reports.summary(WIDE);
    expect(s).toMatchObject({
      salesCount: 2,
      returnsCount: 1,
      grossSales: 8_800_000,
      discounts: 110_000,
      netSales: 8_690_000,
      returnsTotal: 145_000,
      netRevenue: 8_545_000,
      khataCollected: 1_000_000,
      cashInDrawer: 6_145_000,
      estimatedCogs: 7_890_000,
      estimatedProfit: 655_000,
    });
    expect(s.byMethod).toMatchObject({ cash: 5_145_000, khata: 3_400_000 });
    expect(s.byMethod.jazzcash).toBe(0);
    expect(s.byMethod.easypaisa).toBe(0);
    expect(s.netRevenue).toBe(s.netSales - s.returnsTotal);
    expect(s.estimatedProfit).toBe(s.netRevenue - s.estimatedCogs);
    expect(s.estimatedProfit).toBe(110_000 + 600_000 - 55_000);
  });

  it('low stock lists the charger only when on hand <= reorder level (3)', async () => {
    await scenario();
    expect((await t.svc.reports.summary(WIDE)).lowStock).toEqual([]); // 10 - 2 + 1 = 9
    await t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: -6, reason: 'Damaged' });
    const low = (await t.svc.reports.summary(WIDE)).lowStock;
    expect(low.map((v) => [v.variant.id, v.onHand, v.lowStock])).toEqual([
      [t.ids.chargerId, 3, true],
    ]);
  });

  it('a range before the first sale returns all zeros', async () => {
    await scenario();
    const s = await t.svc.reports.summary({ fromMs: 0, toMs: BASE_MS - 1 });
    expect(s).toMatchObject({
      salesCount: 0,
      returnsCount: 0,
      grossSales: 0,
      discounts: 0,
      netSales: 0,
      returnsTotal: 0,
      netRevenue: 0,
      khataCollected: 0,
      cashInDrawer: 0,
      estimatedCogs: 0,
      estimatedProfit: 0,
    });
    expect(Object.values(s.byMethod).every((v) => v === 0)).toBe(true);
  });

  it('the range is half-open [from, to)', async () => {
    await t.loginAs('owner');
    const inv = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      payments: [{ method: 'cash', amount: CHARGER_PRICE }],
    });
    const exact = await t.svc.reports.summary({ fromMs: inv.createdAt, toMs: inv.createdAt + 1 });
    expect(exact.salesCount).toBe(1);
    const excluded = await t.svc.reports.summary({ fromMs: 0, toMs: inv.createdAt });
    expect(excluded.salesCount).toBe(0);
    const after = await t.svc.reports.summary({ fromMs: inv.createdAt + 1, toMs: 2 * BASE_MS });
    expect(after.salesCount).toBe(0);
  });

  it('splits payment methods and nets refunds', async () => {
    await t.loginAs('owner');
    const sale = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 4 }],
      payments: [
        { method: 'cash', amount: 200_000 },
        { method: 'jazzcash', amount: 250_000 },
        { method: 'easypaisa', amount: 150_000 },
      ],
    });
    await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'cancel' });
    const s = await t.svc.reports.summary(WIDE);
    expect(s.salesCount).toBe(1);
    expect(s.returnsCount).toBe(1);
    expect(s.netRevenue).toBe(0);
    expect(s.estimatedProfit).toBe(0);
    expect(s.byMethod).toMatchObject({ cash: 0, jazzcash: 0, easypaisa: 0 });
  });
});

describe('report access and licence', () => {
  it('needs view_reports: a cashier gets FORBIDDEN, a manager is fine, no session is NOT_AUTHENTICATED', async () => {
    await expectCode(t.svc.reports.summary(WIDE), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    const e = await expectCode(t.svc.reports.summary(WIDE), 'FORBIDDEN');
    expect(e.details).toMatchObject({ permission: 'view_reports' });
    t.svc.auth.logout();
    await t.loginAs('mgr');
    expect((await t.svc.reports.summary(WIDE)).salesCount).toBe(0);
  });

  it('consults the licence hook with action report; a block stops the report', async () => {
    await t.loginAs('owner');
    await t.svc.reports.summary(WIDE);
    expect(t.assertCanSell).toHaveBeenCalledTimes(1);
    expect(t.assertCanSell).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'report', branchId: t.ids.branchId }),
    );
    t.assertCanSell.mockRejectedValueOnce(new Error('licence down'));
    await expectCode(t.svc.reports.summary(WIDE), 'INTERNAL');
  });

  it('rejects an inverted or non-integer range with VALIDATION', async () => {
    await t.loginAs('owner');
    await expectCode(t.svc.reports.summary({ fromMs: 10, toMs: 5 }), 'VALIDATION');
    await expectCode(t.svc.reports.summary({ fromMs: 0.5, toMs: 5 }), 'VALIDATION');
  });
});
