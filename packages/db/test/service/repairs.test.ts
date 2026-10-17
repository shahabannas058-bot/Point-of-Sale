import { beforeEach, describe, expect, it } from 'vitest';
import type { RepairStatus, RepairTicketView } from '@pos/shared';
import { ServiceError } from '@pos/shared';
import { CHARGER_PRICE, IMEI_X, PINS, expectCode, makeService, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

const DEVICE = {
  deviceBrand: 'Samsung',
  deviceModel: 'Galaxy A55',
  imei: IMEI_X,
  problem: 'Screen cracked',
  accessories: 'Back cover',
};

async function readyTicket(estimate: number, advance = 0): Promise<RepairTicketView> {
  const v = await t.svc.repairs.create({
    ...DEVICE,
    walkIn: { name: 'Walk-in Ali', phone: '03001112233' },
    estimatedCost: estimate,
    advance: advance > 0 ? { amount: advance, method: 'cash' } : null,
  });
  await t.svc.repairs.setStatus({ ticketId: v.ticket.id, status: 'in_repair' });
  return t.svc.repairs.setStatus({ ticketId: v.ticket.id, status: 'ready' });
}

const rows = <T extends object>(sql: string, params: (string | number)[] = []): Promise<T[]> =>
  t.driver.query<T>(sql, params);

describe('repair tickets: intake', () => {
  it('numbers tickets per shop and records intake, advance and the first history row', async () => {
    await t.loginAs('cash');
    const a = await t.svc.repairs.create({
      ...DEVICE,
      customerId: t.ids.bilalId,
      estimatedCost: 500_000,
      advance: { amount: 100_000, method: 'easypaisa' },
    });
    const b = await t.svc.repairs.create({
      ...DEVICE,
      imei: null,
      walkIn: { name: 'Walk-in Ali' },
      estimatedCost: 0,
    });
    expect(a.ticket.ticketNo).toBe('R-000001');
    expect(b.ticket.ticketNo).toBe('R-000002');
    expect(a.ticket).toMatchObject({
      status: 'received',
      customerName: 'Bilal',
      customerPhone: '03001234567',
      branchId: t.ids.branchId,
    });
    expect(a.ticket).not.toHaveProperty('ticketSeq');
    expect(a.payments).toMatchObject([{ kind: 'advance', method: 'easypaisa', amount: 100_000 }]);
    expect(a.paidTotal).toBe(100_000);
    expect(a.balanceDue).toBe(400_000);
    expect(a.history).toMatchObject([
      { fromStatus: null, toStatus: 'received', changedByName: 'Cashier' },
    ]);
    expect((await t.svc.repairs.get('R-000002')).ticket.customerName).toBe('Walk-in Ali');
    expect((await t.svc.repairs.list({ q: 'bilal' })).map((x) => x.ticketNo)).toEqual(['R-000001']);
  });

  it('rejects a bad IMEI, a missing customer and khata as an advance', async () => {
    await t.loginAs('cash');
    await expectCode(
      t.svc.repairs.create({
        ...DEVICE,
        imei: '356938035643808',
        walkIn: { name: 'X' },
        estimatedCost: 0,
      }),
      'VALIDATION',
    );
    await expectCode(t.svc.repairs.create({ ...DEVICE, estimatedCost: 0 }), 'VALIDATION');
    await expectCode(
      t.svc.repairs.create({
        ...DEVICE,
        walkIn: { name: 'X' },
        estimatedCost: 0,
        advance: { amount: 100, method: 'khata' as 'cash' },
      }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.repairs.create({ ...DEVICE, customerId: t.newId(), estimatedCost: 0 }),
      'NOT_FOUND',
    );
    expect(await rows('select id from repair_tickets')).toHaveLength(0);
  });

  it('needs a signed-in user with the sell permission', async () => {
    await expectCode(t.svc.repairs.list(), 'NOT_AUTHENTICATED');
  });

  it('emits camelCase outbox rows for the ticket, its history and the advance', async () => {
    await t.loginAs('cash');
    const v = await t.svc.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 200_000,
      advance: { amount: 50_000, method: 'cash' },
    });
    const out = await rows<{ entity_type: string; entity_id: string; op: string; payload: string }>(
      "select entity_type, entity_id, op, payload from outbox where entity_type like 'repair_%' order by id",
    );
    expect(out.map((o) => o.entity_type).sort()).toEqual([
      'repair_payment',
      'repair_status',
      'repair_ticket',
    ]);
    const ticketRow = out.find((o) => o.entity_type === 'repair_ticket');
    expect(ticketRow?.entity_id).toBe(v.ticket.id);
    expect(JSON.parse(ticketRow?.payload ?? '{}')).toMatchObject({
      id: v.ticket.id,
      ticketNo: 'R-000001',
      estimatedCost: 200_000,
      status: 'received',
    });
  });
});

