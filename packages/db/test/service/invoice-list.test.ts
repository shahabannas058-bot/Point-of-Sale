import { beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceSummary } from '@pos/shared';
import { expectCode, makeService, sellCash, type TestService } from './helpers';

let t: TestService;
beforeEach(async () => {
  t = await makeService();
  await t.loginAs('owner');
});

const MAX_PAGES = 20;

const sellOne = () => sellCash(t, [{ itemId: t.ids.chargerId, quantity: 1 }]);

/** Loads every page of `size` the way the Sales screen's "Load more" does. */
async function allPages(size: number): Promise<InvoiceSummary[]> {
  const seen: InvoiceSummary[] = [];
  for (let guard = 0; guard < MAX_PAGES; guard += 1) {
    const last = seen.at(-1);
    const page = await t.svc.checkout.listInvoices({
      limit: size,
      ...(last === undefined ? {} : { beforeCreatedAt: last.createdAt, beforeId: last.id }),
    });
    seen.push(...page);
    if (page.length < size) return seen;
  }
  throw new Error('paging did not end');
}

describe('checkout.listInvoices paging (more invoices than the limit)', () => {
  it('pages with beforeCreatedAt + beforeId reach the first invoice of the day', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push((await sellOne()).id);
    const page1 = await t.svc.checkout.listInvoices({ limit: 2 });
    expect(page1.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    expect((await allPages(2)).map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('does not skip or repeat invoices that share a created_at', async () => {
    const ids = [(await sellOne()).id];
    t.clock.advance(-60_000); // clock stepped back: the next invoices keep the head's created_at
    for (let i = 0; i < 4; i += 1) ids.push((await sellOne()).id);
    const rows = await allPages(2);
    expect(new Set(rows.map((r) => r.createdAt)).size).toBe(1);
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
  });

  it('a beforeId that is not text is VALIDATION', async () => {
    await expectCode(
      t.svc.checkout.listInvoices({ beforeCreatedAt: 1, beforeId: 5 as unknown as string }),
      'VALIDATION',
    );
  });
});
