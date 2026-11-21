import { beforeEach, describe, expect, it } from 'vitest';
import { CHARGER_PRICE, first, makeService, sellCash, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('mgr');
});

const STEP_BACK = 2 * 60_000;

/** Closes the day, then steps the PC clock back so the next writes would land before the close. */
async function closeThenStepBack(): Promise<number> {
  const close = await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
  t.clock.advance(-STEP_BACK);
  return close.closedAt;
}

/** The clock is fixed again: the drawer's open period now reaches past the stamped writes. */
async function drawerAfterClockFix() {
  t.clock.advance(10 * 60_000);
  return t.svc.cash.drawer();
}

describe('cash writes with the PC clock behind the last day close', () => {
  it('a cash sale is stamped just after the close and counted in the open drawer', async () => {
    const closedAt = await closeThenStepBack();
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    expect(sale.createdAt).toBe(closedAt + 1);
    expect((await drawerAfterClockFix()).cashSales).toBe(CHARGER_PRICE);
    expect(await t.svc.integrity.verifyChain()).toMatchObject({ ok: true });
  });

  it('a cash udhaar payment is counted in the open drawer', async () => {
    await t.svc.checkout.commit({
      lines: [{ itemId: t.ids.chargerId, quantity: 1 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount: CHARGER_PRICE }],
    });
    const closedAt = await closeThenStepBack();
    await t.svc.khata.receivePayment({
      customerId: t.ids.bilalId,
      amount: CHARGER_PRICE,
      method: 'cash',
    });
    const ledger = await t.svc.khata.getLedger(t.ids.bilalId, { limit: 1 });
    expect(first(ledger.lines).entry.createdAt).toBe(closedAt + 1);
    expect((await drawerAfterClockFix()).udhaarCollected).toBe(CHARGER_PRICE);
  });

  it('reversing an expense of the open period takes it out of the drawer', async () => {
    const close = await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    t.clock.advance(60_000);
    const exp = await t.svc.cash.addEntry({
      type: 'expense',
      category: 'tea_food',
      amount: 20_000,
    });
    t.clock.advance(-10 * 60_000);
    const rev = await t.svc.cash.reverseEntry({ entryId: exp.id });
    expect(rev.createdAt).toBe(close.closedAt + 1);
    expect((await drawerAfterClockFix()).expenses).toBe(0);
  });

  it('an expense is stamped after the close instead of being lost in the closed period', async () => {
    const closedAt = await closeThenStepBack();
    const exp = await t.svc.cash.addEntry({ type: 'expense', category: 'rent', amount: 5_000 });
    expect(exp.createdAt).toBe(closedAt + 1);
    expect((await drawerAfterClockFix()).expenses).toBe(5_000);
  });

  it('a cash refund is counted in the open drawer', async () => {
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    const closedAt = await closeThenStepBack();
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
    });
    expect(ret.createdAt).toBe(closedAt + 1);
    expect((await drawerAfterClockFix()).cashRefunds).toBe(CHARGER_PRICE);
  });

  it('a void refund is counted in the open drawer', async () => {
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    await closeThenStepBack();
    await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'x' });
    expect((await drawerAfterClockFix()).cashRefunds).toBe(CHARGER_PRICE);
  });

  it('supplier payments (paySupplier and paid-now on receive) are counted in the open drawer', async () => {
    const s = await t.svc.purchasing.createSupplier({ name: 'Wholesaler' });
    const closedAt = await closeThenStepBack();
    const received = await t.svc.purchasing.receive({
      supplierId: s.id,
      items: [{ itemId: t.ids.chargerId, quantity: 1, unitCost: 90_000 }],
      paidNow: { method: 'cash', amount: 10_000 },
    });
    expect(received.purchase.createdAt).toBeGreaterThan(closedAt);
    await t.svc.purchasing.paySupplier({ supplierId: s.id, amount: 30_000, method: 'cash' });
    expect((await drawerAfterClockFix()).supplierPaid).toBe(40_000);
  });

  it('with the clock ahead of the last close the real time is kept', async () => {
    const close = await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    const at = t.clock.peek();
    const sale = await sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);
    expect(sale.createdAt).toBeGreaterThanOrEqual(at);
    expect(sale.createdAt).toBeGreaterThan(close.closedAt + 1);
  });
});
