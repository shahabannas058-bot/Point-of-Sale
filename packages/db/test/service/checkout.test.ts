import { beforeEach, describe, expect, it } from 'vitest';
import { GENESIS_HASH, InvoiceSchema, ServiceError } from '@pos/shared';
import { mapError } from '../../src/service';
import { saleRow } from '../helpers';
import {
  CHARGER_PRICE,
  PHONE_PRICE,
  captureError,
  expectCode,
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

describe('hash chain over three sales (spec 1)', () => {
  it('numbers invoices 1..3, links prev_hash and verifies; tampering is found at seq 1', async () => {
    await t.loginAs('owner');
    const s1 = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      payments: [{ method: 'cash', amount: 300_000 }],
    });
    const s2 = await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 500_000 }],
      payments: [{ method: 'cash', amount: 8_000_000 }],
    });
    const s3 = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      payments: [{ method: 'cash', amount: 150_000 }],
    });

    expect([s1.seq, s2.seq, s3.seq]).toEqual([1, 2, 3]);
    expect([s1.invoiceNo, s2.invoiceNo, s3.invoiceNo]).toEqual([
      'A-000001',
      'A-000002',
      'A-000003',
    ]);
    expect(s1.prevHash).toBe(GENESIS_HASH);
    expect(s2.prevHash).toBe(s1.hash);
    expect(s3.prevHash).toBe(s2.hash);
    expect(s2.total).toBe(8_000_000);
    expect(InvoiceSchema.safeParse(s3).success).toBe(true);

    const report = await t.svc.integrity.verifyChain();
    expect(report).toMatchObject({ ok: true, count: 3, headSeq: 3, headHash: s3.hash });

    await t.driver.exec('DROP TRIGGER trg_sales_no_update');
    await t.driver.exec('UPDATE sales SET created_at = created_at - 1 WHERE seq = 1');
    const broken = await t.svc.integrity.verifyChain();
    expect(broken.ok).toBe(false);
    if (!broken.ok) {
      expect(broken.seq).toBe(1);
      expect(broken.invoiceNo).toBe('A-000001');
    }
  });

  it('sales are never backdated even if the clock steps back', async () => {
    await t.loginAs('owner');
    const a = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    t.clock.advance(-3_600_000);
    const b = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    expect(b.createdAt).toBeGreaterThanOrEqual(a.createdAt);
    expect((await t.svc.integrity.verifyChain()).ok).toBe(true);
  });
});

describe('concurrent commits (spec 2)', () => {
  it('five parallel commits get seq exactly 1..5 and the chain verifies', async () => {
    await t.loginAs('owner');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.svc.checkout.commit({
          lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
          payments: [{ method: 'cash', amount: CHARGER_PRICE }],
        }),
      ),
    );
    expect(results.map((i) => i.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(results.map((i) => i.invoiceNo)).size).toBe(5);
    const report = await t.svc.integrity.verifyChain();
    expect(report).toMatchObject({ ok: true, count: 5, headSeq: 5 });
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(5);
  });

  it('two parallel sales of 6 chargers (10 on hand) let exactly one through', async () => {
    await t.loginAs('owner');
    const attempt = (): Promise<unknown> =>
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 6 }],
        payments: [{ method: 'cash', amount: 6 * CHARGER_PRICE }],
      });
    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected');
    expect(rejected?.status === 'rejected' && (rejected.reason as ServiceError).code).toBe(
      'STOCK_INSUFFICIENT',
    );
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(4);
  });

  it('a raw insert with a duplicate seq is rejected by the DB and maps to CHAIN_CONFLICT', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }]);
    const dup = saleRow({
      device_id: t.ids.deviceId,
      branch_id: t.ids.branchId,
      cashier_id: t.ids.ownerId,
      customer_id: null,
      seq: 1,
    });
    const cols = Object.keys(dup);
    const raw = t.driver.batch([
      {
        sql: `insert into sales (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`,
        params: cols.map((c) => dup[c] ?? null),
      },
    ]);
    const err = await raw.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(mapError(err).code).toBe('CHAIN_CONFLICT');
  });
});

