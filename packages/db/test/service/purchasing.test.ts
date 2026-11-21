import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHARGER_COST,
  CARTON_COST,
  expectCode,
  makeService,
  snapshotCounts,
  stockSum,
  type TestService,
} from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

async function makeSupplier(): Promise<string> {
  const s = await t.svc.purchasing.createSupplier({
    name: 'Hafeez Centre Traders',
    phone: '03211234567',
  });
  return s.id;
}

describe('purchase receipt (spec 9)', () => {
  it('books 1 carton + 10 chargers: total 8 700 000, ledger, movements, balance 6 700 000 after paying 2 000 000', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    const outboxBefore = await snapshotCounts(t.driver);
    const typeCounts = async (): Promise<Record<string, number>> => {
      const rows = await t.driver.query<{ entity_type: string; n: number }>(
        'select entity_type, count(*) as n from outbox group by entity_type',
      );
      return Object.fromEntries(rows.map((r) => [r.entity_type, r.n]));
    };
    const typesBefore = await typeCounts();
    const result = await t.svc.purchasing.receive({
      supplierId,
      referenceNo: 'INV-9001',
      accessories: [
        { variantId: t.ids.cartonId, quantity: 1, unitCost: CARTON_COST },
        { variantId: t.ids.chargerId, quantity: 10, unitCost: CHARGER_COST },
      ],
      paidNow: { method: 'cash', amount: 2_000_000 },
    });

    expect(result.purchase.total).toBe(8_700_000);
    expect(result.purchase).toMatchObject({
      supplierId,
      kind: 'purchase',
      referenceNo: 'INV-9001',
    });
    expect(result.supplierBalance).toBe(6_700_000);
    expect(result).not.toHaveProperty('phoneUnitIds');

    const ledger = await t.driver.query<{ type: string; amount: number; method: string | null }>(
      'select type, amount, method from ledger_entries where supplier_id = ? order by created_at, id',
      [supplierId],
    );
    expect(ledger).toEqual([
      { type: 'purchase_credit', amount: 8_700_000, method: null },
      { type: 'payment_made', amount: -2_000_000, method: 'cash' },
    ]);

    const cartonMoves = await t.driver.query<{
      type: string;
      quantity: number;
      unit_cost: number;
      ref_type: string;
      ref_id: string;
    }>(
      "select type, quantity, unit_cost, ref_type, ref_id from stock_movements where variant_id = ? and type = 'purchase'",
      [t.ids.cartonId],
    );
    expect(cartonMoves).toEqual([
      {
        type: 'purchase',
        quantity: 1,
        unit_cost: CARTON_COST,
        ref_type: 'purchase',
        ref_id: result.purchase.id,
      },
    ]);
    const variantMoves = await t.driver.query<{ type: string; quantity: number }>(
      "select type, quantity from stock_movements where variant_id = ? and type = 'purchase'",
      [t.ids.chargerId],
    );
    expect(variantMoves).toEqual([{ type: 'purchase', quantity: 10 }]);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(20);

    // outbox: purchase, 2 stock movements, 2 ledger entries, 2 variant cost updates
    const after = await snapshotCounts(t.driver);
    expect(after.outbox).toBeGreaterThan(outboxBefore.outbox);
    const typesAfter = await typeCounts();
    const added = (k: string): number => (typesAfter[k] ?? 0) - (typesBefore[k] ?? 0);
    expect(added('purchase')).toBe(1);
    expect(added('product')).toBe(0);
    expect(added('ledger_entry')).toBe(2);
    expect(added('stock_movement')).toBe(2);
    expect(added('accessory_variant')).toBe(2);

    expect(
      await t.svc.purchasing.paySupplier({ supplierId, amount: 6_700_000, method: 'cash' }),
    ).toBe(0);
    const list = await t.svc.purchasing.listSuppliers();
    expect(list.find((s) => s.party.id === supplierId)?.balance).toBe(0);
  });

  it('updates the variant cost to the latest unit cost', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await t.svc.purchasing.receive({
      supplierId,
      accessories: [{ variantId: t.ids.chargerId, quantity: 5, unitCost: 95_000 }],
    });
    const view = (await t.svc.catalog.listAccessories()).find(
      (v) => v.variant.id === t.ids.chargerId,
    );
    expect(view?.variant.costPrice).toBe(95_000);
    expect(view?.onHand).toBe(15);
  });

  it('calls the licence hook with the purchase action; a block writes nothing', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    const input = {
      supplierId,
      accessories: [{ variantId: t.ids.cartonId, quantity: 1, unitCost: CARTON_COST }],
    };
    t.assertCanSell.mockClear();
    t.assertCanSell.mockRejectedValueOnce(new Error('locked'));
    const before = await snapshotCounts(t.driver);
    await expectCode(t.svc.purchasing.receive(input), 'INTERNAL');
    expect(await snapshotCounts(t.driver)).toEqual(before);
    expect(await stockSum(t.driver, { variantId: t.ids.cartonId })).toBe(1);
    await t.svc.purchasing.receive(input);
    expect(t.assertCanSell).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'purchase' }),
    );
  });

  it('is atomic: a bad later line writes nothing, not even the good lines before it', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    const before = await snapshotCounts(t.driver);
    const e = await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: [
          { variantId: t.ids.chargerId, quantity: 1, unitCost: CHARGER_COST },
          { variantId: t.ids.cartonId, quantity: 0, unitCost: CARTON_COST },
        ],
      }),
      'VALIDATION',
    );
    expect(e.details).toMatchObject({ field: 'accessories.1.quantity' });
    expect(await snapshotCounts(t.driver)).toEqual(before);
    expect(await stockSum(t.driver, { variantId: t.ids.chargerId })).toBe(10);
  });
});

