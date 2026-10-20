import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_QUICK_ITEMS } from '@pos/shared';
import { expectCode, first, makeService, sellCash, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
});

describe('reports.adjustments', () => {
  it('needs view_reports and a sane range', async () => {
    await t.loginAs('cash');
    await expectCode(t.svc.reports.adjustments(), 'FORBIDDEN');
    t.svc.auth.logout();
    await t.loginAs('mgr');
    await expectCode(t.svc.reports.adjustments({ from: 10, to: 5 }), 'VALIDATION');
    await expectCode(t.svc.reports.adjustments({ limit: 1.5 }), 'VALIDATION');
  });

  it('lists only adjustments, newest first, with stock before and after and who did it', async () => {
    await t.loginAs('owner');
    const from = t.clock.peek();
    const c = t.ids.chargerId;
    await t.svc.catalog.adjustStock({ variantId: c, delta: -2, reason: 'Toota hua' });
    await sellCash(t, [{ variantId: c, quantity: 3 }]); // a sale is not an adjustment
    t.svc.auth.logout();
    await t.loginAs('mgr');
    await t.svc.catalog.adjustStock({ variantId: c, delta: 4, reason: 'Ginti theek ki' });

    const page = await t.svc.reports.adjustments({ from });
    expect(
      page.entries.map((e) => [e.quantity, e.balanceBefore, e.balanceAfter, e.reason]),
    ).toEqual([
      [4, 5, 9, 'Ginti theek ki'],
      [-2, 10, 8, 'Toota hua'],
    ]);
    const [latest, older] = page.entries;
    expect(latest?.by.displayName).toBe('Manager');
    expect(older?.by.displayName).toBe('Owner');
    expect(latest?.item).toEqual({ variantId: c });
    expect(latest?.label).toContain('Charger');
    expect(latest?.unitScale).toBe(1);
    expect(latest?.unitLabel).toBe('pcs');
    expect(latest?.repair).toBeNull();
    expect(page.summary).toEqual({ count: 2, increases: 1, decreases: 1 });
    expect(page.nextBefore).toBeNull();
  });

  it('includes opening stock and filters by text', async () => {
    await t.loginAs('owner');
    const all = await t.svc.reports.adjustments();
    expect(all.entries.length).toBeGreaterThan(0); // the seeded phone and charger came in as opening stock
    const from = t.clock.peek();
    await t.svc.catalog.adjustStock({ variantId: t.ids.chargerId, delta: -1, reason: 'Chori' });
    const hit = await t.svc.reports.adjustments({ from, q: 'chori' });
    expect(hit.entries).toHaveLength(1);
    const miss = await t.svc.reports.adjustments({ from, q: 'nothing like this' });
    expect(miss.entries).toEqual([]);
    expect(miss.summary.count).toBe(0);
  });

  it('pages with a cursor while the summary covers the whole query', async () => {
    await t.loginAs('owner');
    const from = t.clock.peek();
    for (let i = 1; i <= 3; i += 1)
      await t.svc.catalog.adjustStock({
        variantId: t.ids.chargerId,
        delta: i,
        reason: `Step ${i}`,
      });
    const p1 = await t.svc.reports.adjustments({ from, limit: 2 });
    expect(p1.entries.map((e) => e.reason)).toEqual(['Step 3', 'Step 2']);
    expect(p1.summary.count).toBe(3);
    expect(p1.nextBefore).not.toBeNull();
    const p2 = await t.svc.reports.adjustments({
      from,
      limit: 2,
      before: p1.nextBefore ?? undefined,
    });
    expect(p2.entries.map((e) => e.reason)).toEqual(['Step 1']);
    expect(p2.nextBefore).toBeNull();
  });

  it('marks spare parts used in a repair', async () => {
    await t.loginAs('owner');
    const from = t.clock.peek();
    const ticket = await t.svc.repairs.create({
      deviceBrand: 'Samsung',
      deviceModel: 'A55',
      problem: 'Charging port',
      walkIn: { name: 'Ali' },
      estimatedCost: 100_000,
    });
    await t.svc.repairs.setStatus({ ticketId: ticket.ticket.id, status: 'in_repair' });
    await t.svc.repairs.addPart({
      ticketId: ticket.ticket.id,
      variantId: t.ids.chargerId,
      quantity: 1,
    });
    const page = await t.svc.reports.adjustments({ from });
    expect(first(page.entries).repair).toEqual({
      ticketId: ticket.ticket.id,
      ticketNo: ticket.ticket.ticketNo,
    });
  });
});

describe('catalog quick items', () => {
  it('starts empty, keeps the pin order and is readable by a cashier', async () => {
    await t.loginAs('owner');
    expect(await t.svc.catalog.quickItems()).toEqual([]);
    const milk = await t.svc.catalog.createAccessory({
      product: { brand: 'Nestle', name: 'Milk Pak' },
      sku: 'MILK-1',
      costPrice: 20_000,
      salePrice: 25_000,
    });
    const saved = await t.svc.catalog.setQuickItems([milk.variant.id, t.ids.chargerId]);
    expect(saved.map((v) => v.variant.id)).toEqual([milk.variant.id, t.ids.chargerId]);
    t.svc.auth.logout();
    await t.loginAs('cash');
    const read = await t.svc.catalog.quickItems();
    expect(read.map((v) => v.variant.id)).toEqual([milk.variant.id, t.ids.chargerId]);
    expect(first(read).onHand).toBe(0);
  });

  it('needs manage_settings to change and rejects bad lists', async () => {
    await t.loginAs('mgr');
    await expectCode(t.svc.catalog.setQuickItems([t.ids.chargerId]), 'FORBIDDEN');
    t.svc.auth.logout();
    await t.loginAs('owner');
    const c = t.ids.chargerId;
    await expectCode(t.svc.catalog.setQuickItems([c, c]), 'VALIDATION');
    await expectCode(t.svc.catalog.setQuickItems(['not-a-uuid']), 'VALIDATION');
    await expectCode(t.svc.catalog.setQuickItems([t.newId()]), 'NOT_FOUND');
    await expectCode(
      t.svc.catalog.setQuickItems(Array.from({ length: MAX_QUICK_ITEMS + 1 }, () => t.newId())),
      'VALIDATION',
    );
    expect(await t.svc.catalog.setQuickItems([])).toEqual([]);
  });
});