describe('insufficient stock (spec 3)', () => {
  it('11 chargers throws STOCK_INSUFFICIENT {onHand:10, requested:11} and writes nothing', async () => {
    await t.loginAs('owner');
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 11 }],
        payments: [{ method: 'cash', amount: 11 * CHARGER_PRICE }],
      }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 10, requested: 11 });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('two lines of the same variant (6 + 5) are summed and fail too', async () => {
    await t.loginAs('owner');
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.checkout.commit({
        lines: [
          { variantId: t.ids.chargerId, quantity: 6 },
          { variantId: t.ids.chargerId, quantity: 5 },
        ],
        payments: [{ method: 'cash', amount: 11 * CHARGER_PRICE }],
      }),
      'STOCK_INSUFFICIENT',
    );
    expect(e.details).toMatchObject({ onHand: 10, requested: 11, lineNo: 2 });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('exactly the on-hand quantity is allowed', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 10 }]);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(0);
  });

  it('allowNegativeStock lets accessories oversell', async () => {
    await t.loginAs('owner');
    await t.svc.settings.update({ allowNegativeStock: true });
    await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 12 }]);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(-2);
  });
});

describe('the same phone cannot be sold twice (spec 4)', () => {
  it('a cart with phone X on two lines throws UNIT_NOT_IN_STOCK and rolls back', async () => {
    await t.loginAs('owner');
    const before = await snapshotCounts(t.driver);
    await expectCode(
      t.svc.checkout.commit({
        lines: [
          { phoneUnitId: t.ids.phoneId, quantity: 1 },
          { phoneUnitId: t.ids.phoneId, quantity: 1 },
        ],
        payments: [{ method: 'cash', amount: 2 * PHONE_PRICE }],
      }),
      'UNIT_NOT_IN_STOCK',
    );
    expect(await snapshotCounts(t.driver)).toEqual(before);
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(1);
  });

  it('after X is sold a second commit throws UNIT_NOT_IN_STOCK and counts stay unchanged', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ phoneUnitId: t.ids.phoneId, quantity: 1 }]);
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(0);
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.checkout.commit({
        lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
        payments: [{ method: 'cash', amount: PHONE_PRICE }],
      }),
      'UNIT_NOT_IN_STOCK',
    );
    expect(e.details).toMatchObject({ phoneUnitId: t.ids.phoneId });
    expect(await snapshotCounts(t.driver)).toEqual(before);
    expect(await stockSum(t.driver, { phoneUnitId: t.ids.phoneId })).toBe(0);
  });

  it('a phone line with quantity 2 is a VALIDATION error', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.preview({ lines: [{ phoneUnitId: t.ids.phoneId, quantity: 2 }] }),
      'VALIDATION',
    );
  });

  it('a line with both or neither of phoneUnitId/variantId is a VALIDATION error', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ phoneUnitId: t.ids.phoneId, variantId: t.ids.chargerId, quantity: 1 }],
      }),
      'VALIDATION',
    );
    await expectCode(t.svc.checkout.preview({ lines: [{ quantity: 1 }] }), 'VALIDATION');
  });
});

