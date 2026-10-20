import { beforeEach, describe, expect, it } from 'vitest';
import { CHARGER_PRICE, count, expectCode, makeService, type TestService } from './helpers';

const outboxCount = async (entityType: string): Promise<number> =>
  (
    await t.driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE entity_type = ?', [
      entityType,
    ])
  )[0]?.n ?? 0;

let t: TestService;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('cash');
});

const sellCash = (qty: number) =>
  t.svc.checkout.commit({
    lines: [{ variantId: t.ids.chargerId, quantity: qty }],
    payments: [{ method: 'cash', amount: qty * CHARGER_PRICE }],
  });

const ZERO = {
  opening: 0,
  cashSales: 0,
  cashRefunds: 0,
  udhaarCollected: 0,
  supplierPaid: 0,
  repairCash: 0,
  expenses: 0,
  cashIn: 0,
  cashOut: 0,
  expected: 0,
};

describe('cash.drawer', () => {
  it('needs a session; a fresh shop has an empty drawer from the beginning of time', async () => {
    t.svc.auth.logout();
    await expectCode(t.svc.cash.drawer(), 'NOT_AUTHENTICATED');
    await t.loginAs('cash');
    const d = await t.svc.cash.drawer();
    expect(d).toMatchObject({ ...ZERO, periodStart: 0, lastClose: null, entries: [] });
  });

  it('adds every cash movement since the last close and ignores non-cash money', async () => {
    await t.loginAs('mgr');
    const sale = await sellCash(3); // +4,500
    await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 1 }],
      payments: [{ method: 'jazzcash', amount: CHARGER_PRICE }],
    }); // not cash
    await t.svc.checkout.commit({
      lines: [{ variantId: t.ids.chargerId, quantity: 2 }],
      customerId: t.ids.bilalId,
      payments: [{ method: 'khata', amount: 2 * CHARGER_PRICE }],
    }); // udhaar, not cash
    await t.svc.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: sale.lines[0]?.id ?? '', quantity: 1 }],
      refund: [{ method: 'cash', amount: CHARGER_PRICE }],
      reason: 'Faulty',
    }); // -1,500
    await t.svc.khata.receivePayment({
      customerId: t.ids.bilalId,
      amount: 100_000,
      method: 'cash',
    }); // +1,000
    await t.svc.khata.receivePayment({
      customerId: t.ids.bilalId,
      amount: 50_000,
      method: 'easypaisa',
    }); // not cash
    const supplier = await t.svc.purchasing.createSupplier({ name: 'Metro' });
    await t.svc.purchasing.receive({
      supplierId: supplier.id,
      phones: [],
      accessories: [{ variantId: t.ids.chargerId, quantity: 10, unitCost: 90_000 }],
      paidNow: { method: 'cash', amount: 50_000 },
    }); // -500
    await t.svc.purchasing.paySupplier({
      supplierId: supplier.id,
      amount: 200_000,
      method: 'cash',
    }); // -2,000
    await t.svc.cash.addEntry({ type: 'expense', category: 'tea_food', amount: 30_000 }); // -300
    await t.svc.cash.addEntry({ type: 'cash_in', amount: 500_000, note: 'Float' }); // +5,000
    await t.svc.cash.addEntry({ type: 'cash_out', amount: 100_000, note: 'Bank' }); // -1,000

    const d = await t.svc.cash.drawer();
    expect(d).toMatchObject({
      opening: 0,
      cashSales: 450_000,
      cashRefunds: 150_000,
      udhaarCollected: 100_000,
      supplierPaid: 250_000,
      repairCash: 0,
      expenses: 30_000,
      cashIn: 500_000,
      cashOut: 100_000,
      expected: 450_000 - 150_000 + 100_000 - 250_000 - 30_000 + 500_000 - 100_000,
    });
    expect(d.entries.map((e) => [e.type, e.amount, e.createdByName])).toEqual([
      ['expense', 30_000, 'Manager'],
      ['cash_in', 500_000, 'Manager'],
      ['cash_out', 100_000, 'Manager'],
    ]);
  });
});

