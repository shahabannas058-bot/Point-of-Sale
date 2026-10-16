import { beforeEach, describe, expect, it } from 'vitest';
import { allocate, negPaisa, paisa } from '@pos/core';
import {
  CHARGER_PRICE,
  PHONE_PRICE,
  expectCode,
  first,
  makeService,
  sellCash,
  snapshotCounts,
  stockSum,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const onHand = (): Promise<number> => stockSum(t.driver, { variantId: t.ids.chargerId });

describe('return restores stock (spec 7)', () => {
  it('returns 2 of 3 chargers: negative lines, payment and total, stock 10-3+2, chain intact', async () => {
    await t.loginAs('mgr');
    const sale = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 3 }],
      payments: [{ method: 'cash', amount: 450_000 }],
    });
    const line = first(sale.lines, 'line');
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 2 }],
      refund: [{ method: 'cash', amount: 300_000 }],
      reason: 'Faulty',
    });

    expect(ret.kind).toBe('return');
    expect(ret.seq).toBe(2);
    expect(ret.originalSaleId).toBe(sale.id);
    expect(ret.lines).toHaveLength(1);
    expect(first(ret.lines).quantity).toBe(-2);
    expect(ret.total).toBe(-300_000);
    expect(first(ret.payments)).toMatchObject({ method: 'cash', amount: -300_000 });
    expect(ret.note).toBe('Faulty');
    expect(ret.prevHash).toBe(sale.hash);
    expect(await onHand()).toBe(9);
    expect(await t.svc.integrity.verifyChain()).toMatchObject({ ok: true, count: 2, headSeq: 2 });
    expect(await t.svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
      badPhoneUnits: 0,
    });
  });

  it('a second return of 2 gives ALREADY_RETURNED (1 remaining) and writes nothing', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 3 }]);
    const line = first(sale.lines);
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 2 }],
      refund: [{ method: 'cash', amount: 300_000 }],
      reason: 'x',
    });
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.checkout.createReturn({
        originalSaleId: sale.id,
        lines: [{ lineId: line.id, quantity: 2 }],
        refund: [{ method: 'cash', amount: 300_000 }],
        reason: 'x',
      }),
      'ALREADY_RETURNED',
    );
    expect(e.details).toMatchObject({ remainingQty: 1, requested: 2 });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('previewReturn reports remaining quantities and a refund suggestion', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 3 }]);
    const line = first(sale.lines);
    const p1 = await t.svc.checkout.previewReturn(sale.id, [{ lineId: line.id, quantity: 1 }]);
    expect(p1.total).toBe(-150_000);
    expect(p1.suggestedRefund).toEqual([{ method: 'cash', amount: -150_000 }]);
    expect(first(p1.lines)).toMatchObject({ soldQty: 3, returnedQty: 0, remainingQty: 3 });
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: [{ method: 'cash', amount: 150_000 }],
      reason: 'x',
    });
    const p2 = await t.svc.checkout.previewReturn(sale.id, []);
    expect(first(p2.lines)).toMatchObject({ returnedQty: 1, remainingQty: 2 });
    expect(p2.total).toBe(0);
  });

  it('a cashier return without a token needs approval (reason return); with a grant it works', async () => {
    await t.loginAs('cash');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 2 }]);
    const line = first(sale.lines);
    const input = {
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: [{ method: 'cash' as const, amount: CHARGER_PRICE }],
      reason: 'Customer changed mind',
    };
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(t.svc.checkout.createReturn(input), 'APPROVAL_REQUIRED');
    expect(e.details).toMatchObject({ reason: 'return' });
    expect(await snapshotCounts(t.driver)).toEqual(before);

    const grant = await t.svc.auth.requestApproval('2345');
    const ret = await t.svc.checkout.createReturn({ ...input, approvalToken: grant.token });
    expect(ret.note).toBe('Customer changed mind | approved:mgr');
    await expectCode(
      t.svc.checkout.createReturn({ ...input, approvalToken: grant.token }),
      'APPROVAL_REQUIRED',
    );
  });

  it('a khata sale returned with a khata refund books return_credit -150 000 and zeroes the balance', async () => {
    await t.loginAs('mgr');
    const sale = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount: CHARGER_PRICE }],
    });
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'khata', amount: CHARGER_PRICE }],
      reason: 'Returned',
    });
    expect(ret.customerId).toBe(t.ids.bilalId);
    const ledger = await t.driver.query<{ type: string; amount: number }>(
      'select type, amount from ledger_entries where customer_id = ? order by created_at, id',
      [t.ids.bilalId],
    );
    expect(ledger).toEqual([
      { type: 'sale_credit', amount: 150_000 },
      { type: 'return_credit', amount: -150_000 },
    ]);
    const customers = await t.svc.khata.listCustomers();
    expect(customers.find((c) => c.party.id === t.ids.bilalId)?.balance).toBe(0);
  });

  it('a khata refund on a sale without a customer is KHATA_NEEDS_CUSTOMER', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    await expectCode(
      t.svc.checkout.createReturn({
        originalSaleId: sale.id,
        lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
        refund: [{ method: 'khata', amount: CHARGER_PRICE }],
        reason: 'x',
      }),
      'KHATA_NEEDS_CUSTOMER',
    );
  });

  it('a refund that does not match the return total is PAYMENT_MISMATCH', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 2 }]);
    await expectCode(
      t.svc.checkout.createReturn({
        originalSaleId: sale.id,
        lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
        refund: [{ method: 'cash', amount: CHARGER_PRICE - 1 }],
        reason: 'x',
      }),
      'PAYMENT_MISMATCH',
    );
  });

  it('a returned phone is back in stock and can be sold again', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ phoneUnitId: t.ids.phoneId, quantity: 1 }]);
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(0);
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: PHONE_PRICE }],
      reason: 'Dead on arrival',
    });
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(1);
    const again = await sellCash(t, [{ phoneUnitId: t.ids.phoneId, quantity: 1 }]);
    expect(again.seq).toBe(3);
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(0);
    expect((await t.svc.integrity.checks()).badPhoneUnits).toBe(0);
  });

  it('a return invoice cannot itself be returned (RETURN_NOT_ALLOWED)', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 2 }]);
    const ret = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
    });
    await expectCode(t.svc.checkout.previewReturn(ret.id, []), 'RETURN_NOT_ALLOWED');
    await expectCode(
      t.svc.checkout.voidSale({ originalSaleId: ret.id, reason: 'x' }),
      'RETURN_NOT_ALLOWED',
    );
  });

  it('validation: missing reason, empty lines, unknown line, zero quantity', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 2 }]);
    const line = first(sale.lines);
    const base = {
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: [{ method: 'cash' as const, amount: CHARGER_PRICE }],
      reason: 'x',
    };
    await expectCode(t.svc.checkout.createReturn({ ...base, reason: '  ' }), 'VALIDATION');
    await expectCode(t.svc.checkout.createReturn({ ...base, lines: [] }), 'EMPTY_CART');
    await expectCode(
      t.svc.checkout.createReturn({ ...base, lines: [{ lineId: t.newId(), quantity: 1 }] }),
      'NOT_FOUND',
    );
    await expectCode(
      t.svc.checkout.createReturn({ ...base, lines: [{ lineId: line.id, quantity: 0 }] }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.checkout.createReturn({ ...base, originalSaleId: t.newId() }),
      'NOT_FOUND',
    );
  });

  it('createReturn is idempotent per saleId', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 3 }]);
    const input = {
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash' as const, amount: CHARGER_PRICE }],
      reason: 'x',
      saleId: t.newId(),
    };
    const a = await t.svc.checkout.createReturn(input);
    const b = await t.svc.checkout.createReturn(input);
    expect(b.id).toBe(a.id);
    expect((await snapshotCounts(t.driver)).sales).toBe(2);
    expect(await onHand()).toBe(8);
  });
});

