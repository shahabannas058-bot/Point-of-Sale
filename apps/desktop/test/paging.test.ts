import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { migrate, migrationsFromFiles } from '@pos/db';
import { createPosService } from '@pos/db/service';
import type { PosService } from '@pos/shared';
import { createSqlJsDriver } from '../src/db/sqljs-driver';
import { loadAllPages, nextPageCursor } from '../src/lib/paging';

const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const row = (id: string, createdAt: number) => ({ id, createdAt });
const at = (r: { id: string; createdAt: number }) => r;

describe('nextPageCursor', () => {
  it('points after the last row of a full page', () => {
    expect(nextPageCursor([row('b', 20), row('a', 10)], 2, at)).toEqual({
      beforeCreatedAt: 10,
      beforeId: 'a',
    });
  });

  it('is null after a short page: nothing older is left', () => {
    expect(nextPageCursor([row('a', 10)], 2, at)).toBeNull();
    expect(nextPageCursor([], 2, at)).toBeNull();
  });
});

describe('loadAllPages', () => {
  it('follows the cursor until a short page', async () => {
    const all = [row('e', 5), row('d', 4), row('c', 3), row('b', 2), row('a', 1)];
    const asked: unknown[] = [];
    const rows = await loadAllPages(
      (c) => {
        asked.push(c);
        const from = all.findIndex((r) => r.createdAt < c.beforeCreatedAt);
        return Promise.resolve(from < 0 ? [] : all.slice(from, from + 2));
      },
      nextPageCursor(all.slice(0, 2), 2, at),
      2,
      at,
    );
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(asked).toHaveLength(2);
  });

  it('asks nothing when there is no cursor', async () => {
    const rows = await loadAllPages(() => Promise.reject(new Error('no')), null, 2, at);
    expect(rows).toEqual([]);
  });
});

/** The cursors the screens build reach every row of the real service (QA#9). */
describe('paging against the service on sql.js', () => {
  async function shop(): Promise<{ svc: PosService; itemId: string; customerId: string }> {
    const SQL = await initSqlJs();
    const driver = createSqlJsDriver(new SQL.Database());
    await migrate(driver, migrationsFromFiles(files));
    const svc = createPosService({ driver, pinIterations: 1000 });
    await svc.setup.firstRun({
      shopName: 'Test Kiryana',
      branchName: 'Main',
      invoicePrefix: 'K',
      owner: { username: 'owner', displayName: 'Owner', pin: '1234' },
      businessType: 'kiryana',
    });
    await svc.auth.login('owner', '1234');
    const item = await svc.catalog.createItem({
      product: { brand: 'Shan', name: 'Masala' },
      sku: 'SHAN',
      costPrice: 5_000,
      salePrice: 10_000,
      openingQty: 100,
    });
    const customer = await svc.khata.createCustomer({ name: 'Haji Rafiq' });
    return { svc, itemId: item.item.id, customerId: customer.id };
  }

  it('Sales "Load more" and the customer ledger "Load older" reach the oldest row', async () => {
    const { svc, itemId, customerId } = await shop();
    for (let i = 0; i < 5; i += 1)
      await svc.checkout.commit({
        lines: [{ itemId, quantity: 1 }],
        customerId,
        payments: [{ method: 'khata', amount: 10_000 }],
      });

    const limit = 2;
    const invoiceAt = (r: { id: string; createdAt: number }) => r;
    const first = await svc.checkout.listInvoices({ limit });
    const rest = await loadAllPages(
      (c) => svc.checkout.listInvoices({ limit, ...c }),
      nextPageCursor(first, limit, invoiceAt),
      limit,
      invoiceAt,
    );
    expect(new Set([...first, ...rest].map((r) => r.id)).size).toBe(5);

    const entryAt = (l: { entry: { id: string; createdAt: number } }) => l.entry;
    const page = await svc.khata.getLedger(customerId, { limit });
    const older = await loadAllPages(
      async (c) => (await svc.khata.getLedger(customerId, { limit, ...c })).lines,
      nextPageCursor(page.lines, limit, entryAt),
      limit,
      entryAt,
    );
    const lines = [...page.lines, ...older];
    expect(lines).toHaveLength(5);
    expect(lines.reduce((a, l) => a + l.entry.amount, 0)).toBe(page.balance);
  });
});
