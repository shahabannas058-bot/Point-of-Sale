import { expect } from 'vitest';
import { isServiceError, type PosService, type ServiceErrorCode } from '@pos/shared';
import { createPosService, mapError, seedDemoData } from '../src/service';
import type { SqlValue } from '../src';
import { migratedDriver } from './node-driver';

export type TestDriver = Awaited<ReturnType<typeof migratedDriver>>;

/** Demo shop on in-memory SQLite. `clock` drives ctx.now() so tests can move time forward. */
export async function demoShop(): Promise<{
  s: PosService;
  driver: TestDriver;
  clock: { now: number };
}> {
  const driver = await migratedDriver();
  await seedDemoData({ driver });
  const clock = { now: Date.now() + 1_000 };
  return { s: createPosService({ driver, now: () => clock.now }), driver, clock };
}

export async function expectCode(p: Promise<unknown>, code: ServiceErrorCode): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isServiceError(e) ? e.code : e).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Runs raw SQL and maps the driver error the way the service does. */
export const rawSql = (
  driver: TestDriver,
  sql: string,
  params: SqlValue[] = [],
): Promise<unknown> =>
  driver.query(sql, params).catch((e: unknown) => {
    throw mapError(e);
  });