describe('khata on a sale (spec 5)', () => {
  it('khata without a customer throws KHATA_NEEDS_CUSTOMER', async () => {
    await t.loginAs('cash');
    const before = await snapshotCounts(t.driver);
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'khata', amount: CHARGER_PRICE }],
      }),
      'KHATA_NEEDS_CUSTOMER',
    );
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('a full khata sale books sale_credit +150 000 and the customer balance', async () => {
    await t.loginAs('cash');
    const inv = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount: CHARGER_PRICE }],
    });
    const ledger = await t.driver.query<{ type: string; amount: number; sale_id: string }>(
      'select type, amount, sale_id from ledger_entries where customer_id = ?',
      [t.ids.bilalId],
    );
    expect(ledger).toEqual([{ type: 'sale_credit', amount: 150_000, sale_id: inv.id }]);
    const customers = await t.svc.khata.listCustomers();
    expect(customers.find((c) => c.party.id === t.ids.bilalId)?.balance).toBe(150_000);
  });

  it('a split sale (cash 100 000 + khata 200 000) books only +200 000', async () => {
    await t.loginAs('cash');
    await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      customerId: t.ids.bilalId,
      payments: [
        { method: 'cash', amount: 100_000 },
        { method: 'khata', amount: 200_000 },
      ],
    });
    const ledger = await t.driver.query<{ type: string; amount: number }>(
      'select type, amount from ledger_entries where customer_id = ?',
      [t.ids.bilalId],
    );
    expect(ledger).toEqual([{ type: 'sale_credit', amount: 200_000 }]);
  });

  it('a cashier pushing the balance over the credit limit needs approval (credit_limit)', async () => {
    await t.loginAs('cash');
    const draft = {
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata' as const, amount: PHONE_PRICE }],
    };
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(t.svc.checkout.commit(draft), 'APPROVAL_REQUIRED');
    expect(e.details).toMatchObject({ reason: 'credit_limit' });
    expect(await snapshotCounts(t.driver)).toEqual(before);

    const grant = await t.svc.auth.requestApproval('2345');
    const inv = await t.svc.checkout.commit({ ...draft, approvalToken: grant.token });
    expect(inv.note).toBe('approved:mgr');
  });

  it('a manager is not subject to the credit limit', async () => {
    await t.loginAs('mgr');
    const inv = await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount: PHONE_PRICE }],
    });
    expect(inv.payments[0]?.method).toBe('khata');
  });
});

