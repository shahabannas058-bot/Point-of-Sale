import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { migrate, migrationsFromFiles } from '@pos/db';
import { createSqlJsDriver } from '../src/db/sqljs-driver';

const files = import.meta.glob<string>('../../../packages/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

async function open(persist?: (b: Uint8Array) => Promise<void>) {
  const SQL = await initSqlJs();
  return createSqlJsDriver(
    new SQL.Database(),
    persist && { save: persist, reopen: (bytes) => new SQL.Database(bytes) },
  );
}

/** A driver whose next save fails once; `stored` holds the last saved bytes. */
async function openFlaky() {
  const SQL = await initSqlJs();
  const state = { failNext: false, stored: null as Uint8Array | null };
  const driver = createSqlJsDriver(new SQL.Database(), {
    save: async (bytes) => {
      await new Promise((r) => setTimeout(r, 5));
      if (state.failNext) {
        state.failNext = false;
        throw new Error('QuotaExceededError');
      }
      state.stored = bytes;
    },
    reopen: (bytes) => new SQL.Database(bytes),
  });
  const storedIds = (): unknown[] =>
    new SQL.Database(state.stored ?? undefined)
      .exec('SELECT id FROM sales ORDER BY id')[0]
      ?.values.map((v) => v[0]) ?? [];
  return { driver, state, storedIds };
}

const insertSale = (id: string) => [{ sql: 'INSERT INTO sales VALUES (?)', params: [id] }];

describe('sql.js driver (smoke; full conformance lives with qa-tester)', () => {
  it('applies every migration and keeps foreign keys + recursive triggers on', async () => {
    const driver = await open();
    const applied = await migrate(driver, migrationsFromFiles(files));
    expect(applied.length).toBeGreaterThanOrEqual(4);
    const fk = await driver.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(fk[0]?.foreign_keys).toBe(1);
    const rt = await driver.query<{ recursive_triggers: number }>('PRAGMA recursive_triggers');
    expect(rt[0]?.recursive_triggers).toBe(1);
  });

  it('re-applies pragmas after export (export resets them)', async () => {
    const driver = await open();
    driver.exportBytes();
    const fk = await driver.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(fk[0]?.foreign_keys).toBe(1);
  });

  it('batch is atomic: a failing statement rolls the whole batch back', async () => {
    const driver = await open();
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    await expect(
      driver.batch([
        { sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [1, 'a'] },
        { sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [2, null] },
      ]),
    ).rejects.toThrow();
    expect(await driver.query('SELECT * FROM t')).toHaveLength(0);
    await driver.batch([{ sql: 'INSERT INTO t (id, v) VALUES (?, ?)', params: [1, 'a'] }]);
    expect(await driver.query('SELECT * FROM t')).toHaveLength(1);
  });

  it('awaits persistence before a write resolves and coalesces concurrent writes', async () => {
    let calls = 0;
    let lastBytes = 0;
    const driver = await open(async (bytes) => {
      calls += 1;
      lastBytes = bytes.length;
      await new Promise((r) => setTimeout(r, 5));
    });
    await driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const before = calls;
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        driver.batch([{ sql: 'INSERT INTO t (id) VALUES (?)', params: [i] }]),
      ),
    );
    expect(calls - before).toBeLessThanOrEqual(2);
    expect(lastBytes).toBeGreaterThan(0);
    expect((await driver.query('SELECT * FROM t')).length).toBe(4);
  });

  it('a write whose save failed is undone in memory too, so a retry does not store it twice (QA#18)', async () => {
    const { driver, state, storedIds } = await openFlaky();
    await driver.exec('CREATE TABLE sales (id TEXT PRIMARY KEY)');

    state.failNext = true;
    await expect(driver.batch(insertSale('sale-1'))).rejects.toThrow('QuotaExceededError');
    expect(await driver.query('SELECT id FROM sales')).toEqual([]);

    await driver.batch(insertSale('sale-2'));
    expect(storedIds()).toEqual(['sale-2']);
    expect(await driver.query('SELECT id FROM sales')).toEqual([{ id: 'sale-2' }]);
    const fk = await driver.query<{ foreign_keys: number }>('PRAGMA foreign_keys');
    expect(fk[0]?.foreign_keys).toBe(1);
  });

  it('a write committed while a failing save was in flight is rejected too, not reported as saved', async () => {
    const { driver, state, storedIds } = await openFlaky();
    await driver.exec('CREATE TABLE sales (id TEXT PRIMARY KEY)');

    state.failNext = true;
    const first = driver.batch(insertSale('sale-1'));
    await new Promise((r) => setTimeout(r, 1)); // the first save is now running
    const second = driver.batch(insertSale('sale-2'));
    await expect(first).rejects.toThrow('QuotaExceededError');
    await expect(second).rejects.toThrow();

    await driver.batch(insertSale('sale-3'));
    expect(storedIds()).toEqual(['sale-3']);
  });
});