describe('cash.addEntry', () => {
  it('a cashier can record an expense; it lands in the outbox and calls the licence hook', async () => {
    const e = await t.svc.cash.addEntry({
      type: 'expense',
      category: 'transport',
      amount: 25_000,
      note: '  Rickshaw  ',
    });
    expect(e).toMatchObject({
      type: 'expense',
      category: 'transport',
      amount: 25_000,
      note: 'Rickshaw',
      reversesId: null,
      createdBy: t.ids.cashierId,
      branchId: t.ids.branchId,
    });
    expect(await outboxCount('cash_entry')).toBe(1);
    expect(t.assertCanSell).toHaveBeenCalledWith(expect.objectContaining({ action: 'cash' }));
  });

  it('validates type, category and amount', async () => {
    const add = t.svc.cash.addEntry.bind(t.svc.cash);
    await expectCode(add({ type: 'expense', amount: 10_000 }), 'VALIDATION'); // category required
    await expectCode(
      add({ type: 'cash_in', category: 'rent', amount: 10_000 }),
      'VALIDATION', // category only for expenses
    );
    await expectCode(add({ type: 'expense', category: 'rent', amount: 0 }), 'VALIDATION');
    await expectCode(add({ type: 'expense', category: 'rent', amount: -5 }), 'VALIDATION');
    await expectCode(add({ type: 'expense', category: 'rent', amount: 1.5 }), 'MONEY_INVALID');
    await expectCode(
      add({ type: 'refund' as 'expense', category: 'rent', amount: 100 }),
      'VALIDATION',
    );
    await expectCode(
      add({ type: 'expense', category: 'gold' as 'rent', amount: 100 }),
      'VALIDATION',
    );
    await expectCode(
      add({ type: 'expense', category: 'rent', amount: 100, note: 'x'.repeat(501) }),
      'VALIDATION',
    );
    expect(await count(t.driver, 'cash_entries')).toBe(0);
  });
});

describe('cash.reverseEntry', () => {
  it('needs return_void; cancels the entry with a negative twin and cannot be done twice', async () => {
    const e = await t.svc.cash.addEntry({ type: 'expense', category: 'rent', amount: 1_000_000 });
    await expectCode(t.svc.cash.reverseEntry({ entryId: e.id }), 'FORBIDDEN');
    await t.loginAs('mgr');
    const r = await t.svc.cash.reverseEntry({ entryId: e.id, reason: 'Wrong amount' });
    expect(r).toMatchObject({
      type: 'expense',
      category: 'rent',
      amount: -1_000_000,
      reversesId: e.id,
      note: 'Wrong amount',
    });
    const d = await t.svc.cash.drawer();
    expect(d.expenses).toBe(0);
    expect(d.entries.map((x) => [x.amount, x.reversed])).toEqual([
      [1_000_000, true],
      [-1_000_000, false],
    ]);
    await expectCode(t.svc.cash.reverseEntry({ entryId: e.id }), 'VALIDATION');
    await expectCode(t.svc.cash.reverseEntry({ entryId: r.id }), 'VALIDATION');
    await expectCode(t.svc.cash.reverseEntry({ entryId: t.newId() }), 'NOT_FOUND');
  });

  it('refuses an entry from a day that is already closed', async () => {
    await t.loginAs('mgr');
    const e = await t.svc.cash.addEntry({ type: 'cash_in', amount: 100_000 });
    await t.svc.cash.closeDay({ counted: 100_000, carriedForward: 100_000 });
    await expectCode(t.svc.cash.reverseEntry({ entryId: e.id }), 'VALIDATION');
  });
});

