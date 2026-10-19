import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_MS } from '../../../core/test/fixtures';
import { makeService, stockSum, type TestService } from './helpers';

/** Rs 190/kg; "Rs 250 ke chawal" is 1316 g = Rs 250.04, 4 paisa rounded off. */
const CHAWAL_PRICE = 19_000;
const WIDE = { fromMs: 0, toMs: 2 * BASE_MS };

let t: TestService;
let chawalId: string;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('owner');
  const v = await t.svc.catalog.createAccessory({
    product: { brand: 'Loose', name: 'Chawal Basmati', category: 'Grocery' },
    sku: 'CHAWAL-LOOSE',
    costPrice: 15_000,
    salePrice: CHAWAL_PRICE,
    reorderLevel: 5_000,
    openingQty: 10_000,
    unit: 'kg',
  });
  chawalId = v.variant.id;
});

const line = { variantId: '', quantity: 1316, discountAmount: 4 };

describe('a weight round-off is not a discount', () => {
  it('preview: the cart shows no item discount and the gross is the rupees typed', async () => {
    const p = await t.svc.checkout.preview({ lines: [{ ...line, variantId: chawalId }] });
    expect(p.lines[0]?.lineTotal).toBe(25_000);
    expect(p).toMatchObject({
      grossTotal: 25_000,
      lineDiscounts: 0,
      subtotal: 25_000,
      total: 25_000,
      effectiveDiscountBps: 0,
      needsApproval: [],
    });
  });

  it('commit: the invoice still keeps the 4 paisa in discount_amount (total = gross - discount holds) and stock drops 1.316 kg', async () => {
    const inv = await t.svc.checkout.commit({
      lines: [{ ...line, variantId: chawalId }],
      payments: [{ method: 'cash', amount: 25_000 }],
    });
    expect(inv.lines[0]).toMatchObject({ quantity: 1316, discountAmount: 4, lineTotal: 25_000 });
    expect(inv.total).toBe(25_000);
    expect(await stockSum(t.driver, { variantId: chawalId })).toBe(10_000 - 1316);
  });

  it('report: discounts given stay 0 and gross equals net sales', async () => {
    await t.svc.checkout.commit({
      lines: [{ ...line, variantId: chawalId }],
      payments: [{ method: 'cash', amount: 25_000 }],
    });
    const s = await t.svc.reports.summary(WIDE);
    expect(s).toMatchObject({ grossSales: 25_000, discounts: 0, netSales: 25_000 });
  });

  it('a real discount on a weighed line still counts everywhere', async () => {
    const p = await t.svc.checkout.preview({
      lines: [{ variantId: chawalId, quantity: 2000, discountAmount: 1_000 }],
    });
    expect(p).toMatchObject({ grossTotal: 38_000, lineDiscounts: 1_000, total: 37_000 });
  });
});
