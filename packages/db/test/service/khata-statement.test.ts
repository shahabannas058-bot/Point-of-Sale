import { beforeEach, describe, expect, it } from 'vitest';
import { BASE_MS } from '../../../core/test/fixtures';
import { CHARGER_PRICE, expectCode, makeService, type TestService } from './helpers';

const DAY = 86_400_000;
let t: TestService;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('cash');
});

async function bilalOwes(amount: number): Promise<void> {
  await t.svc.checkout.commit({
    lines: [{ variantId: t.ids.chargerId, quantity: amount / CHARGER_PRICE }],
    customerId: t.ids.bilalId,
    payments: [{ method: 'khata', amount }],
  });
}
const pay = (amount: number): Promise<number> =>
  t.svc.khata.receivePayment({ customerId: t.ids.bilalId, amount, method: 'cash' });

describe('khata.statement', () => {
  it('needs a session and an existing customer, and validates the range', async () => {
    const range = { fromMs: BASE_MS, toMs: BASE_MS + DAY };
    t.svc.auth.logout();
    await expectCode(t.svc.khata.statement(t.ids.bilalId, range), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    await expectCode(t.svc.khata.statement(t.newId(), range), 'NOT_FOUND');
    await expectCode(
      t.svc.khata.statement(t.ids.bilalId, { fromMs: BASE_MS + DAY, toMs: BASE_MS }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.khata.statement(t.ids.bilalId, { fromMs: 1.5, toMs: BASE_MS }),
      'VALIDATION',
    );
  });

  it('an empty period carries the balance through unchanged', async () => {
    await bilalOwes(300_000); // at BASE_MS-ish
    const from = t.clock.peek() + DAY;
    const s = await t.svc.khata.statement(t.ids.bilalId, { fromMs: from, toMs: from + 30 * DAY });
    expect(s.customer.name).toBe('Bilal');
    expect(s).toMatchObject({ opening: 300_000, udhaarGiven: 0, paid: 0, closing: 300_000 });
    expect(s.lines).toEqual([]);
    expect(s.range).toEqual({ fromMs: from, toMs: from + 30 * DAY });
  });

  it('splits entries into before / inside / after the period and runs the balance from the opening', async () => {
    await bilalOwes(300_000); // before
    await pay(100_000); // before -> opening 200,000
    t.clock.advance(DAY);
    const from = t.clock.peek();
    await bilalOwes(150_000); // inside, sale A-000002
    await pay(50_000); // inside
    const to = t.clock.peek() + 1;
    t.clock.advance(DAY);
    await bilalOwes(150_000); // after

    const s = await t.svc.khata.statement(t.ids.bilalId, { fromMs: from, toMs: to });
    expect(s).toMatchObject({
      opening: 200_000,
      udhaarGiven: 150_000,
      paid: 50_000,
      closing: 300_000,
    });
    expect(
      s.lines.map((l) => [l.entry.type, l.entry.amount, l.runningBalance, l.invoiceNo]),
    ).toEqual([
      ['sale_credit', 150_000, 350_000, 'A-000002'],
      ['payment_received', -50_000, 300_000, null],
    ]);
    // closing is the live balance only when the period runs to now
    expect((await t.svc.khata.getLedger(t.ids.bilalId)).balance).toBe(450_000);
  });

  it('a return credited to udhaar counts as paid; an opening balance counts as udhaar given', async () => {
    const c = await t.svc.khata.createCustomer({ name: 'Old Debtor', openingBalance: 80_000 });
    const inv = await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      customerId: c.id,
      payments: [{ method: 'khata', amount: CHARGER_PRICE }],
    });
    await t.loginAs('owner');
    await t.svc.checkout.createReturn({
      originalSaleId: inv.id,
      lines: [{ lineId: inv.lines[0]?.id ?? '', quantity: 1 }],
      refund: [{ method: 'khata', amount: CHARGER_PRICE }],
      reason: 'Wrong item',
    });
    const s = await t.svc.khata.statement(c.id, { fromMs: BASE_MS, toMs: t.clock.peek() });
    expect(s).toMatchObject({
      opening: 0,
      udhaarGiven: 80_000 + CHARGER_PRICE,
      paid: CHARGER_PRICE,
      closing: 80_000,
    });
    expect(s.lines.map((l) => l.entry.type)).toEqual([
      'opening_balance',
      'sale_credit',
      'return_credit',
    ]);
  });
});

describe('khata.pendingUdhaar', () => {
  it('needs a session', async () => {
    t.svc.auth.logout();
    await expectCode(t.svc.khata.pendingUdhaar(), 'NOT_AUTHENTICATED');
  });

  it('lists only customers who owe, biggest first, with last udhaar and last payment dates', async () => {
    await bilalOwes(150_000);
    const firstSaleAt = t.clock.peek() - 1000;
    await pay(150_000); // Bilal is square now
    const big = await t.svc.khata.createCustomer({ name: 'Big', openingBalance: 500_000 });
    const bigOpenedAt = t.clock.peek() - 1000;
    const small = await t.svc.khata.createCustomer({ name: 'Small', openingBalance: 20_000 });
    await t.svc.khata.receivePayment({ customerId: small.id, amount: 5_000, method: 'cash' });
    const smallPaidAt = t.clock.peek() - 1000;
    await t.svc.khata.createCustomer({ name: 'Square' });

    const rows = await t.svc.khata.pendingUdhaar();
    expect(rows.map((r) => [r.party.name, r.balance, r.lastCreditAt, r.lastPaymentAt])).toEqual([
      ['Big', 500_000, bigOpenedAt, null],
      ['Small', 15_000, bigOpenedAt + 1000, smallPaidAt],
    ]);
    expect(rows.some((r) => r.party.id === big.id)).toBe(true);
    expect(firstSaleAt).toBeLessThan(bigOpenedAt);
  });

  it('a customer with an advance (negative balance) is not pending', async () => {
    await bilalOwes(150_000);
    await pay(150_000);
    expect(await t.svc.khata.pendingUdhaar()).toEqual([]);
  });
});