describe('cash.closeDay', () => {
  it('stores the snapshot, the count and the difference, and starts the next period from it', async () => {
    await sellCash(2); // +3,000
    await t.svc.cash.addEntry({ type: 'expense', category: 'tea_food', amount: 20_000 }); // -200
    const c = await t.svc.cash.closeDay({
      counted: 270_000,
      carriedForward: 50_000,
      note: 'Short 10',
    });
    expect(c).toMatchObject({
      periodStart: 0,
      opening: 0,
      cashSales: 300_000,
      expenses: 20_000,
      expected: 280_000,
      counted: 270_000,
      carriedForward: 50_000,
      difference: -10_000,
      note: 'Short 10',
      closedBy: t.ids.cashierId,
      closedByName: 'Cashier',
    });
    expect(await outboxCount('day_close')).toBe(1);

    // next period: opens with what was left in the drawer, nothing else yet
    const d = await t.svc.cash.drawer();
    expect(d).toMatchObject({
      ...ZERO,
      opening: 50_000,
      expected: 50_000,
      periodStart: c.closedAt,
    });
    expect(d.lastClose?.id).toBe(c.id);

    await sellCash(1);
    const c2 = await t.svc.cash.closeDay({ counted: 200_000, carriedForward: 0 });
    expect(c2).toMatchObject({
      periodStart: c.closedAt,
      opening: 50_000,
      cashSales: 150_000,
      expenses: 0,
      expected: 200_000,
      difference: 0,
    });
  });

  it('validates the count and what is left in the drawer', async () => {
    const close = t.svc.cash.closeDay.bind(t.svc.cash);
    await expectCode(close({ counted: -1, carriedForward: 0 }), 'VALIDATION');
    await expectCode(close({ counted: 100, carriedForward: 101 }), 'VALIDATION');
    await expectCode(close({ counted: 100, carriedForward: -1 }), 'VALIDATION');
    await expectCode(close({ counted: 1.5, carriedForward: 0 }), 'MONEY_INVALID');
    expect(await count(t.driver, 'day_closes')).toBe(0);
  });

  it('the database refuses a close that does not continue the previous one', async () => {
    await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    await expect(
      t.driver.exec(
        `INSERT INTO day_closes (id, branch_id, period_start, closed_at, opening, cash_sales, cash_refunds,
           udhaar_collected, supplier_paid, repair_cash, expenses, cash_in, cash_out, expected, counted,
           carried_forward, note, closed_by)
         VALUES ('${t.newId()}', '${t.ids.branchId}', 0, ${t.clock.now()}, 0,0,0,0,0,0,0,0,0,0,0,0, NULL,
           '${t.ids.ownerId}')`,
      ),
    ).rejects.toThrow(/previous close/);
  });
});

describe('cash: clock and repairs', () => {
  it('refuses to close when the PC clock is behind the last close', async () => {
    const c = await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    t.clock.advance(-10 * 60_000);
    await expectCode(t.svc.cash.closeDay({ counted: 0, carriedForward: 0 }), 'VALIDATION');
    await expectCode(
      t.svc.cash.addEntry({ type: 'expense', category: 'rent', amount: 100 }),
      'VALIDATION',
    );
    t.clock.advance(20 * 60_000);
    const c2 = await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    expect(c2.periodStart).toBe(c.closedAt);
  });

  it('counts a cash repair advance', async () => {
    await t.svc.repairs.create({
      walkIn: { name: 'Asif' },
      deviceBrand: 'Samsung',
      deviceModel: 'A15',
      problem: 'Screen',
      estimatedCost: 500_000,
      advance: { amount: 200_000, method: 'cash' },
    });
    expect((await t.svc.cash.drawer()).repairCash).toBe(200_000);
  });
});

describe('cash.listCloses', () => {
  it('needs view_reports and lists newest first', async () => {
    await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    await t.svc.cash.closeDay({ counted: 0, carriedForward: 0 });
    await expectCode(t.svc.cash.listCloses(), 'FORBIDDEN');
    await t.loginAs('owner');
    const list = await t.svc.cash.listCloses({ limit: 10 });
    expect(list).toHaveLength(2);
    expect(list[0]?.closedAt).toBeGreaterThan(list[1]?.closedAt ?? Infinity);
  });
});

describe('reports.summary with expenses', () => {
  it('counts a reversal on the day of the expense it cancels', async () => {
    await t.loginAs('owner');
    const day1 = t.clock.peek();
    const e = await t.svc.cash.addEntry({ type: 'expense', category: 'rent', amount: 50_000 });
    const day2 = day1 + 86_400_000;
    t.clock.advance(86_400_000);
    await t.svc.cash.reverseEntry({ entryId: e.id });
    const s1 = await t.svc.reports.summary({ fromMs: day1, toMs: day2 });
    const s2 = await t.svc.reports.summary({ fromMs: day2, toMs: day2 + 86_400_000 });
    expect([s1.expenses, s2.expenses]).toEqual([0, 0]);
  });

  it('subtracts expenses (net of reversals) from profit', async () => {
    await t.loginAs('owner');
    const from = t.clock.peek();
    await sellCash(2);
    await t.svc.cash.addEntry({ type: 'expense', category: 'bills', amount: 40_000 });
    const wrong = await t.svc.cash.addEntry({ type: 'expense', category: 'rent', amount: 99_000 });
    await t.svc.cash.reverseEntry({ entryId: wrong.id });
    await t.svc.cash.addEntry({ type: 'cash_out', amount: 70_000 }); // not an expense
    const s = await t.svc.reports.summary({ fromMs: from, toMs: t.clock.peek() + 1 });
    expect(s.expenses).toBe(40_000);
    expect(s.netProfit).toBe(s.estimatedProfit - 40_000);
  });
});
