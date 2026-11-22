import { beforeEach, describe, expect, it } from 'vitest';
import type { Invoice, ItemView } from '@pos/shared';
import {
  CARTON_COST,
  CHARGER_COST,
  CHARGER_PRICE,
  PINS,
  first,
  makeService,
  sellCash,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const itemCosts = (views: readonly ItemView[]): number[] => views.map((v) => v.item.costPrice);
const lineCosts = (inv: Invoice): number[] => inv.lines.map((l) => l.costPrice);

describe('a cashier (no view_cost) never receives cost prices', () => {
  it('catalog.search and listItems mask item cost to 0', async () => {
    await t.loginAs('cash');
    const hits = await t.svc.catalog.search('CHG-25W');
    expect(hits).toHaveLength(1);
    expect(itemCosts(hits.map((h) => h.item))).toEqual([0]);
    expect(itemCosts(await t.svc.catalog.listItems())).toEqual([0, 0]);
  });

  it('catalog.quickItems masks item cost', async () => {
    await t.loginAs('owner');
    await t.svc.catalog.setQuickItems([t.ids.chargerId, t.ids.cartonId]);
    await t.loginAs('cash');
    expect(itemCosts(await t.svc.catalog.quickItems())).toEqual([0, 0]);
  });

  it('insights.reorder masks the item cost in its item views', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 8 }]); // 2 left, reorder level 3
    await t.loginAs('cash');
    const rows = await t.svc.insights.reorder();
    expect(rows.length).toBeGreaterThan(0);
    expect(itemCosts(rows.map((r) => r.item)).every((c) => c === 0)).toBe(true);
  });

  it('commit, getInvoice and previewReturn mask the line cost snapshot', async () => {
    await t.loginAs('cash');
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    expect(lineCosts(sale)).toEqual([0]);
    expect(lineCosts((await t.svc.checkout.getInvoice(sale.id)).invoice)).toEqual([0]);
    expect(lineCosts((await t.svc.checkout.getInvoice(sale.invoiceNo)).invoice)).toEqual([0]);
    const pv = await t.svc.checkout.previewReturn(sale.id, [
      { lineId: first(sale.lines).id, quantity: 1 },
    ]);
    expect(lineCosts(pv.original.invoice)).toEqual([0]);
  });

  it('the stored sale, an approved return and reports keep the real cost', async () => {
    await t.loginAs('cash');
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    const grant = await t.svc.auth.requestApproval(PINS.mgr);
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
      approvalToken: grant.token,
    });
    expect(lineCosts(ret)).toEqual([0]);
    const stored = await t.driver.query<{ cost_price: number }>(
      'SELECT cost_price FROM sale_lines ORDER BY created_at',
    );
    expect(stored.map((r) => r.cost_price)).toEqual([CHARGER_COST, CHARGER_COST]);
  });
});

describe('a manager (view_cost) sees cost prices', () => {
  it('search, listItems and getInvoice keep the cost', async () => {
    await t.loginAs('mgr');
    const hits = await t.svc.catalog.search('CHG-25W');
    expect(itemCosts(hits.map((h) => h.item))).toEqual([CHARGER_COST]);
    expect(itemCosts(await t.svc.catalog.listItems()).sort((a, b) => a - b)).toEqual(
      [CHARGER_COST, CARTON_COST].sort((a, b) => a - b),
    );
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    expect(lineCosts(sale)).toEqual([CHARGER_COST]);
    expect(lineCosts((await t.svc.checkout.getInvoice(sale.id)).invoice)).toEqual([CHARGER_COST]);
  });
});