describe('cashier discount policy (spec 6)', () => {
  it('425 000 on gross 8 500 000 (500 bps) passes; 425 001 needs approval', async () => {
    await t.loginAs('cash');
    const exact = {
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 425_000 }],
    };
    const exactPreview = await t.svc.checkout.preview(exact);
    expect(exactPreview.needsApproval).toEqual([]);
    expect(exactPreview.effectiveDiscountBps).toBe(500);

    const over = {
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 425_001 }],
    };
    const overPreview = await t.svc.checkout.preview(over);
    expect(overPreview.needsApproval).toEqual(['discount']);
    expect(overPreview.effectiveDiscountBps).toBe(500); // floor(500.0001)

    const e = await expectCode(
      t.svc.checkout.commit({
        ...over,
        payments: [{ method: 'cash', amount: overPreview.total }],
      }),
      'APPROVAL_REQUIRED',
    );
    expect(e.details).toMatchObject({ reason: 'discount' });

    const inv = await t.svc.checkout.commit({
      ...exact,
      payments: [{ method: 'cash', amount: exactPreview.total }],
    });
    expect(inv.total).toBe(8_075_000);
    expect(inv.note).toBeNull();
  });

  it('an invoice-level discount counts toward the threshold too', async () => {
    await t.loginAs('cash');
    const ok = await t.svc.checkout.preview({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      invoiceDiscount: 425_000,
    });
    expect(ok.needsApproval).toEqual([]);
    const over = await t.svc.checkout.preview({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1 }],
      invoiceDiscount: 425_001,
    });
    expect(over.needsApproval).toEqual(['discount']);
  });

  it('a manager grant lets it pass, the note ends with approved:mgr, and the token is single use', async () => {
    await t.loginAs('cash');
    const grant = await t.svc.auth.requestApproval('2345');
    expect(grant.approverUsername).toBe('mgr');
    const inv = await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 425_001 }],
      payments: [{ method: 'cash', amount: PHONE_PRICE - 425_001 }],
      approvalToken: grant.token,
    });
    expect(inv.note?.endsWith('approved:mgr')).toBe(true);

    // reuse: 7 501 off one 150 000 charger is above 5 %
    const e = await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1, discountAmount: 7_501 }],
        payments: [{ method: 'cash', amount: CHARGER_PRICE - 7_501 }],
        approvalToken: grant.token,
      }),
      'APPROVAL_REQUIRED',
    );
    expect(e.details).toMatchObject({ reason: 'discount' });
  });

  it('the token is not consumed when the commit fails (licence hook rejects once)', async () => {
    await t.loginAs('cash');
    const grant = await t.svc.auth.requestApproval('2345');
    const input = {
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 500_000 }],
      payments: [{ method: 'cash' as const, amount: PHONE_PRICE - 500_000 }],
      approvalToken: grant.token,
    };
    t.assertCanSell.mockRejectedValueOnce(
      new ServiceError('LICENCE_BLOCKED', 'locked', { state: 'LOCKED' }),
    );
    await expectCode(t.svc.checkout.commit(input), 'LICENCE_BLOCKED');
    const inv = await t.svc.checkout.commit(input);
    expect(inv.total).toBe(PHONE_PRICE - 500_000);
  });

  it('a manager session needs no token', async () => {
    await t.loginAs('mgr');
    const inv = await t.svc.checkout.commit({
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 2_000_000 }],
      payments: [{ method: 'cash', amount: PHONE_PRICE - 2_000_000 }],
    });
    expect(inv.note).toBeNull();
  });

  it('a cashier PIN passed to requestApproval gives APPROVAL_INVALID', async () => {
    await t.loginAs('cash');
    await expectCode(t.svc.auth.requestApproval('3456'), 'APPROVAL_INVALID');
    await expectCode(t.svc.auth.requestApproval('0000'), 'APPROVAL_INVALID');
  });

  it('an unknown, expired or logged-out token behaves as "no token" (APPROVAL_REQUIRED)', async () => {
    await t.loginAs('cash');
    const input = {
      lines: [{ phoneUnitId: t.ids.phoneId, quantity: 1, discountAmount: 500_000 }],
      payments: [{ method: 'cash' as const, amount: PHONE_PRICE - 500_000 }],
    };
    await expectCode(
      t.svc.checkout.commit({ ...input, approvalToken: 'deadbeef' }),
      'APPROVAL_REQUIRED',
    );

    const expired = await t.svc.auth.requestApproval('2345');
    t.clock.advance(61_000);
    await expectCode(
      t.svc.checkout.commit({ ...input, approvalToken: expired.token }),
      'APPROVAL_REQUIRED',
    );

    const stale = await t.svc.auth.requestApproval('2345');
    t.svc.auth.logout();
    await t.loginAs('cash');
    await expectCode(
      t.svc.checkout.commit({ ...input, approvalToken: stale.token }),
      'APPROVAL_REQUIRED',
    );
  });

  it('the cashier threshold follows the setting', async () => {
    await t.loginAs('owner');
    await t.svc.settings.update({ cashierMaxDiscountBps: 0 });
    t.svc.auth.logout();
    await t.loginAs('cash');
    const p = await t.svc.checkout.preview({
      lines: [{ variantId: t.ids.chargerId, quantity: 1, discountAmount: 1 }],
    });
    expect(p.needsApproval).toEqual(['discount']);
  });
});

describe('idempotency (spec 11)', () => {
  it('committing twice with the same saleId returns the same invoice and deducts stock once', async () => {
    await t.loginAs('owner');
    const saleId = t.newId();
    const draft = {
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      payments: [{ method: 'cash' as const, amount: 300_000 }],
      saleId,
    };
    const a = await t.svc.checkout.commit(draft);
    const b = await t.svc.checkout.commit(draft);
    expect(b).toEqual(a);
    expect(a.id).toBe(saleId);
    const counts = await snapshotCounts(t.driver);
    expect(counts.sales).toBe(1);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(8);
    expect(t.assertCanSell).toHaveBeenCalledTimes(1);
  });

  it('reusing a saleId with a changed cart is refused with SALE_ID_REUSED and writes nothing', async () => {
    await t.loginAs('owner');
    const saleId = t.newId();
    const first = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      payments: [{ method: 'cash', amount: 300_000 }],
      saleId,
    });
    const before = await snapshotCounts(t.driver);
    const err = await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 150_000 }],
        saleId,
      }),
      'SALE_ID_REUSED',
    );
    expect(err.details.invoiceNo).toBe(first.invoiceNo);
    // same lines and payments but a different customer is a different sale too
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
        payments: [{ method: 'cash', amount: 300_000 }],
        customerId: t.ids.bilalId,
        saleId,
      }),
      'SALE_ID_REUSED',
    );
    expect(await snapshotCounts(t.driver)).toEqual(before);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(8);
  });

  it('a double click (two parallel commits with one saleId) creates one invoice', async () => {
    await t.loginAs('owner');
    const saleId = t.newId();
    const draft = {
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      payments: [{ method: 'cash' as const, amount: CHARGER_PRICE }],
      saleId,
    };
    const [a, b] = await Promise.all([t.svc.checkout.commit(draft), t.svc.checkout.commit(draft)]);
    expect(a.id).toBe(b.id);
    expect(a.hash).toBe(b.hash);
    expect((await snapshotCounts(t.driver)).sales).toBe(1);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(9);
  });

  it('a saleId that is not a UUID v7 is rejected', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'cash', amount: CHARGER_PRICE }],
        saleId: 'not-a-uuid',
      }),
      'VALIDATION',
    );
  });
});

