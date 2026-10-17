import { describe, expect, it } from 'vitest';
import type { PosService } from '@pos/shared';
import { demoShop, expectCode, rawSql } from './helpers';

const DAY = 86_400_000;

async function phone(s: PosService, name: string) {
  const hit = (await s.catalog.search(name, { inStockOnly: true })).find(
    (h) => h.kind === 'phone_unit',
  );
  if (!hit || hit.kind !== 'phone_unit') throw new Error(`no ${name}`);
  return hit.item.unit;
}

/** Sells one phone to Bilal for cash and returns the invoice + unit. */
async function sellPhone(s: PosService, name = 'Galaxy A55') {
  const unit = await phone(s, name);
  const bilal = (await s.khata.listCustomers({ q: 'Bilal' }))[0]?.party;
  if (!bilal) throw new Error('no customer');
  const invoice = await s.checkout.commit({
    lines: [{ phoneUnitId: unit.id, quantity: 1 }],
    customerId: bilal.id,
    payments: [{ method: 'cash', amount: unit.salePrice }],
  });
  return { invoice, unit };
}

describe('warranty by IMEI', () => {
  it('registers shop + company warranties on a real sale and looks them up by IMEI', async () => {
    const { s, clock } = await demoShop();
    await s.auth.login('cashier', '3456');
    const { invoice, unit } = await sellPhone(s);

    const shop = await s.warranty.register({
      saleId: invoice.id,
      phoneUnitId: unit.id,
      kind: 'shop',
      days: 30,
      note: 'Checking warranty',
    });
    expect(shop.startsAt).toBe(invoice.createdAt);
    expect(shop.endsAt).toBe(invoice.createdAt + 30 * DAY);
    await s.warranty.register({
      saleId: invoice.id,
      phoneUnitId: unit.id,
      kind: 'company',
      endsAt: invoice.createdAt + 365 * DAY,
    });

    const found = await s.warranty.lookup(unit.imei1 ?? '');
    expect(found.unit.unit.id).toBe(unit.id);
    expect(found.unit.label).toContain('Galaxy A55');
    expect(found.sale).toMatchObject({
      saleId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      soldAt: invoice.createdAt,
      customerName: 'Bilal Ahmed',
      returned: false,
    });
    expect(found.warranties.map((w) => [w.warranty.kind, w.state, w.daysLeft])).toEqual([
      ['company', 'active', 365],
      ['shop', 'active', 30],
    ]);

    // 31 days later the shop warranty has run out, the company one has not
    clock.now += 31 * DAY;
    const later = await s.warranty.lookup(` ${unit.imei1 ?? ''} `);
    expect(later.warranties.map((w) => [w.warranty.kind, w.state, w.daysLeft])).toEqual([
      ['company', 'active', 334],
      ['shop', 'expired', 0],
    ]);
    expect(await s.warranty.listExpiring(30)).toEqual([]);
    const soon = await s.warranty.listExpiring(400);
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({
      invoiceNo: invoice.invoiceNo,
      imei: unit.imei1,
      customerName: 'Bilal Ahmed',
      customerPhone: '03001234567',
      status: { state: 'active', warranty: { kind: 'company' } },
    });
  });

  it('rejects a unit that is not on the sale, duplicates and bad periods', async () => {
    const { s } = await demoShop();
    await s.auth.login('cashier', '3456');
    const { invoice, unit } = await sellPhone(s);
    const other = await phone(s, 'Galaxy S24');
    const charger = (await s.checkout.getInvoice('A-000001')).invoice;

    await expectCode(
      s.warranty.register({ saleId: invoice.id, phoneUnitId: other.id, kind: 'shop', days: 7 }),
      'VALIDATION',
    );
    await expectCode(
      s.warranty.register({ saleId: charger.id, phoneUnitId: unit.id, kind: 'shop', days: 7 }),
      'VALIDATION',
    );
    await expectCode(
      s.warranty.register({
        saleId: '019a0000-0000-7000-8000-00000000dead',
        phoneUnitId: unit.id,
        kind: 'shop',
        days: 7,
      }),
      'NOT_FOUND',
    );
    const base = { saleId: invoice.id, phoneUnitId: unit.id, kind: 'shop' as const };
    await expectCode(s.warranty.register(base), 'VALIDATION');
    await expectCode(
      s.warranty.register({ ...base, days: 7, endsAt: invoice.createdAt + DAY }),
      'VALIDATION',
    );
    await expectCode(s.warranty.register({ ...base, days: 0 }), 'VALIDATION');
    await expectCode(s.warranty.register({ ...base, endsAt: invoice.createdAt }), 'VALIDATION');
    await expectCode(
      s.warranty.register({ ...base, kind: 'lifetime' as 'shop', days: 7 }),
      'VALIDATION',
    );
    await s.warranty.register({ ...base, days: 7 });
    await expectCode(s.warranty.register({ ...base, days: 14 }), 'DUPLICATE');
  });

  it('a returned phone voids its warranty; unknown and unsold units are reported', async () => {
    const { s, driver } = await demoShop();
    await s.auth.login('owner', '1234');
    const { invoice, unit } = await sellPhone(s);
    await s.warranty.register({
      saleId: invoice.id,
      phoneUnitId: unit.id,
      kind: 'shop',
      days: 30,
    });
    const line = invoice.lines[0];
    if (!line) throw new Error('no line');
    await s.checkout.createReturn({
      originalSaleId: invoice.id,
      lines: [{ lineId: line.id, quantity: 1 }],
      refund: [{ method: 'cash', amount: unit.salePrice }],
      reason: 'faulty',
    });
    const after = await s.warranty.lookup(unit.imei1 ?? '');
    expect(after.sale?.returned).toBe(true);
    expect(after.warranties.map((w) => w.state)).toEqual(['void']);
    expect(await s.warranty.listExpiring(60)).toEqual([]);
    await expectCode(
      s.warranty.register({ saleId: invoice.id, phoneUnitId: unit.id, kind: 'company', days: 9 }),
      'VALIDATION',
    );

    const unsold = await phone(s, 'Galaxy S24');
    expect(await s.warranty.lookup(unsold.imei1 ?? '')).toMatchObject({
      sale: null,
      warranties: [],
    });
    await expectCode(s.warranty.lookup('000000000000000'), 'NOT_FOUND');
    await expectCode(s.warranty.lookup('   '), 'VALIDATION');

    await expectCode(
      rawSql(driver, 'UPDATE warranties SET ends_at = ends_at + 1'),
      'IMMUTABLE_RECORD',
    );
    await expectCode(rawSql(driver, 'DELETE FROM warranties'), 'IMMUTABLE_RECORD');
  });

  it('needs a signed-in user', async () => {
    const { s } = await demoShop();
    await expectCode(s.warranty.lookup('123'), 'NOT_AUTHENTICATED');
    await expectCode(s.warranty.listExpiring(30), 'NOT_AUTHENTICATED');
  });
});
