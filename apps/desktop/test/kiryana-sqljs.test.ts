import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { migrate, migrationsFromFiles } from '@pos/db';
import { createPosService } from '@pos/db/service';
import { isServiceError, pktDate, type BusinessType, type PosService } from '@pos/shared';
import { createSqlJsDriver } from '../src/db/sqljs-driver';

/**
 * The desktop app runs on sql.js (and later on native SQLite in Tauri), while the @pos/db tests run on Node's
 * SQLite. Migration 0006 rebuilds sale_lines and adds triggers, so the kiryana flow is checked on this engine too.
 */
const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

async function shopOf(type: BusinessType): Promise<PosService> {
  const SQL = await initSqlJs();
  const driver = createSqlJsDriver(new SQL.Database());
  await migrate(driver, migrationsFromFiles(files));
  const svc = createPosService({ driver, pinIterations: 1000 });
  await svc.setup.firstRun({
    shopName: 'Test Kiryana',
    branchName: 'Main',
    invoicePrefix: 'K',
    owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
    businessType: type,
  });
  await svc.auth.login('owner', '1234');
  return svc;
}

describe('kiryana on sql.js', () => {
  it('migrates to version 6 and sells loose goods by weight with exact, rounded totals', async () => {
    const svc = await shopOf('kiryana');
    const chini = await svc.catalog.createAccessory({
      product: { brand: 'Loose', name: 'Chini (sugar)' },
      sku: 'CHINI',
      costPrice: 25_000,
      salePrice: 28_550,
      openingQty: 50_000,
      unit: 'kg',
    });
    expect(chini.variant).toMatchObject({ unitScale: 1000, unitLabel: 'kg' });

    const lines = [{ variantId: chini.variant.id, quantity: 1250 }];
    const preview = await svc.checkout.preview({ lines });
    expect(preview.total).toBe(35_688); // 1.25 kg x Rs 285.50 = 35,687.5 paisa, half away from zero
    const invoice = await svc.checkout.commit({
      lines,
      payments: [{ method: 'cash', amount: preview.total }],
    });
    expect(invoice).toMatchObject({ total: 35_688, hashVersion: 2 });
    expect(invoice.lines[0]).toMatchObject({ quantity: 1250, unitScale: 1000 });

    const ret = await svc.checkout.createReturn({
      originalSaleId: invoice.id,
      lines: [{ lineId: invoice.lines[0]!.id, quantity: 500 }],
      refund: [{ method: 'cash', amount: 14_275 }],
      reason: 'kharab',
    });
    expect(ret.total).toBe(-14_275);

    const after = await svc.catalog.listAccessories({ q: 'CHINI' });
    expect(after[0]?.onHand).toBe(49_250);
    expect(await svc.integrity.verifyChain()).toMatchObject({ ok: true, count: 2 });
    expect(await svc.integrity.checks()).toMatchObject({
      salePaymentMismatch: 0,
      saleLineMismatch: 0,
    });
  });

  it('sells the batch that expires first, skips an expired one, and returns goods to their batch', async () => {
    const svc = await shopOf('kiryana');
    const milk = await svc.catalog.createAccessory({
      product: { brand: 'Olpers', name: 'Milk 1L' },
      sku: 'MILK',
      costPrice: 29_000,
      salePrice: 32_000,
    });
    const day = (n: number): string => pktDate(Date.now() + n * 86_400_000);
    const supplier = await svc.purchasing.createSupplier({ name: 'Dairy' });
    const line = (quantity: number, days: number, batchNo: string) => ({
      variantId: milk.variant.id,
      quantity,
      unitCost: 29_000,
      batch: { batchNo, expiryDate: day(days) },
    });
    await svc.purchasing.receive({
      supplierId: supplier.id,
      phones: [],
      accessories: [line(5, -2, 'OLD'), line(10, 20, 'LATE'), line(4, 5, 'SOON')],
    });

    const sale = await svc.checkout.preview({
      lines: [{ variantId: milk.variant.id, quantity: 6 }],
    });
    const invoice = await svc.checkout.commit({
      lines: [{ variantId: milk.variant.id, quantity: 6 }],
      payments: [{ method: 'cash', amount: sale.total }],
    });
    const left = async (): Promise<Record<string, number>> =>
      Object.fromEntries((await svc.batches.list()).map((b) => [b.batchNo ?? '', b.onHand]));
    expect(await left()).toEqual({ OLD: 5, LATE: 8 }); // SOON (4) then 2 from LATE; OLD is never touched

    const back = [{ lineId: invoice.lines[0]!.id, quantity: 5 }];
    const preview = await svc.checkout.previewReturn(invoice.id, back);
    await svc.checkout.createReturn({
      originalSaleId: invoice.id,
      lines: back,
      refund: preview.suggestedRefund.map((p) => ({ method: p.method, amount: -p.amount })),
      reason: 'kharab',
    });
    expect(await left()).toEqual({ OLD: 5, SOON: 4, LATE: 9 });

    const short = await svc.checkout
      .preview({ lines: [{ variantId: milk.variant.id, quantity: 14 }] })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isServiceError(short) && short.code).toBe('STOCK_INSUFFICIENT');
    expect(isServiceError(short) && short.details).toMatchObject({ expiredOnHand: 5 });
  });

  it('refuses modules the shop does not own', async () => {
    const svc = await shopOf('kiryana');
    const refused = await svc.repairs.list().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isServiceError(refused) && refused.code).toBe('MODULE_DISABLED');
  });
});