describe('licence hook (spec 13)', () => {
  const draft = () => ({
    lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
    payments: [{ method: 'cash' as const, amount: CHARGER_PRICE }],
  });

  it('LICENCE_BLOCKED stops the commit with its state and nothing is written', async () => {
    await t.loginAs('owner');
    t.assertCanSell.mockRejectedValue(
      new ServiceError('LICENCE_BLOCKED', 'Subscription expired', { state: 'LOCKED' }),
    );
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(t.svc.checkout.commit(draft()), 'LICENCE_BLOCKED');
    expect(e.details).toEqual({ state: 'LOCKED' });
    expect(t.assertCanSell).toHaveBeenCalledTimes(1);
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('a plain Error from the hook maps to INTERNAL and nothing is written', async () => {
    await t.loginAs('owner');
    t.assertCanSell.mockRejectedValue(new Error('licence store unreachable'));
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(t.svc.checkout.commit(draft()), 'INTERNAL');
    expect(e.message).toContain('licence store unreachable');
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('is called once per commit, after validation, with the sale action', async () => {
    await t.loginAs('owner');
    await expectCode(t.svc.checkout.commit({ lines: [], payments: [] }), 'EMPTY_CART');
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 1 }],
      }),
      'PAYMENT_MISMATCH',
    );
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 99 }],
        payments: [{ method: 'cash', amount: 1 }],
      }),
      'STOCK_INSUFFICIENT',
    );
    expect(t.assertCanSell).not.toHaveBeenCalled();

    const inv = await t.svc.checkout.commit(draft());
    expect(t.assertCanSell).toHaveBeenCalledTimes(1);
    expect(t.assertCanSell).toHaveBeenCalledWith({
      action: 'sale',
      branchId: t.ids.branchId,
      now: inv.createdAt,
    });
  });

  it('preview does not consult the hook', async () => {
    await t.loginAs('owner');
    await t.svc.checkout.preview(draft());
    expect(t.assertCanSell).not.toHaveBeenCalled();
  });
});

