import { describe, expect, it } from 'vitest';
import { isServiceError, type PosService, type ServiceErrorCode } from '@pos/shared';
import { checksum, migrate, migrationsFromFiles } from '../src';
import { createPosService, seedDemoData } from '../src/service';
import { loadMigrationFiles, migratedDriver } from './node-driver';

async function demo(): Promise<{
  s: PosService;
  driver: Awaited<ReturnType<typeof migratedDriver>>;
}> {
  const driver = await migratedDriver();
  await seedDemoData({ driver });
  return { s: createPosService({ driver }), driver };
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

describe('migrations', () => {
  it('builds every table once and is a no-op the second time', async () => {
    const driver = await migratedDriver();
    const tables = (
      await driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
    ).map((r) => r.name);
    expect(tables).toEqual([
      'accessory_variants',
      'app_meta',
      'branches',
      'customers',
      'ledger_entries',
      'outbox',
      'payments',
      'phone_units',
      'products',
      'purchases',
      'sale_lines',
      'sales',
      'schema_migrations',
      'stock_movements',
      'suppliers',
      'users',
    ]);
    const triggers = await driver.query("SELECT name FROM sqlite_master WHERE type = 'trigger'");
    expect(triggers.length).toBeGreaterThanOrEqual(10);
    expect(await migrate(driver, migrationsFromFiles(loadMigrationFiles()))).toEqual([]);
  });

  it('rejects a migration edited after it was applied', async () => {
    const driver = await migratedDriver();
    const tampered = migrationsFromFiles(loadMigrationFiles()).map((m) =>
      m.version === 2 ? { ...m, sql: `${m.sql}\n-- sneaky edit` } : m,
    );
    await expect(migrate(driver, tampered)).rejects.toThrow(
      'Migration 2 (stock) was modified after it was applied',
    );
  });

  it('checksums are SHA-256 hex of LF-normalised SQL', () => {
    expect(checksum('a\r\nb')).toBe(checksum('a\nb'));
    expect(checksum('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('PosService on real SQLite', () => {
  it('seeds a demo shop and logs in with PINs', async () => {
    const { s } = await demo();
    expect(await s.setup.isSetUp()).toBe(true);
    expect((await s.setup.getShop()).isDemo).toBe(true);
    await expectCode(s.auth.login('owner', '0000'), 'INVALID_CREDENTIALS');
    const session = await s.auth.login('cashier', '3456');
    expect(session.user.role).toBe('cashier');
    expect(s.auth.can('manage_users')).toBe(false);
    await expectCode(s.auth.listUsers(), 'FORBIDDEN');
  });

  it('locks login after five wrong PINs', async () => {
    const { s } = await demo();
    for (let i = 0; i < 5; i++)
      await expectCode(s.auth.login('cashier', '9999'), 'INVALID_CREDENTIALS');
    await expectCode(s.auth.login('cashier', '3456'), 'LOGIN_LOCKED');
  });

  it('sells, moves stock, chains the invoice and finds it by IMEI', async () => {
    const { s } = await demo();
    await s.auth.login('cashier', '3456');
    const [hit] = await s.catalog.search('Galaxy A55');
    if (!hit || hit.kind !== 'phone_unit') throw new Error('no phone');
    const unit = hit.item.unit;
    const glass = (await s.catalog.search('GLS-A55'))[0];
    if (!glass || glass.kind !== 'variant') throw new Error('no glass');
    const before = glass.item.onHand;

    const total = unit.salePrice + 2 * glass.item.variant.salePrice;
    const inv = await s.checkout.commit({
      lines: [
        { phoneUnitId: unit.id, quantity: 1 },
        { variantId: glass.item.variant.id, quantity: 2 },
      ],
      payments: [
        { method: 'cash', amount: total - 100_00 },
        { method: 'easypaisa', amount: 100_00 },
      ],
    });
    expect(inv.invoiceNo).toBe('A-000004');
    expect(inv.total).toBe(total);
    expect((await s.catalog.search(unit.imei1 ?? '', { inStockOnly: true })).length).toBe(0);
    const after = (await s.catalog.search('GLS-A55'))[0];
    expect(after?.kind === 'variant' ? after.item.onHand : -1).toBe(before - 2);
    expect((await s.checkout.listInvoices({ q: unit.imei1 ?? '' }))[0]?.id).toBe(inv.id);

    await expectCode(
      s.checkout.commit({
        lines: [{ phoneUnitId: unit.id, quantity: 1 }],
        payments: [{ method: 'cash', amount: unit.salePrice }],
      }),
      'UNIT_NOT_IN_STOCK',
    );
    const chain = await s.integrity.verifyChain();
    expect(chain).toMatchObject({ ok: true, count: 4, headSeq: 4 });
  });

  it('is idempotent on saleId', async () => {
    const { s } = await demo();
    await s.auth.login('owner', '1234');
    const v = (await s.catalog.search('CBL-C-1M'))[0];
    if (!v || v.kind !== 'variant') throw new Error('no cable');
    const input = {
      saleId: '019a0000-0000-7000-8000-000000000001',
      lines: [{ variantId: v.item.variant.id, quantity: 1 }],
      payments: [{ method: 'cash' as const, amount: v.item.variant.salePrice }],
    };
    const a = await s.checkout.commit(input);
    const b = await s.checkout.commit(input);
    expect(b.id).toBe(a.id);
    expect((await s.checkout.listInvoices()).length).toBe(4);
  });

  it('enforces stock, payment totals, khata customer and the cashier discount limit', async () => {
    const { s } = await demo();
    await s.auth.login('cashier', '3456');
    const v = (await s.catalog.search('PWR-20K'))[0];
    if (!v || v.kind !== 'variant') throw new Error('no power bank');
    const id = v.item.variant.id;
    const price = v.item.variant.salePrice;
    await expectCode(
      s.checkout.commit({
        lines: [{ variantId: id, quantity: 3 }],
        payments: [{ method: 'cash', amount: 3 * price }],
      }),
      'STOCK_INSUFFICIENT',
    );
    await expectCode(
      s.checkout.commit({
        lines: [{ variantId: id, quantity: 1 }],
        payments: [{ method: 'cash', amount: price - 1 }],
      }),
      'PAYMENT_MISMATCH',
    );
    await expectCode(
      s.checkout.commit({
        lines: [{ variantId: id, quantity: 1 }],
        payments: [{ method: 'khata', amount: price }],
      }),
      'KHATA_NEEDS_CUSTOMER',
    );
    const big = { lines: [{ variantId: id, quantity: 1, discountAmount: 2000_00 }] };
    expect((await s.checkout.preview(big)).needsApproval).toEqual(['discount']);
    await expectCode(
      s.checkout.commit({ ...big, payments: [{ method: 'cash', amount: price - 2000_00 }] }),
      'APPROVAL_REQUIRED',
    );
    await expectCode(s.auth.requestApproval('3456'), 'APPROVAL_INVALID');
    const grant = await s.auth.requestApproval('2345');
    const inv = await s.checkout.commit({
      ...big,
      payments: [{ method: 'cash', amount: price - 2000_00 }],
      approvalToken: grant.token,
    });
    expect(inv.note).toBe('approved:manager');
  });

  it('khata: credit sale, payment and credit limit', async () => {
    const { s } = await demo();
    await s.auth.login('cashier', '3456');
    const bilal = (await s.khata.listCustomers({ q: 'bilal' }))[0];
    if (!bilal) throw new Error('no bilal');
    const start = bilal.balance;
    const v = (await s.catalog.search('CHG-65-BLK'))[0];
    if (!v || v.kind !== 'variant') throw new Error('no charger');
    const price = v.item.variant.salePrice;
    await s.checkout.commit({
      lines: [{ variantId: v.item.variant.id, quantity: 1 }],
      customerId: bilal.party.id,
      payments: [{ method: 'khata', amount: price }],
    });
    const ledger = await s.khata.getLedger(bilal.party.id);
    expect(ledger.balance).toBe(start + price);
    expect(ledger.lines[0]?.entry.type).toBe('sale_credit');
    expect(ledger.lines[0]?.invoiceNo).toMatch(/^A-/);
    expect(
      await s.khata.receivePayment({ customerId: bilal.party.id, amount: price, method: 'cash' }),
    ).toBe(start);
    await expectCode(
      s.khata.receivePayment({ customerId: bilal.party.id, amount: start + 1, method: 'cash' }),
      'VALIDATION',
    );
    // limit 50,000: going over needs approval
    const phone = (await s.catalog.listPhones({ inStock: true })).find(
      (p) => p.product.name === 'Galaxy S24',
    );
    if (!phone) throw new Error('no S24');
    await expectCode(
      s.checkout.commit({
        lines: [{ phoneUnitId: phone.unit.id, quantity: 1 }],
        customerId: bilal.party.id,
        payments: [{ method: 'khata', amount: phone.unit.salePrice }],
      }),
      'APPROVAL_REQUIRED',
    );
  });

  it('partial return then void restores stock and refunds the rest; records stay immutable', async () => {
    const { s, driver } = await demo();
    await s.auth.login('owner', '1234');
    const v = (await s.catalog.search('CBL-C-1M'))[0];
    if (!v || v.kind !== 'variant') throw new Error('no cable');
    const onHand = v.item.onHand;
    const price = v.item.variant.salePrice;
    const sale = await s.checkout.commit({
      lines: [{ variantId: v.item.variant.id, quantity: 4, discountAmount: 100_00 }],
      payments: [{ method: 'cash', amount: 4 * price - 100_00 }],
    });
    const line = sale.lines[0];
    if (!line) throw new Error('no line');
    const pv = await s.checkout.previewReturn(sale.id, [{ lineId: line.id, quantity: 1 }]);
    expect(pv.total).toBe(-(price - 25_00));
    expect(pv.suggestedRefund).toEqual([{ method: 'cash', amount: price - 25_00 }]);
    const ret = await s.checkout.createReturn({
      originalSaleId: sale.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: pv.suggestedRefund,
      reason: 'faulty',
    });
    expect(ret.kind).toBe('return');
    expect(ret.lines[0]?.lineNo).toBe(1);
    const again = await s.checkout.previewReturn(sale.id, []);
    expect(again.lines[0]?.remainingQty).toBe(3);

    const vd = await s.checkout.voidSale({ originalSaleId: sale.id, reason: 'customer left' });
    expect(vd.total).toBe(-(3 * price - 75_00));
    await expectCode(
      s.checkout.voidSale({ originalSaleId: sale.id, reason: 'x' }),
      'ALREADY_RETURNED',
    );
    const after = (await s.catalog.search('CBL-C-1M'))[0];
    expect(after?.kind === 'variant' ? after.item.onHand : -1).toBe(onHand);
    const [summary] = await s.checkout.listInvoices({ q: sale.invoiceNo });
    expect(summary?.returnedTotal).toBe(4 * price - 100_00);

    await expect(
      driver.batch([{ sql: 'UPDATE sales SET note = ?', params: ['tamper'] }]),
    ).rejects.toThrow('immutable');
    await expect(driver.batch([{ sql: 'DELETE FROM stock_movements' }])).rejects.toThrow(
      'append-only',
    );
    expect(await s.integrity.verifyChain()).toMatchObject({ ok: true });
    expect(await s.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
      badPhoneUnits: 0,
    });
  });

  it('cashier needs a manager PIN to return', async () => {
    const { s } = await demo();
    await s.auth.login('cashier', '3456');
    const [inv] = await s.checkout.listInvoices({ kind: 'sale' });
    if (!inv) throw new Error('no invoice');
    await expectCode(
      s.checkout.voidSale({ originalSaleId: inv.id, reason: 'x' }),
      'APPROVAL_REQUIRED',
    );
    const g = await s.auth.requestApproval('1234');
    const vd = await s.checkout.voidSale({
      originalSaleId: inv.id,
      reason: 'x',
      approvalToken: g.token,
    });
    expect(vd.kind).toBe('void');
  });

  it('receives stock from a supplier and keeps the supplier ledger', async () => {
    const { s } = await demo();
    await s.auth.login('manager', '2345');
    const [sup] = await s.purchasing.listSuppliers();
    if (!sup) throw new Error('no supplier');
    const v = (await s.catalog.search('MEM-64'))[0];
    if (!v || v.kind !== 'variant') throw new Error('no card');
    const r = await s.purchasing.receive({
      supplierId: sup.party.id,
      referenceNo: 'INV-77',
      phones: [
        {
          product: { brand: 'Vivo', name: 'Y28' },
          imei1: '356938035643809',
          ptaStatus: 'approved',
          condition: 'new',
          costPrice: 40000_00,
          salePrice: 43000_00,
        },
      ],
      accessories: [{ variantId: v.item.variant.id, quantity: 10, unitCost: 850_00 }],
      paidNow: { amount: 20000_00, method: 'cash' },
    });
    expect(r.purchase.total).toBe(40000_00 + 8500_00);
    expect(r.supplierBalance).toBe(sup.balance + 48500_00 - 20000_00);
    expect(r.phoneUnitIds).toHaveLength(1);
    const card = (await s.catalog.search('MEM-64'))[0];
    expect(card?.kind === 'variant' ? card.item.onHand : -1).toBe(v.item.onHand + 10);
    expect(await s.purchasing.paySupplier({ supplierId: sup.party.id, amount: 1000_00 })).toBe(
      r.supplierBalance - 1000_00,
    );
    await expectCode(
      s.catalog.createPhoneUnit({
        product: { brand: 'Vivo', name: 'Y28' },
        imei1: '356938035643809',
        ptaStatus: 'approved',
        condition: 'new',
        costPrice: 1,
        salePrice: 1,
      }),
      'DUPLICATE',
    );
  });

  it('daily report adds up', async () => {
    const { s } = await demo();
    await s.auth.login('owner', '1234');
    const r = await s.reports.summary({ fromMs: 0, toMs: Date.now() + 60_000 });
    expect(r.salesCount).toBe(3);
    expect(r.netRevenue).toBe(r.netSales - r.returnsTotal);
    expect(r.byMethod.cash + r.byMethod.jazzcash + r.byMethod.khata).toBe(r.netSales);
    expect(r.lowStock.map((v) => v.variant.sku)).toContain('PWR-20K');
  });
});
