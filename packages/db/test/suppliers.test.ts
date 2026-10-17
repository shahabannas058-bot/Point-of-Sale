import { describe, expect, it } from 'vitest';
import { isServiceError, type PosService, type ServiceErrorCode } from '@pos/shared';
import { createPosService, seedDemoData } from '../src/service';
import { migratedDriver } from './node-driver';

async function demo(): Promise<PosService> {
  const driver = await migratedDriver();
  await seedDemoData({ driver });
  return createPosService({ driver });
}

async function expectCode(p: Promise<unknown>, code: ServiceErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isServiceError(e) ? e.code : e).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

const rs = (n: number): number => n * 100;

async function supplierId(s: PosService, name: string): Promise<string> {
  const hit = (await s.purchasing.listSuppliers()).find((r) => r.party.name === name);
  if (!hit) throw new Error(`demo supplier ${name} missing`);
  return hit.party.id;
}

describe('supplier ledger', () => {
  it('shows a part-paid purchase as credit then payment, with running balances', async () => {
    const s = await demo();
    await s.auth.login('manager', '2345');
    const id = await supplierId(s, 'Karachi Accessories House');
    const acc = (await s.catalog.listAccessories()).at(0);
    if (!acc) throw new Error('demo accessory missing');

    const r = await s.purchasing.receive({
      supplierId: id,
      referenceNo: 'KAH-881',
      phones: [],
      accessories: [{ variantId: acc.variant.id, quantity: 10, unitCost: rs(500) }],
      paidNow: { amount: rs(2000), method: 'cash' },
    });
    expect(r.supplierBalance).toBe(rs(3000));

    const led = await s.purchasing.getSupplierLedger(id);
    expect(led.supplier.name).toBe('Karachi Accessories House');
    expect(led.balance).toBe(rs(3000));
    // newest first: the payment sits above the purchase credit
    expect(led.lines.map((l) => l.entry.type)).toEqual(['payment_made', 'purchase_credit']);
    expect(led.lines.map((l) => l.runningBalance)).toEqual([rs(3000), rs(5000)]);
    expect(led.lines.map((l) => l.referenceNo)).toEqual(['KAH-881', 'KAH-881']);
    expect(led.lines[0]?.entry.method).toBe('cash');
  });

  it('paySupplier reduces the balance and adds a payment_made line', async () => {
    const s = await demo();
    await s.auth.login('manager', '2345');
    const id = await supplierId(s, 'Karachi Accessories House');
    const acc = (await s.catalog.listAccessories()).at(0);
    if (!acc) throw new Error('demo accessory missing');
    await s.purchasing.receive({
      supplierId: id,
      phones: [],
      accessories: [{ variantId: acc.variant.id, quantity: 4, unitCost: rs(1000) }],
    });

    expect(
      await s.purchasing.paySupplier({ supplierId: id, amount: rs(1500), method: 'jazzcash' }),
    ).toBe(rs(2500));
    const led = await s.purchasing.getSupplierLedger(id);
    expect(led.balance).toBe(rs(2500));
    expect(led.lines[0]?.entry).toMatchObject({
      type: 'payment_made',
      amount: -rs(1500),
      method: 'jazzcash',
    });
    expect(led.lines[0]?.referenceNo).toBeNull();
    const listed = (await s.purchasing.listSuppliers()).find((r) => r.party.id === id);
    expect(listed?.balance).toBe(rs(2500));

    await expectCode(s.purchasing.paySupplier({ supplierId: id, amount: 0 }), 'VALIDATION');
  });

  it('records an opening balance for a new supplier', async () => {
    const s = await demo();
    await s.auth.login('manager', '2345');
    const sup = await s.purchasing.createSupplier({
      name: 'Lahore Mobile Mall',
      openingBalance: rs(75000),
    });
    const led = await s.purchasing.getSupplierLedger(sup.id);
    expect(led.balance).toBe(rs(75000));
    expect(led.lines).toHaveLength(1);
    expect(led.lines[0]?.entry).toMatchObject({ type: 'opening_balance', amount: rs(75000) });
    expect(led.lines[0]?.runningBalance).toBe(rs(75000));

    const none = await s.purchasing.createSupplier({ name: 'No Opening Traders' });
    expect((await s.purchasing.getSupplierLedger(none.id)).lines).toEqual([]);
    await expectCode(
      s.purchasing.createSupplier({ name: 'Bad', openingBalance: -5 }),
      'VALIDATION',
    );
  });

  it('pages with limit and beforeCreatedAt, and 404s an unknown supplier', async () => {
    const s = await demo();
    await s.auth.login('manager', '2345');
    const sup = await s.purchasing.createSupplier({ name: 'Paging Co', openingBalance: rs(900) });
    await s.purchasing.paySupplier({ supplierId: sup.id, amount: rs(100) });
    await s.purchasing.paySupplier({ supplierId: sup.id, amount: rs(200) });
    const top = await s.purchasing.getSupplierLedger(sup.id, { limit: 2 });
    expect(top.lines.map((l) => l.runningBalance)).toEqual([rs(600), rs(800)]);
    expect(top.balance).toBe(rs(600));
    await expectCode(s.purchasing.getSupplierLedger('nope'), 'NOT_FOUND');
  });

  it('is FORBIDDEN for a cashier', async () => {
    const s = await demo();
    await s.auth.login('manager', '2345');
    const id = await supplierId(s, 'Hafeez Centre Traders');
    s.auth.logout();
    await s.auth.login('cashier', '3456');
    await expectCode(s.purchasing.getSupplierLedger(id), 'FORBIDDEN');
    await expectCode(
      s.purchasing.createSupplier({ name: 'X', openingBalance: rs(1) }),
      'FORBIDDEN',
    );
    await expectCode(s.purchasing.paySupplier({ supplierId: id, amount: rs(1) }), 'FORBIDDEN');
  });
});
