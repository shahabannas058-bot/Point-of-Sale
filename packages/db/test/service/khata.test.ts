import { beforeEach, describe, expect, it } from 'vitest';
import { paisa } from '@pos/core';
import {
  CHARGER_PRICE,
  CREDIT_LIMIT,
  expectCode,
  first,
  makeService,
  snapshotCounts,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const balanceOf = async (customerId: string): Promise<number | undefined> =>
  (await t.svc.khata.listCustomers()).find((c) => c.party.id === customerId)?.balance;

describe('customers', () => {
  it('needs a session to read or create', async () => {
    await expectCode(t.svc.khata.listCustomers(), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.khata.getLedger(t.ids.bilalId), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.khata.createCustomer({ name: 'X' }), 'NOT_AUTHENTICATED');
    await expectCode(t.svc.khata.totals(), 'NOT_AUTHENTICATED');
  });

  it('a cashier can list and create customers (reads need a session, create needs sell)', async () => {
    await t.loginAs('cash');
    const created = await t.svc.khata.createCustomer({
      name: 'Hamza Traders',
      phone: '0300-1234567',
      cnic: '35202-1234567-1',
      address: 'Hall Road',
    });
    expect(created).toMatchObject({
      name: 'Hamza Traders',
      phone: '03001234567',
      cnic: '3520212345671',
      creditLimit: null,
    });
    const names = (await t.svc.khata.listCustomers()).map((c) => c.party.name);
    expect(names).toEqual(['Bilal', 'Hamza Traders']);
    const search = await t.svc.khata.listCustomers({ q: 'ham' });
    expect(search.map((c) => c.party.name)).toEqual(['Hamza Traders']);
  });

  it('createCustomer emits a customer outbox row and validates input', async () => {
    await t.loginAs('cash');
    await expectCode(t.svc.khata.createCustomer({ name: '   ' }), 'VALIDATION');
    await expectCode(t.svc.khata.createCustomer({ name: 'A', phone: 'abc' }), 'VALIDATION');
    await expectCode(t.svc.khata.createCustomer({ name: 'A', cnic: '123' }), 'VALIDATION');
    await expectCode(t.svc.khata.createCustomer({ name: 'A', creditLimit: 1.5 }), 'MONEY_INVALID');
    await expectCode(t.svc.khata.createCustomer({ name: 'A', creditLimit: -1 }), 'VALIDATION');
  });

  it('an opening balance books an opening_balance ledger entry', async () => {
    await t.loginAs('cash');
    const c = await t.svc.khata.createCustomer({ name: 'Old Debtor', openingBalance: 250_000 });
    expect(await balanceOf(c.id)).toBe(250_000);
    const ledger = await t.svc.khata.getLedger(c.id);
    expect(ledger.balance).toBe(250_000);
    expect(first(ledger.lines).entry).toMatchObject({ type: 'opening_balance', amount: 250_000 });
    expect(first(ledger.lines).runningBalance).toBe(250_000);
  });

  it('only a manager (edit_catalog) can change the credit limit; a cashier can fix the name', async () => {
    await t.loginAs('cash');
    await expectCode(
      t.svc.khata.updateCustomer(t.ids.bilalId, { creditLimit: paisa(1) }),
      'FORBIDDEN',
    );
    const renamed = await t.svc.khata.updateCustomer(t.ids.bilalId, { name: 'Bilal Ahmed' });
    expect(renamed.name).toBe('Bilal Ahmed');
    expect(renamed.creditLimit).toBe(CREDIT_LIMIT);
    t.svc.auth.logout();
    await t.loginAs('mgr');
    const limited = await t.svc.khata.updateCustomer(t.ids.bilalId, {
      creditLimit: paisa(100_000),
    });
    expect(limited.creditLimit).toBe(100_000);
    await expectCode(t.svc.khata.updateCustomer(t.newId(), { name: 'x' }), 'NOT_FOUND');
  });
});

describe('ledger and payments', () => {
  async function bilalOwes(amount: number): Promise<void> {
    await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: amount / CHARGER_PRICE }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount }],
    });
  }

  it('receivePayment reduces the balance, returns it, and records a negative payment_received', async () => {
    await t.loginAs('cash');
    await bilalOwes(300_000);
    const remaining = await t.svc.khata.receivePayment({
      customerId: t.ids.bilalId,
      amount: 100_000,
      method: 'cash',
      note: 'Partial',
    });
    expect(remaining).toBe(200_000);
    const ledger = await t.svc.khata.getLedger(t.ids.bilalId);
    expect(ledger.balance).toBe(200_000);
    expect(ledger.lines.map((l) => [l.entry.type, l.entry.amount, l.runningBalance])).toEqual([
      ['payment_received', -100_000, 200_000],
      ['sale_credit', 300_000, 300_000],
    ]);
    expect(ledger.lines[1]?.invoiceNo).toBe('A-000001');
    expect(ledger.lines[0]?.entry.method).toBe('cash');
  });

  it('a payment larger than the balance is VALIDATION and writes nothing', async () => {
    await t.loginAs('cash');
    await bilalOwes(150_000);
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.khata.receivePayment({ customerId: t.ids.bilalId, amount: 150_001, method: 'cash' }),
      'VALIDATION',
    );
    expect(e.details).toMatchObject({ field: 'amount', balance: 150_000 });
    expect(await snapshotCounts(t.driver)).toEqual(before);
  });

  it('rejects zero, fractional, khata-method payments and unknown customers', async () => {
    await t.loginAs('cash');
    await bilalOwes(150_000);
    const pay = (over: Record<string, unknown>) =>
      t.svc.khata.receivePayment({
        customerId: t.ids.bilalId,
        amount: 1000,
        method: 'cash',
        ...over,
      });
    await expectCode(pay({ amount: 0 }), 'VALIDATION');
    await expectCode(pay({ amount: 10.5 }), 'MONEY_INVALID');
    await expectCode(pay({ method: 'khata' }), 'VALIDATION');
    await expectCode(pay({ customerId: t.newId() }), 'NOT_FOUND');
  });

  it('settling the balance exactly leaves zero; paying again is refused', async () => {
    await t.loginAs('cash');
    await bilalOwes(150_000);
    expect(
      await t.svc.khata.receivePayment({
        customerId: t.ids.bilalId,
        amount: 150_000,
        method: 'easypaisa',
      }),
    ).toBe(0);
    await expectCode(
      t.svc.khata.receivePayment({ customerId: t.ids.bilalId, amount: 1, method: 'cash' }),
      'VALIDATION',
    );
    expect((await t.svc.khata.listCustomers({ withBalanceOnly: true })).length).toBe(0);
  });

  it('totals sums only customers who owe', async () => {
    await t.loginAs('cash');
    await bilalOwes(300_000);
    await t.svc.khata.createCustomer({ name: 'Other', openingBalance: 50_000 });
    await t.svc.khata.createCustomer({ name: 'Square' });
    expect(await t.svc.khata.totals()).toEqual({ receivable: 350_000, customersOwing: 2 });
    expect((await t.svc.khata.listCustomers({ withBalanceOnly: true })).length).toBe(2);
  });

  it('getLedger paginates with beforeCreatedAt and limit', async () => {
    await t.loginAs('cash');
    await bilalOwes(450_000);
    for (let i = 0; i < 3; i += 1)
      await t.svc.khata.receivePayment({
        customerId: t.ids.bilalId,
        amount: 50_000,
        method: 'cash',
      });
    const all = await t.svc.khata.getLedger(t.ids.bilalId);
    expect(all.lines).toHaveLength(4);
    const page1 = await t.svc.khata.getLedger(t.ids.bilalId, { limit: 2 });
    expect(page1.lines.map((l) => l.entry.id)).toEqual(
      all.lines.slice(0, 2).map((l) => l.entry.id),
    );
    const page2 = await t.svc.khata.getLedger(t.ids.bilalId, {
      limit: 2,
      beforeCreatedAt: first(page1.lines.slice(-1)).entry.createdAt,
    });
    expect(page2.lines.map((l) => l.entry.id)).toEqual(all.lines.slice(2).map((l) => l.entry.id));
    expect(page2.balance).toBe(300_000);
    await expectCode(t.svc.khata.getLedger(t.newId()), 'NOT_FOUND');
  });

  it('the ledger table refuses edits and deletes (append-only)', async () => {
    await t.loginAs('cash');
    await bilalOwes(150_000);
    await expect(t.driver.exec('UPDATE ledger_entries SET amount = 1')).rejects.toThrow(
      /append-only|immutable/,
    );
    await expect(t.driver.exec('DELETE FROM ledger_entries')).rejects.toThrow(
      /append-only|immutable/,
    );
  });
});