describe('voidSale', () => {
  it('creates a void invoice that mirrors the split payments and reverses khata and stock', async () => {
    await t.loginAs('mgr');
    const sale = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      customerId: t.ids.bilalId,
      payments: [
        { method: 'cash', amount: 100_000 },
        { method: 'khata', amount: 200_000 },
      ],
    });
    const voided = await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'Wrong item' });
    expect(voided.kind).toBe('void');
    expect(voided.originalSaleId).toBe(sale.id);
    expect(voided.total).toBe(-300_000);
    expect(voided.payments.map((p) => [p.method, p.amount]).sort()).toEqual([
      ['cash', -100_000],
      ['khata', -200_000],
    ]);
    expect(first(voided.lines).quantity).toBe(-2);
    expect(await onHand()).toBe(10);
    const customers = await t.svc.khata.listCustomers();
    expect(customers.find((c) => c.party.id === t.ids.bilalId)?.balance).toBe(0);
    expect((await t.svc.integrity.verifyChain()).ok).toBe(true);

    const list = await t.svc.checkout.listInvoices();
    const original = list.find((s) => s.id === sale.id);
    expect(original?.returnedTotal).toBe(300_000);
    await expectCode(
      t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'again' }),
      'ALREADY_RETURNED',
    );
  });

  it('voids only what is left after a partial return, scaling the refund', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 3 }]);
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: first(sale.lines).id, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'x',
    });
    const voided = await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'rest' });
    expect(voided.total).toBe(-300_000);
    expect(first(voided.lines).quantity).toBe(-2);
    expect(await onHand()).toBe(10);
  });

  it('a cashier void needs approval (reason void)', async () => {
    await t.loginAs('cash');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    const e = await expectCode(
      t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'oops' }),
      'APPROVAL_REQUIRED',
    );
    expect(e.details).toMatchObject({ reason: 'void' });
    const grant = await t.svc.auth.requestApproval('2345');
    const v = await t.svc.checkout.voidSale({
      originalSaleId: sale.id,
      reason: 'oops',
      approvalToken: grant.token,
    });
    expect(v.kind).toBe('void');
  });

  it('a reason is mandatory', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    await expectCode(
      t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: '' }),
      'VALIDATION',
    );
  });

  it('calls the licence hook with the void action and honours a block', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    t.assertCanSell.mockClear();
    t.assertCanSell.mockRejectedValueOnce(new Error('boom'));
    const before = await snapshotCounts(t.driver);
    await expectCode(t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'x' }), 'INTERNAL');
    expect(await snapshotCounts(t.driver)).toEqual(before);
    await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'x' });
    expect(t.assertCanSell).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'void' }));
  });
});

