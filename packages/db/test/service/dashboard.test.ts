import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_MS } from '../../../core/test/fixtures';
import {
  CHARGER_COST,
  CHARGER_PRICE,
  PHONE_COST,
  PHONE_PRICE,
  expectCode,
  first,
  makeService,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const HOUR = 3_600_000;
/** Three one-hour buckets starting at BASE_MS. */
const BUCKETS = [BASE_MS, BASE_MS + HOUR, BASE_MS + 2 * HOUR, BASE_MS + 3 * HOUR];

describe('reports.dashboard', () => {
  it('needs view_reports and valid bucket boundaries', async () => {
    await t.loginAs('cash');
    await expectCode(t.svc.reports.dashboard({ buckets: BUCKETS }), 'FORBIDDEN');
    await t.loginAs('owner');
    await expectCode(t.svc.reports.dashboard({ buckets: [BASE_MS] }), 'VALIDATION');
    await expectCode(t.svc.reports.dashboard({ buckets: [BASE_MS + HOUR, BASE_MS] }), 'VALIDATION');
    await expectCode(t.svc.reports.dashboard({ buckets: [BASE_MS, 1.5] }), 'VALIDATION');
  });

  it('values stock on hand at cost: the seeded phone plus 10 chargers', async () => {
    await t.loginAs('owner');
    const d = await t.svc.reports.dashboard({ buckets: BUCKETS });
    expect(d.inventoryValue).toBe(PHONE_COST + 10 * CHARGER_COST);
  });

  it('buckets revenue and profit, nets returns, and ranks categories', async () => {
    await t.loginAs('owner');
    const a = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      payments: [{ method: 'cash', amount: 2 * CHARGER_PRICE }],
    }); // bucket 0
    t.clock.advance(HOUR);
    await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      payments: [{ method: 'cash', amount: PHONE_PRICE }],
    }); // bucket 1
    await t.svc.checkout.createReturn({
      originalSaleId: a.id,
      lines: [{ lineId: first(a.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'Faulty',
    }); // bucket 1, negative

    const d = await t.svc.reports.dashboard({ buckets: BUCKETS });
    expect(d.trend).toEqual([
      {
        fromMs: BUCKETS[0],
        toMs: BUCKETS[1],
        revenue: 2 * CHARGER_PRICE,
        profit: 2 * (CHARGER_PRICE - CHARGER_COST),
        salesCount: 1,
      },
      {
        fromMs: BUCKETS[1],
        toMs: BUCKETS[2],
        revenue: PHONE_PRICE - CHARGER_PRICE,
        profit: PHONE_PRICE - PHONE_COST - (CHARGER_PRICE - CHARGER_COST),
        salesCount: 1,
      },
      { fromMs: BUCKETS[2], toMs: BUCKETS[3], revenue: 0, profit: 0, salesCount: 0 },
    ]);
    expect(d.topCategories).toEqual([
      { category: 'Smartphone', revenue: PHONE_PRICE },
      { category: 'Charger', revenue: CHARGER_PRICE },
    ]);
    // stock moved: phone sold, 1 charger out net
    expect(d.inventoryValue).toBe(9 * CHARGER_COST);
  });

  it('ignores sales outside the buckets', async () => {
    await t.loginAs('owner');
    t.clock.advance(5 * HOUR);
    await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      payments: [{ method: 'cash', amount: CHARGER_PRICE }],
    });
    const d = await t.svc.reports.dashboard({ buckets: BUCKETS });
    expect(d.trend.every((p) => p.revenue === 0 && p.salesCount === 0)).toBe(true);
    expect(d.topCategories).toEqual([]);
  });
});