describe('validation (spec 14)', () => {
  it('a discount greater than gross gives DISCOUNT_INVALID', async () => {
    await t.loginAs('owner');
    const over = captureError(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1, discountAmount: CHARGER_PRICE + 1 }],
      }),
    );
    expect((await over).code).toBe('DISCOUNT_INVALID');
  });

  it('a negative discount gives DISCOUNT_INVALID', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1, discountAmount: -1 }],
      }),
      'DISCOUNT_INVALID',
    );
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        invoiceDiscount: -5,
      }),
      'DISCOUNT_INVALID',
    );
  });

  it('an invoice discount greater than the subtotal gives DISCOUNT_INVALID', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        invoiceDiscount: CHARGER_PRICE + 1,
      }),
      'DISCOUNT_INVALID',
    );
  });

  it('payments that do not sum to the total give PAYMENT_MISMATCH, over and under', async () => {
    await t.loginAs('owner');
    const lines = [{ variantId: t.ids.chargerId, quantity: 1 }];
    await expectCode(
      t.svc.checkout.commit({ lines, payments: [{ method: 'cash', amount: CHARGER_PRICE - 1 }] }),
      'PAYMENT_MISMATCH',
    );
    await expectCode(
      t.svc.checkout.commit({ lines, payments: [{ method: 'cash', amount: CHARGER_PRICE + 1 }] }),
      'PAYMENT_MISMATCH',
    );
    await expectCode(t.svc.checkout.commit({ lines, payments: [] }), 'PAYMENT_MISMATCH');
  });

  it('fractional paisa is MONEY_INVALID', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'cash', amount: 10.5 }],
      }),
      'MONEY_INVALID',
    );
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1, discountAmount: 10.5 }],
      }),
      'MONEY_INVALID',
    );
  });

  it('an empty cart gives EMPTY_CART; unknown product ids give NOT_FOUND', async () => {
    await t.loginAs('owner');
    await expectCode(t.svc.checkout.preview({ lines: [] }), 'EMPTY_CART');
    await expectCode(
      t.svc.checkout.preview({ lines: [{ variantId: t.newId(), quantity: 1 }] }),
      'NOT_FOUND',
    );
    await expectCode(
      t.svc.checkout.preview({ lines: [{ phoneUnitId: t.newId(), quantity: 1 }] }),
      'NOT_FOUND',
    );
    await expectCode(
      t.svc.checkout.preview({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        customerId: t.newId(),
      }),
      'NOT_FOUND',
    );
  });

  it('an unknown payment method is a VALIDATION error', async () => {
    await t.loginAs('owner');
    await expectCode(
      t.svc.checkout.commit({
        lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
        payments: [{ method: 'bitcoin' as never, amount: CHARGER_PRICE }],
      }),
      'VALIDATION',
    );
  });
});

describe('access rules', () => {
  it('commit, preview, getInvoice and listInvoices need a session', async () => {
    const lines = [{ variantId: t.ids.chargerId, quantity: 1 }];
    await expectCode(t.svc.checkout.preview({ lines }), 'NOT_AUTHENTICATED');
    await expectCode(
      t.svc.checkout.commit({ lines, payments: [{ method: 'cash', amount: CHARGER_PRICE }] }),
      'NOT_AUTHENTICATED',
    );
    await expectCode(t.svc.checkout.getInvoice('A-000001'), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.checkout.listInvoices(), 'NOT_AUTHENTICATED');
  });

  it('a cashier can sell, look up invoices by id and number, and list them', async () => {
    await t.loginAs('cash');
    const inv = await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }], {
      customerId: t.ids.bilalId,
    });
    const byId = await t.svc.checkout.getInvoice(inv.id);
    const byNo = await t.svc.checkout.getInvoice(inv.invoiceNo);
    expect(byId.invoice.id).toBe(inv.id);
    expect(byNo.invoice.id).toBe(inv.id);
    expect(byId).toMatchObject({
      customerName: 'Bilal',
      cashierName: 'Cashier',
      originalInvoiceNo: null,
    });
    const list = await t.svc.checkout.listInvoices({ q: 'A-0000' });
    expect(list.map((s) => s.invoiceNo)).toEqual(['A-000001']);
    expect(list[0]).toMatchObject({ kind: 'sale', returnedTotal: 0, total: CHARGER_PRICE });
    await expectCode(t.svc.checkout.getInvoice('A-999999'), 'NOT_FOUND');
  });

  it('listInvoices finds a sale by IMEI and filters by kind and customer', async () => {
    await t.loginAs('owner');
    await sellCash(t, [{ phoneUnitId: t.ids.phoneId, quantity: 1 }]);
    await sellCash(t, [{ variantId: t.ids.chargerId, quantity: 1 }], { customerId: t.ids.bilalId });
    expect(
      (await t.svc.checkout.listInvoices({ q: '356938035643809' })).map((s) => s.invoiceNo),
    ).toEqual(['A-000001']);
    expect(
      (await t.svc.checkout.listInvoices({ customerId: t.ids.bilalId })).map((s) => s.invoiceNo),
    ).toEqual(['A-000002']);
    expect(await t.svc.checkout.listInvoices({ kind: 'return' })).toEqual([]);
  });
});
