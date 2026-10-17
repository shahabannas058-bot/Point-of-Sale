import { describe, expect, it } from 'vitest';
import type { PosService, RepairStatus } from '@pos/shared';
import { demoShop, expectCode, rawSql } from './helpers';

const DEVICE = {
  deviceBrand: 'Samsung',
  deviceModel: 'Galaxy A55',
  imei: '356938035643809',
  problem: 'Screen cracked',
  accessories: 'Back cover',
};

async function variantBySku(s: PosService, sku: string) {
  const hit = (await s.catalog.search(sku))[0];
  if (!hit || hit.kind !== 'variant') throw new Error(`no ${sku}`);
  return hit.item;
}

async function readyTicket(s: PosService, estimate: number, advance = 0) {
  const v = await s.repairs.create({
    ...DEVICE,
    walkIn: { name: 'Walk-in Ali', phone: '03001112233' },
    estimatedCost: estimate,
    advance: advance > 0 ? { amount: advance, method: 'cash' } : null,
  });
  await s.repairs.setStatus({ ticketId: v.ticket.id, status: 'in_repair' });
  await s.repairs.setStatus({ ticketId: v.ticket.id, status: 'ready' });
  return v.ticket;
}

describe('repair tickets', () => {
  it('numbers tickets per shop and records intake, advance and the first history row', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const bilal = (await s.khata.listCustomers({ q: 'Bilal' }))[0]?.party;
    if (!bilal) throw new Error('no customer');

    const a = await s.repairs.create({
      ...DEVICE,
      customerId: bilal.id,
      estimatedCost: 5_000_00,
      advance: { amount: 1_000_00, method: 'easypaisa' },
    });
    const b = await s.repairs.create({
      ...DEVICE,
      imei: null,
      walkIn: { name: 'Walk-in Ali' },
      estimatedCost: 0,
    });
    expect(a.ticket.ticketNo).toBe('R-000001');
    expect(b.ticket.ticketNo).toBe('R-000002');
    expect(a.ticket).toMatchObject({
      status: 'received',
      customerName: 'Bilal Ahmed',
      customerPhone: '03001234567',
    });
    expect(a.payments).toMatchObject([{ kind: 'advance', method: 'easypaisa', amount: 1_000_00 }]);
    expect(a.paidTotal).toBe(1_000_00);
    expect(a.balanceDue).toBe(4_000_00);
    expect(a.history).toMatchObject([{ fromStatus: null, toStatus: 'received' }]);
    expect((await s.repairs.get('R-000002')).ticket.customerName).toBe('Walk-in Ali');
    expect((await s.repairs.list({ q: 'bilal' })).map((t) => t.ticketNo)).toEqual(['R-000001']);

    await expectCode(
      s.repairs.create({
        ...DEVICE,
        imei: '356938035643808',
        walkIn: { name: 'X' },
        estimatedCost: 0,
      }),
      'VALIDATION',
    );
    await expectCode(s.repairs.create({ ...DEVICE, estimatedCost: 0 }), 'VALIDATION');
    await expectCode(
      s.repairs.create({
        ...DEVICE,
        walkIn: { name: 'X' },
        estimatedCost: 0,
        advance: { amount: 100, method: 'khata' as 'cash' },
      }),
      'VALIDATION',
    );
  });

  it('walks the status flow, keeps every change in history and rejects invalid moves', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const { ticket } = await s.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 2_000_00,
    });
    await expectCode(
      s.repairs.setStatus({ ticketId: ticket.id, status: 'delivered' as 'ready' }),
      'VALIDATION',
    );
    await expectCode(
      s.repairs.deliver({ ticketId: ticket.id, payments: [{ method: 'cash', amount: 2_000_00 }] }),
      'VALIDATION',
    );

    const flow: RepairStatus[] = ['diagnosing', 'in_repair', 'ready'];
    for (const status of flow)
      await s.repairs.setStatus({ ticketId: ticket.id, status: status as 'ready', note: status });
    const done = await s.repairs.deliver({
      ticketId: ticket.id,
      payments: [{ method: 'cash', amount: 2_000_00 }],
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
    expect(done.history[1]?.changedByName).toBe('Cashier');

    await expectCode(
      s.repairs.setStatus({ ticketId: ticket.id, status: 'in_repair' }),
      'VALIDATION',
    );
    await expectCode(s.repairs.cancel({ ticketId: ticket.id, reason: 'oops' }), 'VALIDATION');
    await expectCode(s.repairs.update(ticket.id, { problem: 'changed' }), 'IMMUTABLE_RECORD');
    await expectCode(s.repairs.get('R-999999'), 'NOT_FOUND');
  });

  it('history, parts and payments are append-only and a closed ticket cannot be edited in SQL', async () => {
    const { s, driver } = await demoShop();
    await s.auth.login('owner', '1234');
    const ticket = await readyTicket(s, 1_500_00, 500_00);
    await s.repairs.addPart({
      ticketId: ticket.id,
      variantId: (await variantBySku(s, 'GLS-A55')).variant.id,
      quantity: 1,
    });
    const tsColumn = {
      repair_status_history: 'changed_at',
      repair_parts: 'created_at',
      repair_payments: 'created_at',
    };
    for (const [table, col] of Object.entries(tsColumn)) {
      await expectCode(rawSql(driver, `UPDATE ${table} SET ${col} = 1`), 'IMMUTABLE_RECORD');
      await expectCode(rawSql(driver, `DELETE FROM ${table}`), 'IMMUTABLE_RECORD');
    }
    await s.repairs.deliver({
      ticketId: ticket.id,
      payments: [{ method: 'cash', amount: 1_000_00 }],
    });
    await expectCode(
      rawSql(driver, "UPDATE repair_tickets SET status = 'ready', closed_at = NULL WHERE id = ?", [
        ticket.id,
      ]),
      'IMMUTABLE_RECORD',
    );
    await expectCode(rawSql(driver, 'DELETE FROM repair_tickets'), 'IMMUTABLE_RECORD');
  });

  it('spare parts write an adjustment stock movement and fail when stock is short', async () => {
    const { s, driver } = await demoShop();
    await s.auth.login('cashier', '3456');
    const glass = await variantBySku(s, 'GLS-A55');
    const { ticket } = await s.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 1_000_00,
    });
    const v = await s.repairs.addPart({
      ticketId: ticket.id,
      variantId: glass.variant.id,
      quantity: 2,
    });
    expect(v.parts).toMatchObject([
      { variantId: glass.variant.id, quantity: 2, unitPrice: glass.variant.salePrice },
    ]);
    expect((await variantBySku(s, 'GLS-A55')).onHand).toBe(glass.onHand - 2);
    const moves = await driver.query<Record<string, unknown>>(
      "SELECT type, quantity, ref_type, ref_id, reason FROM stock_movements WHERE ref_type = 'repair'",
    );
    expect(moves).toEqual([
      {
        type: 'adjustment',
        quantity: -2,
        ref_type: 'repair',
        ref_id: ticket.id,
        reason: 'repair part',
      },
    ]);
    const outbox = await driver.query<{ entity_type: string }>(
      "SELECT entity_type FROM outbox WHERE entity_type IN ('repair_part', 'stock_movement') AND entity_id IN (SELECT id FROM repair_parts UNION SELECT stock_movement_id FROM repair_parts)",
    );
    expect(outbox.map((o) => o.entity_type).sort()).toEqual(['repair_part', 'stock_movement']);

    await expectCode(
      s.repairs.addPart({
        ticketId: ticket.id,
        variantId: glass.variant.id,
        quantity: glass.onHand,
      }),
      'STOCK_INSUFFICIENT',
    );
    expect((await variantBySku(s, 'GLS-A55')).onHand).toBe(glass.onHand - 2);
    await expectCode(
      s.repairs.addPart({ ticketId: ticket.id, variantId: glass.variant.id, quantity: 0 }),
      'VALIDATION',
    );
  });

  it('delivery collects final charge minus advance, refunds an over-advance and checks the totals', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const t1 = await readyTicket(s, 5_000_00, 1_000_00);
    await expectCode(
      s.repairs.deliver({ ticketId: t1.id, payments: [{ method: 'cash', amount: 5_000_00 }] }),
      'PAYMENT_MISMATCH',
    );
    // 4% below the estimate: within the cashier's 5% limit
    const d1 = await s.repairs.deliver({
      ticketId: t1.id,
      finalCharge: 4_800_00,
      payments: [
        { method: 'cash', amount: 3_000_00 },
        { method: 'jazzcash', amount: 800_00 },
      ],
    });
    expect(d1.ticket.finalCharge).toBe(4_800_00);
    expect(d1.paidTotal).toBe(4_800_00);
    expect(d1.balanceDue).toBe(0);
    expect(d1.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 1_000_00],
      ['balance', 3_000_00],
      ['balance', 800_00],
    ]);

    // advance larger than the final charge: the difference goes back as a refund
    const t2 = await readyTicket(s, 1_000_00, 1_000_00);
    s.auth.logout();
    await s.auth.login('owner', '1234');
    const d2 = await s.repairs.deliver({
      ticketId: t2.id,
      finalCharge: 600_00,
      payments: [{ method: 'cash', amount: 400_00 }],
    });
    expect(d2.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 1_000_00],
      ['refund', -400_00],
    ]);
    expect(d2.paidTotal).toBe(600_00);
  });

  it('a big discount needs a manager approval; khata balance needs a customer and hits the ledger', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const t = await readyTicket(s, 10_000_00);
    const cheap = {
      ticketId: t.id,
      finalCharge: 8_000_00,
      payments: [{ method: 'cash' as const, amount: 8_000_00 }],
    };
    await expectCode(s.repairs.deliver(cheap), 'APPROVAL_REQUIRED');
    const grant = await s.auth.requestApproval('2345', 'discount');
    const done = await s.repairs.deliver({ ...cheap, approvalToken: grant.token });
    expect(done.history.at(-1)?.note).toBe('approved:manager');

    const walkIn = await readyTicket(s, 1_000_00);
    await expectCode(
      s.repairs.deliver({ ticketId: walkIn.id, payments: [{ method: 'khata', amount: 1_000_00 }] }),
      'KHATA_NEEDS_CUSTOMER',
    );

    const sana = (await s.khata.listCustomers({ q: 'Sana' }))[0]?.party;
    if (!sana) throw new Error('no customer');
    const { ticket } = await s.repairs.create({
      ...DEVICE,
      customerId: sana.id,
      estimatedCost: 1_500_00,
    });
    await s.repairs.setStatus({ ticketId: ticket.id, status: 'ready' });
    await s.repairs.deliver({
      ticketId: ticket.id,
      payments: [
        { method: 'cash', amount: 500_00 },
        { method: 'khata', amount: 1_000_00 },
      ],
    });
    const ledger = await s.khata.getLedger(sana.id);
    expect(ledger.balance).toBe(1_000_00);
    expect(ledger.lines[0]?.entry).toMatchObject({ type: 'adjustment', note: 'Repair R-000003' });
  });

  it('cancelling refunds the advance (with approval for a cashier) and leaves parts consumed', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const { ticket } = await s.repairs.create({
      ...DEVICE,
      walkIn: { name: 'Ali' },
      estimatedCost: 3_000_00,
      advance: { amount: 700_00, method: 'cash' },
    });
    await expectCode(
      s.repairs.cancel({ ticketId: ticket.id, reason: 'customer took it back' }),
      'APPROVAL_REQUIRED',
    );
    const grant = await s.auth.requestApproval('2345', 'void');
    const v = await s.repairs.cancel({
      ticketId: ticket.id,
      reason: 'customer took it back',
      approvalToken: grant.token,
    });
    expect(v.ticket.status).toBe('cancelled');
    expect(v.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['advance', 700_00],
      ['refund', -700_00],
    ]);
    expect(v.paidTotal).toBe(0);
    expect(v.history.at(-1)).toMatchObject({
      toStatus: 'cancelled',
      note: 'customer took it back | approved:manager',
    });

    // no money taken: a cashier may cancel without a PIN
    const free = await s.repairs.create({ ...DEVICE, walkIn: { name: 'B' }, estimatedCost: 0 });
    expect(
      (await s.repairs.cancel({ ticketId: free.ticket.id, reason: 'no parts' })).ticket.status,
    ).toBe('cancelled');
    expect((await s.repairs.list({ openOnly: true })).length).toBe(0);
  });
});
