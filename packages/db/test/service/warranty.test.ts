import { beforeEach, describe, expect, it } from 'vitest';
import { ServiceError, type Invoice } from '@pos/shared';
import { IMEI_X, expectCode, makeService, sellCash, type TestService } from './helpers';

const DAY = 86_400_000;

let t: TestService;
let sale: Invoice;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('owner');
  sale = await sellCash(t, [{ phoneUnitId: t.ids.phoneId, quantity: 1 }]);
});

const reg = (over: Record<string, unknown> = {}) =>
  t.svc.warranty.register({
    saleId: sale.id,
    phoneUnitId: t.ids.phoneId,
    kind: 'shop',
    days: 30,
    ...over,
  });

describe('warranty: register', () => {
  it('starts at the sale date and ends after `days` or at an explicit date', async () => {
    const shop = await reg({ note: 'Shop 30 days' });
    expect(shop).toMatchObject({
      saleId: sale.id,
      phoneUnitId: t.ids.phoneId,
      kind: 'shop',
      startsAt: sale.createdAt,
      endsAt: sale.createdAt + 30 * DAY,
      note: 'Shop 30 days',
      createdBy: t.ids.ownerId,
    });
    const company = await reg({
      kind: 'company',
      days: undefined,
      endsAt: sale.createdAt + 365 * DAY,
    });
    expect(company.endsAt).toBe(sale.createdAt + 365 * DAY);
  });

  it('allows a cashier, rejects a duplicate kind and bad arguments', async () => {
    t.svc.auth.logout();
    await t.loginAs('cash');
    await reg();
    await expectCode(reg(), 'DUPLICATE');
    await expectCode(reg({ kind: 'company', days: undefined }), 'VALIDATION'); // neither days nor endsAt
    await expectCode(reg({ kind: 'company', endsAt: sale.createdAt + DAY }), 'VALIDATION'); // both
    await expectCode(reg({ kind: 'company', days: 0 }), 'VALIDATION');
    await expectCode(reg({ kind: 'lifetime' }), 'VALIDATION');
    await expectCode(
      reg({ kind: 'company', days: undefined, endsAt: sale.createdAt }),
      'VALIDATION',
    );
  });

  it('only for a phone that is on a sale invoice', async () => {
    await expectCode(reg({ saleId: t.newId() }), 'NOT_FOUND');
    const other = await t.svc.catalog.createPhoneUnit({
      product: { brand: 'Infinix', name: 'Hot 40' },
      imei1: '490154203237518',
      ptaStatus: 'approved',
      condition: 'new',
      costPrice: 1_000_000,
      salePrice: 1_200_000,
    });
    await expectCode(reg({ phoneUnitId: other.unit.id }), 'VALIDATION');
  });

  it('is append-only and logs to the outbox and the licence hook', async () => {
    const w = await reg();
    await expect(t.driver.query('UPDATE warranties SET note = ?', ['x'])).rejects.toThrow(
      /append-only/,
    );
    await expect(t.driver.query('DELETE FROM warranties')).rejects.toThrow(/append-only/);
    const out = await t.driver.query<{ payload: string }>(
      "select payload from outbox where entity_type = 'warranty' and entity_id = ?",
      [w.id],
    );
    expect(JSON.parse(out[0]?.payload ?? '{}')).toMatchObject({ id: w.id, kind: 'shop' });
    expect(t.assertCanSell).toHaveBeenCalledWith(expect.objectContaining({ action: 'warranty' }));

    t.assertCanSell.mockImplementation(() =>
      Promise.reject(new ServiceError('LICENCE_BLOCKED', 'Locked', { state: 'LOCKED' })),
    );
    await expectCode(reg({ kind: 'company' }), 'LICENCE_BLOCKED');
    expect(await t.driver.query('select id from warranties')).toHaveLength(1);
  });
});

describe('warranty: lookup', () => {
  it('finds the unit by IMEI and reports active, then expired', async () => {
    await reg();
    await reg({ kind: 'company', days: 365 });
    const first = await t.svc.warranty.lookup(IMEI_X);
    expect(first.sale).toMatchObject({
      saleId: sale.id,
      invoiceNo: sale.invoiceNo,
      returned: false,
    });
    expect(first.warranties.map((w) => [w.warranty.kind, w.state, w.daysLeft])).toEqual([
      ['company', 'active', 365],
      ['shop', 'active', 30],
    ]);

    t.clock.advance(31 * DAY);
    const later = await t.svc.warranty.lookup(IMEI_X);
    expect(later.warranties.map((w) => [w.warranty.kind, w.state, w.daysLeft])).toEqual([
      ['company', 'active', 334],
      ['shop', 'expired', 0],
    ]);
  });

  it('answers for a phone that was never sold and 404s an unknown IMEI', async () => {
    const other = await t.svc.catalog.createPhoneUnit({
      product: { brand: 'Infinix', name: 'Hot 40' },
      imei1: '490154203237518',
      ptaStatus: 'approved',
      condition: 'new',
      costPrice: 1_000_000,
      salePrice: 1_200_000,
    });
    const r = await t.svc.warranty.lookup('490154203237518');
    expect(r.unit.unit.id).toBe(other.unit.id);
    expect(r.sale).toBeNull();
    expect(r.warranties).toEqual([]);
    await expectCode(t.svc.warranty.lookup('000000000000000'), 'NOT_FOUND');
    await expectCode(t.svc.warranty.lookup('  '), 'VALIDATION');
  });

  it('voids the warranty once the sale is returned', async () => {
    await reg();
    await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'Customer changed mind' });
    const r = await t.svc.warranty.lookup(IMEI_X);
    expect(r.sale?.returned).toBe(true);
    expect(r.warranties.map((w) => [w.state, w.daysLeft])).toEqual([['void', 0]]);
    await expectCode(reg({ kind: 'company' }), 'VALIDATION'); // returned phone
  });
});

describe('warranty: expiring soon', () => {
  it('lists active warranties ending within the window, soonest first, with sale details', async () => {
    await reg({ days: 10 });
    await reg({ kind: 'company', days: 200 });
    const soon = await t.svc.warranty.listExpiring(30);
    expect(soon).toHaveLength(1);
    expect(soon[0]).toMatchObject({
      imei: IMEI_X,
      invoiceNo: sale.invoiceNo,
      customerName: null,
      unitLabel: expect.stringContaining('Galaxy A55') as string,
    });
    expect(soon[0]?.status).toMatchObject({ state: 'active', warranty: { kind: 'shop' } });

    const both = await t.svc.warranty.listExpiring(365);
    expect(both.map((e) => e.status.warranty.kind)).toEqual(['shop', 'company']);

    t.clock.advance(20 * DAY);
    expect(await t.svc.warranty.listExpiring(30)).toEqual([]); // the 10-day one has expired
    await expectCode(t.svc.warranty.listExpiring(-1), 'VALIDATION');
  });

  it('skips warranties of returned sales', async () => {
    await reg({ days: 10 });
    await t.svc.checkout.voidSale({ originalSaleId: sale.id, reason: 'Returned' });
    expect(await t.svc.warranty.listExpiring(30)).toEqual([]);
  });
});