describe('discount rounding on partial returns (spec 16, corrected)', () => {
  it('allocate(100, [1, 2])[0] is 33, not 34, and the cumulative scheme gives 33 / 34 / 33', () => {
    expect(allocate(paisa(100), [1, 2])).toEqual([33, 67]);
    expect(allocate(paisa(100), [2, 1])).toEqual([67, 33]);
    // F(k) = allocate(D, [k, N-k])[0]: 33, 67, 100
    const f = (k: number): number => (k >= 3 ? 100 : (allocate(paisa(100), [k, 3 - k])[0] ?? 0));
    expect([f(1) - f(0), f(2) - f(1), f(3) - f(2)]).toEqual([33, 34, 33]);
  });

  /** 3 chargers with a 100 paisa line discount. */
  async function discountedSale(): Promise<ReturnType<typeof sellCash>> {
    return sellCash(t, [{ variantId: t.ids.chargerId, quantity: 3, discountAmount: 100 }]);
  }

  it('three single-unit returns give back 33, 34 and 33 and sum to the original discount', async () => {
    await t.loginAs('mgr');
    const sale = await discountedSale();
    expect(sale.total).toBe(3 * CHARGER_PRICE - 100);
    const lineId = first(sale.lines).id;
    const shares: number[] = [];
    let refunded = 0;
    for (let i = 0; i < 3; i += 1) {
      const preview = await t.svc.checkout.previewReturn(sale.id, [{ lineId, quantity: 1 }]);
      const ret = await t.svc.checkout.createReturn({
        originalSaleId: sale.id,
        lines: [{ lineId, quantity: 1 }],
        refund: preview.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
        reason: `unit ${i + 1}`,
      });
      expect(ret.total).toBe(preview.total);
      shares.push(negPaisa(first(ret.lines).discountAmount));
      refunded += negPaisa(ret.total);
    }
    expect(shares).toEqual([33, 34, 33]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(refunded).toBe(sale.total); // everything given back, nothing lost to rounding
    expect(await onHand()).toBe(10);
    await expectCode(
      t.svc.checkout.createReturn({
        originalSaleId: sale.id,
        lines: [{ lineId, quantity: 1 }],
        refund: [{ method: 'cash', amount: CHARGER_PRICE }],
        reason: 'one too many',
      }),
      'ALREADY_RETURNED',
    );
    expect((await t.svc.integrity.verifyChain()).ok).toBe(true);
  });

  it('returning 2 units then 1 gives back 67 then 33', async () => {
    await t.loginAs('mgr');
    const sale = await discountedSale();
    const lineId = first(sale.lines).id;
    const r1 = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId, quantity: 2 }],
      refund: [{ method: 'cash', amount: 2 * CHARGER_PRICE - 67 }],
      reason: 'two',
    });
    expect(first(r1.lines).discountAmount).toBe(-67);
    const r2 = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId, quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE - 33 }],
      reason: 'one',
    });
    expect(first(r2.lines).discountAmount).toBe(-33);
  });

  it('an invoice-level discount is handed back in full across partial returns', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(
      t,
      [
        { variantId: t.ids.chargerId, quantity: 2 },
        { phoneUnitId: t.ids.phoneId, quantity: 1 },
      ],
      { invoiceDiscount: 100_001 },
    );
    expect(sale.discountTotal).toBe(100_001);
    const [chargerLine, phoneLine] = sale.lines;
    const r1 = await t.svc.checkout.previewReturn(sale.id, [
      { lineId: first(sale.lines).id, quantity: 2 },
    ]);
    const ret1 = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: chargerLine!.id, quantity: 2 }],
      refund: r1.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
      reason: 'chargers',
    });
    const r2 = await t.svc.checkout.previewReturn(sale.id, [
      { lineId: phoneLine!.id, quantity: 1 },
    ]);
    const ret2 = await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: phoneLine!.id, quantity: 1 }],
      refund: r2.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
      reason: 'phone',
    });
    expect(ret1.discountTotal + ret2.discountTotal).toBe(-100_001);
    expect(ret1.total + ret2.total).toBe(negPaisa(sale.total));
  });
});