describe('repair tickets: status flow', () => {
  it('walks the flow, keeps every change in history and rejects invalid moves', async () => {
    await t.loginAs('cash');
    const { ticket } = await t.svc.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 200_000,
    });
    await expectCode(
      t.svc.repairs.setStatus({ ticketId: ticket.id, status: 'delivered' as 'ready' }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.repairs.deliver({
        ticketId: ticket.id,
        payments: [{ method: 'cash', amount: 200_000 }],
      }),
      'VALIDATION',
    );
    const flow: RepairStatus[] = ['diagnosing', 'in_repair', 'ready'];
    for (const status of flow)
      await t.svc.repairs.setStatus({
        ticketId: ticket.id,
        status: status as 'ready',
        note: status,
      });
    const done = await t.svc.repairs.deliver({
      ticketId: ticket.id,
      payments: [{ method: 'cash', amount: 200_000 }],
    });
    expect(done.ticket.status).toBe('delivered');
    expect(done.ticket.closedAt).not.toBeNull();
    expect(done.history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, 'received'],
      ['received', 'diagnosing'],
      ['diagnosing', 'in_repair'],
      ['in_repair', 'ready'],
      ['ready', 'delivered'],
    ]);

    await expectCode(
      t.svc.repairs.setStatus({ ticketId: ticket.id, status: 'in_repair' }),
      'VALIDATION',
    );
    await expectCode(t.svc.repairs.cancel({ ticketId: ticket.id, reason: 'oops' }), 'VALIDATION');
    await expectCode(t.svc.repairs.update(ticket.id, { problem: 'changed' }), 'IMMUTABLE_RECORD');
    await expectCode(t.svc.repairs.get('R-999999'), 'NOT_FOUND');
  });

  it('updates the editable fields of an open ticket', async () => {
    await t.loginAs('cash');
    const { ticket } = await t.svc.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 100_000,
    });
    const v = await t.svc.repairs.update(ticket.id, {
      problem: 'Battery drains fast',
      estimatedCost: 150_000,
      technicianId: t.ids.managerId,
      promisedAt: t.clock.peek() + 86_400_000,
    });
    expect(v.ticket).toMatchObject({
      problem: 'Battery drains fast',
      estimatedCost: 150_000,
      technicianId: t.ids.managerId,
    });
    expect(v.technicianName).toBe('Manager');
    await expectCode(t.svc.repairs.update(ticket.id, { technicianId: t.newId() }), 'NOT_FOUND');
  });

  it('history, parts and payments are append-only and a closed ticket cannot be edited in SQL', async () => {
    await t.loginAs('owner');
    const ticket = (await readyTicket(150_000, 50_000)).ticket;
    await t.svc.repairs.addPart({ ticketId: ticket.id, variantId: t.ids.chargerId, quantity: 1 });
    const tsColumn = {
      repair_status_history: 'changed_at',
      repair_parts: 'created_at',
      repair_payments: 'created_at',
    };
    for (const [table, col] of Object.entries(tsColumn)) {
      await expect(t.driver.query(`UPDATE ${table} SET ${col} = 1`)).rejects.toThrow(/append-only/);
      await expect(t.driver.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
    }
    await t.svc.repairs.deliver({
      ticketId: ticket.id,
      payments: [{ method: 'cash', amount: 100_000 }],
    });
    await expect(
      t.driver.query("UPDATE repair_tickets SET status = 'ready', closed_at = NULL WHERE id = ?", [
        ticket.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(t.driver.query('DELETE FROM repair_tickets')).rejects.toThrow(/append-only/);
  });
});

describe('repair tickets: spare parts', () => {
  it('writes an adjustment movement linked from the part row and fails when stock is short', async () => {
    await t.loginAs('cash');
    const { ticket } = await t.svc.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 100_000,
    });
    const v = await t.svc.repairs.addPart({
      ticketId: ticket.id,
      variantId: t.ids.chargerId,
      quantity: 2,
    });
    expect(v.parts).toMatchObject([
      {
        variantId: t.ids.chargerId,
        quantity: 2,
        unitPrice: CHARGER_PRICE,
        label: 'Generic Fast Charger 25W',
      },
    ]);
    const onHand = await rows<{ n: number }>(
      'select coalesce(sum(quantity), 0) as n from stock_movements where variant_id = ?',
      [t.ids.chargerId],
    );
    expect(onHand[0]?.n).toBe(8);

    const link = await rows<{ type: string; quantity: number; reason: string; ref_type: null }>(
      `select sm.type, sm.quantity, sm.reason, sm.ref_type
       from repair_parts rp join stock_movements sm on sm.id = rp.stock_movement_id`,
    );
    expect(link).toEqual([
      { type: 'adjustment', quantity: -2, reason: 'Repair part R-000001', ref_type: null },
    ]);
    const outbox = await rows<{ entity_type: string }>(
      `select entity_type from outbox where entity_id in
         (select id from repair_parts union select stock_movement_id from repair_parts)`,
    );
    expect(outbox.map((o) => o.entity_type).sort()).toEqual(['repair_part', 'stock_movement']);

    await expectCode(
      t.svc.repairs.addPart({ ticketId: ticket.id, variantId: t.ids.chargerId, quantity: 9 }),
      'STOCK_INSUFFICIENT',
    );
    await expectCode(
      t.svc.repairs.addPart({ ticketId: ticket.id, variantId: t.ids.chargerId, quantity: 0 }),
      'VALIDATION',
    );
    const after = await rows<{ n: number }>(
      'select coalesce(sum(quantity), 0) as n from stock_movements where variant_id = ?',
      [t.ids.chargerId],
    );
    expect(after[0]?.n).toBe(8);
  });
});