describe('purchase validation and access', () => {
  it('rejects empty purchases, over-payment, khata pay-now, unknown supplier and variant', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await expectCode(t.svc.purchasing.receive({ supplierId, accessories: [] }), 'VALIDATION');
    const acc = [{ variantId: t.ids.chargerId, quantity: 1, unitCost: CHARGER_COST }];
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: acc,
        paidNow: { method: 'cash', amount: CHARGER_COST + 1 },
      }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: acc,
        paidNow: { method: 'khata' as never, amount: 1 },
      }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.purchasing.receive({ supplierId: t.newId(), accessories: acc }),
      'NOT_FOUND',
    );
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: [{ variantId: t.newId(), quantity: 1, unitCost: 1 }],
      }),
      'NOT_FOUND',
    );
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: [{ variantId: t.ids.chargerId, quantity: 1, unitCost: 10.5 }],
      }),
      'MONEY_INVALID',
    );
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: [{ variantId: t.ids.chargerId, quantity: 0, unitCost: 1 }],
      }),
      'VALIDATION',
    );
  });

  it('a cashier cannot receive stock or create suppliers, but may be shown none either way', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    t.svc.auth.logout();
    await t.loginAs('cash');
    await expectCode(t.svc.purchasing.createSupplier({ name: 'X' }), 'FORBIDDEN');
    await expectCode(
      t.svc.purchasing.receive({
        supplierId,
        accessories: [{ variantId: t.ids.chargerId, quantity: 1, unitCost: 1 }],
      }),
      'FORBIDDEN',
    );
    await expectCode(
      t.svc.purchasing.paySupplier({ supplierId, amount: 1, method: 'cash' }),
      'FORBIDDEN',
    );
    expect((await t.svc.purchasing.listSuppliers()).length).toBe(1); // view_catalog is enough
  });

  it('paySupplier validates amount and method and the supplier', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    await expectCode(
      t.svc.purchasing.paySupplier({ supplierId, amount: 0, method: 'cash' }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.purchasing.paySupplier({ supplierId, amount: 5, method: 'khata' as never }),
      'VALIDATION',
    );
    await expectCode(
      t.svc.purchasing.paySupplier({ supplierId: t.newId(), amount: 5, method: 'cash' }),
      'NOT_FOUND',
    );
  });

  it('paying a supplier more than owed leaves a negative (advance) balance', async () => {
    await t.loginAs('mgr');
    const supplierId = await makeSupplier();
    expect(
      await t.svc.purchasing.paySupplier({ supplierId, amount: 10_000, method: 'jazzcash' }),
    ).toBe(-10_000);
  });

  it('createSupplier validates input and emits a supplier outbox row', async () => {
    await t.loginAs('mgr');
    await expectCode(t.svc.purchasing.createSupplier({ name: '' }), 'VALIDATION');
    await expectCode(t.svc.purchasing.createSupplier({ name: 'A', phone: 'xyz' }), 'VALIDATION');
    await makeSupplier();
    const rows = await t.driver.query<{ n: number }>(
      "select count(*) as n from outbox where entity_type = 'supplier'",
    );
    expect(rows[0]?.n).toBe(1);
  });
});