describe('repair tickets: delivery', () => {
  it('collects final charge minus advance, refunds an over-advance and checks the totals', async () => {
    await t.loginAs('cash');
    const t1 = (await readyTicket(500_000, 100_000)).ticket;
    await expectCode(
      t.svc.repairs.deliver({ ticketId: t1.id, payments: [{ method: 'cash', amount: 500_000 }] }),
      'PAYMENT_MISMATCH',
    );
    // 4% below the estimate: within the cashier's 5% limit
    const d1 = await t.svc.repairs.deliver({
      ticketId: t1.id,
      finalCharge: 480_000,
      payments: [
        { method: 'cash', amount: 300_000 },
        { method: 'jazzcash', amount: 80_000 },
      ],
    });
    expect(d1.ticket.finalCharge).toBe(480_000);
    expect(d1.paidTotal).toBe(480_000);
    expect(d1.balanceDue).toBe(0);
    expect(d1.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 100_000],
      ['balance', 300_000],
      ['balance', 80_000],
    ]);

    // advance larger than the final charge: the difference goes back as a refund (owner, no approval needed)
    const t2 = (await readyTicket(100_000, 100_000)).ticket;
    t.svc.auth.logout();
    await t.loginAs('owner');
    const d2 = await t.svc.repairs.deliver({
      ticketId: t2.id,
      finalCharge: 60_000,
      payments: [{ method: 'cash', amount: 40_000 }],
    });
    expect(d2.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 100_000],
      ['refund', -40_000],
    ]);
    expect(d2.paidTotal).toBe(60_000);
    await expectCode(
      t.svc.repairs.deliver({ ticketId: t2.id, payments: [] }),
      'VALIDATION', // already delivered
    );
  });

  it('a big discount needs a manager approval, consumed once', async () => {
    await t.loginAs('cash');
    const ticket = (await readyTicket(1_000_000)).ticket;
    const cheap = {
      ticketId: ticket.id,
      finalCharge: 800_000,
      payments: [{ method: 'cash' as const, amount: 800_000 }],
    };
    const err = await expectCode(t.svc.repairs.deliver(cheap), 'APPROVAL_REQUIRED');
    expect(err.details).toMatchObject({ reason: 'discount' });
    const grant = await t.svc.auth.requestApproval(PINS.mgr);
    const done = await t.svc.repairs.deliver({ ...cheap, approvalToken: grant.token });
    expect(done.history.at(-1)?.note).toBe('approved:mgr');
    // the token is single use
    const second = (await readyTicket(1_000_000)).ticket;
    await expectCode(
      t.svc.repairs.deliver({ ...cheap, ticketId: second.id, approvalToken: grant.token }),
      'APPROVAL_REQUIRED',
    );
  });

  it('khata needs a customer, lands on the customer ledger and respects the credit limit', async () => {
    await t.loginAs('cash');
    const walkIn = (await readyTicket(100_000)).ticket;
    await expectCode(
      t.svc.repairs.deliver({
        ticketId: walkIn.id,
        payments: [{ method: 'khata', amount: 100_000 }],
      }),
      'KHATA_NEEDS_CUSTOMER',
    );

    const { ticket } = await t.svc.repairs.create({
      ...DEVICE,
      customerId: t.ids.bilalId,
      estimatedCost: 150_000,
    });
    await t.svc.repairs.setStatus({ ticketId: ticket.id, status: 'ready' });
    await t.svc.repairs.deliver({
      ticketId: ticket.id,
      payments: [
        { method: 'cash', amount: 50_000 },
        { method: 'khata', amount: 100_000 },
      ],
    });
    const ledger = await t.svc.khata.getLedger(t.ids.bilalId);
    expect(ledger.balance).toBe(100_000);
    expect(ledger.lines[0]?.entry).toMatchObject({ type: 'adjustment', note: 'Repair R-000002' });

    // 5 000 000 paisa limit: another 4 950 000 on khata would pass it
    const big = await t.svc.repairs.create({
      ...DEVICE,
      customerId: t.ids.bilalId,
      estimatedCost: 4_950_000,
    });
    await t.svc.repairs.setStatus({ ticketId: big.ticket.id, status: 'ready' });
    const err = await expectCode(
      t.svc.repairs.deliver({
        ticketId: big.ticket.id,
        payments: [{ method: 'khata', amount: 4_950_000 }],
      }),
      'APPROVAL_REQUIRED',
    );
    expect(err.details).toMatchObject({ reason: 'credit_limit' });
    const grant = await t.svc.auth.requestApproval(PINS.mgr);
    await t.svc.repairs.deliver({
      ticketId: big.ticket.id,
      payments: [{ method: 'khata', amount: 4_950_000 }],
      approvalToken: grant.token,
    });
    expect((await t.svc.khata.getLedger(t.ids.bilalId)).balance).toBe(5_050_000);
  });
});

describe('repair tickets: cancellation', () => {
  it('refunds the advance (with approval for a cashier) and leaves parts consumed', async () => {
    await t.loginAs('cash');
    const { ticket } = await t.svc.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 300_000,
      advance: { amount: 70_000, method: 'cash' },
    });
    await expectCode(
      t.svc.repairs.cancel({ ticketId: ticket.id, reason: 'customer took it back' }),
      'APPROVAL_REQUIRED',
    );
    const grant = await t.svc.auth.requestApproval(PINS.mgr);
    const v = await t.svc.repairs.cancel({
      ticketId: ticket.id,
      reason: 'customer took it back',
      approvalToken: grant.token,
    });
    expect(v.ticket.status).toBe('cancelled');
    expect(v.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 70_000],
      ['refund', -70_000],
    ]);
    expect(v.paidTotal).toBe(0);
    expect(v.history.at(-1)).toMatchObject({
      toStatus: 'cancelled',
      note: 'customer took it back | approved:mgr',
    });

    // no money taken: a cashier may cancel without a PIN
    const free = await t.svc.repairs.create({ ...DEVICE, walkIn: { name: 'B' }, estimatedCost: 0 });
    expect(
      (await t.svc.repairs.cancel({ ticketId: free.ticket.id, reason: 'no parts' })).ticket.status,
    ).toBe('cancelled');
    expect((await t.svc.repairs.list({ openOnly: true })).length).toBe(0);
  });
});

describe('repair tickets: licence hook', () => {
  it('asks the hook with action "repair" and writes nothing when it blocks', async () => {
    await t.loginAs('cash');
    await t.svc.repairs.create({ ...DEVICE, walkIn: { name: 'Ali' }, estimatedCost: 0 });
    expect(t.assertCanSell).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'repair', branchId: t.ids.branchId }),
    );

    t.assertCanSell.mockImplementation(() =>
      Promise.reject(
        new ServiceError('LICENCE_BLOCKED', 'Subscription expired', { state: 'LOCKED' }),
      ),
    );
    await expectCode(
      t.svc.repairs.create({ ...DEVICE, walkIn: { name: 'Blocked' }, estimatedCost: 0 }),
      'LICENCE_BLOCKED',
    );
    expect(await rows('select id from repair_tickets')).toHaveLength(1);
    // reading stays possible when locked
    expect(await t.svc.repairs.list()).toHaveLength(1);
  });
});
