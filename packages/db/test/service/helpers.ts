import { vi, type Mock } from 'vitest';
import {
  isServiceError,
  type AssertCanSell,
  type Invoice,
  type PosService,
  type ServiceError,
  type ServiceErrorCode,
} from '@pos/shared';
import { migrate } from '../../src/migrate';
import {
  createNodeSqliteDriver,
  loadMigrationsFromDir,
  type NodeSqliteDriver,
} from '../../src/node';
import { createPosService } from '../../src/service';
import { BASE_MS, makeIdGenerator } from '../../../core/test/fixtures';

export { count } from '../helpers';

export const PINS = { owner: '1234', mgr: '2345', cash: '3456' } as const;
export type TestUser = keyof typeof PINS;

export const IMEI_X = '356938035643809';
/** A second, Luhn-valid IMEI (GSMA documentation example). */
export const IMEI_Y = '490154203237518';

export const PHONE_COST = 7_800_000;
export const PHONE_PRICE = 8_500_000;
export const CHARGER_COST = 90_000;
export const CHARGER_PRICE = 150_000;
export const CREDIT_LIMIT = 5_000_000;

export interface TestIds {
  deviceId: string;
  branchId: string;
  ownerId: string;
  managerId: string;
  cashierId: string;
  /** Phone unit X. */
  phoneId: string;
  /** Charger variant C. */
  chargerId: string;
  /** Customer Bilal. */
  bilalId: string;
}

export interface TestClock {
  /** Next value (and then steps +1000 ms). */
  now(): number;
  /** Moves time forward without consuming a tick. */
  advance(ms: number): void;
  /** Value `now()` would return next. */
  peek(): number;
}

export interface TestService {
  svc: PosService;
  driver: NodeSqliteDriver;
  ids: TestIds;
  clock: TestClock;
  /** Licence hook spy (resolves by default). Call history is cleared after seeding. */
  assertCanSell: Mock<AssertCanSell>;
  /** Mints a fresh deterministic UUID v7 (same generator the service uses). */
  newId: () => string;
  /** Logs in as owner / mgr / cash. */
  loginAs(user: TestUser): Promise<void>;
}

export interface MakeServiceOptions {
  /** false = migrated but empty database, nothing seeded and nobody logged in. */
  seed?: boolean;
}

/**
 * In-memory service over a migrated database with a stepping clock (+1000 ms per call),
 * a deterministic id generator, 1000 PBKDF2 iterations and a licence-hook spy.
 * Seeded (as owner): manager mgr/2345, cashier cash/3456, phone X, charger C (10 on hand, reorder 3),
 * customer Bilal (credit limit Rs 50,000). Ends logged out.
 */
export async function makeService(options: MakeServiceOptions = {}): Promise<TestService> {
  const driver = createNodeSqliteDriver(':memory:');
  await migrate(driver, loadMigrationsFromDir());

  let t = BASE_MS;
  const clock: TestClock = {
    now: () => {
      const v = t;
      t += 1000;
      return v;
    },
    advance: (ms) => {
      t += ms;
    },
    peek: () => t,
  };
  const newId = makeIdGenerator(5, BASE_MS + 1_000_000);
  const assertCanSell = vi.fn<AssertCanSell>(() => Promise.resolve());
  const svc = createPosService({
    driver,
    assertCanSell,
    clock: () => clock.now(),
    newId,
    pinIterations: 1000,
  });
  const loginAs = async (user: TestUser): Promise<void> => {
    await svc.auth.login(user, PINS[user]);
  };

  if (options.seed === false) {
    return {
      svc,
      driver,
      ids: {} as TestIds,
      clock,
      assertCanSell,
      newId,
      loginAs,
    };
  }

  const shop = await svc.setup.firstRun({
    shopName: 'Test Mobile Centre',
    branchName: 'Main Counter',
    invoicePrefix: 'A',
    owner: { username: 'owner', displayName: 'Owner', pin: PINS.owner },
  });
  await loginAs('owner');
  const manager = await svc.auth.createUser({
    username: 'mgr',
    displayName: 'Manager',
    role: 'manager',
    pin: PINS.mgr,
  });
  const cashier = await svc.auth.createUser({
    username: 'cash',
    displayName: 'Cashier',
    role: 'cashier',
    pin: PINS.cash,
  });
  const phone = await svc.catalog.createPhoneUnit({
    product: { brand: 'Samsung', name: 'Galaxy A55', category: 'Smartphone' },
    imei1: IMEI_X,
    ptaStatus: 'approved',
    condition: 'new',
    costPrice: PHONE_COST,
    salePrice: PHONE_PRICE,
  });
  const charger = await svc.catalog.createAccessory({
    product: { brand: 'Generic', name: 'Fast Charger 25W', category: 'Charger' },
    sku: 'CHG-25W',
    barcode: '8961234567890',
    costPrice: CHARGER_COST,
    salePrice: CHARGER_PRICE,
    reorderLevel: 3,
    openingQty: 10,
  });
  const bilal = await svc.khata.createCustomer({
    name: 'Bilal',
    phone: '03001234567',
    creditLimit: CREDIT_LIMIT,
  });
  const session = svc.auth.current();
  if (session === null) throw new Error('seed: owner session missing');
  svc.auth.logout();
  assertCanSell.mockClear();

  return {
    svc,
    driver,
    ids: {
      deviceId: shop.deviceId,
      branchId: shop.branchId,
      ownerId: session.user.id,
      managerId: manager.id,
      cashierId: cashier.id,
      phoneId: phone.unit.id,
      chargerId: charger.variant.id,
      bilalId: bilal.id,
    },
    clock,
    assertCanSell,
    newId,
    loginAs,
  };
}

// ---------------------------------------------------------------------------------------------
// Small assertion / query helpers
// ---------------------------------------------------------------------------------------------

/** Awaits `p`, expects a ServiceError and returns it for further assertions. */
export async function captureError(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p;
  } catch (e) {
    if (isServiceError(e)) return e;
    throw new Error(`Expected a ServiceError but got: ${String(e)}`);
  }
  throw new Error('Expected a ServiceError but the call succeeded');
}

export async function expectCode(
  p: Promise<unknown>,
  code: ServiceErrorCode,
): Promise<ServiceError> {
  const e = await captureError(p);
  if (e.code !== code) {
    throw new Error(
      `Expected ${code} but got ${e.code}: ${e.message} ${JSON.stringify(e.details)}`,
    );
  }
  return e;
}

/** Sum of stock_movements.quantity for a phone unit or an accessory variant. */
export async function stockSum(
  driver: NodeSqliteDriver,
  target: { phoneUnitId: string } | { variantId: string },
): Promise<number> {
  const [col, id] =
    'phoneUnitId' in target
      ? (['phone_unit_id', target.phoneUnitId] as const)
      : (['variant_id', target.variantId] as const);
  const rows = await driver.query<{ n: number }>(
    `select coalesce(sum(quantity), 0) as n from stock_movements where ${col} = ?`,
    [id],
  );
  return rows[0]?.n ?? 0;
}

export interface Counts {
  sales: number;
  sale_lines: number;
  payments: number;
  stock_movements: number;
  ledger_entries: number;
  outbox: number;
}

/** Row counts of every table a business operation may touch (for "nothing was written" assertions). */
export async function snapshotCounts(driver: NodeSqliteDriver): Promise<Counts> {
  const out: Record<string, number> = {};
  for (const table of [
    'sales',
    'sale_lines',
    'payments',
    'stock_movements',
    'ledger_entries',
    'outbox',
  ]) {
    const rows = await driver.query<{ n: number }>(`select count(*) as n from ${table}`);
    out[table] = rows[0]?.n ?? 0;
  }
  return out as unknown as Counts;
}

/** Commit helper: one cash payment equal to `total`. */
export async function sellCash(
  t: TestService,
  lines: { phoneUnitId?: string; variantId?: string; quantity: number; discountAmount?: number }[],
  extra: { customerId?: string; invoiceDiscount?: number; saleId?: string } = {},
): Promise<Invoice> {
  const preview = await t.svc.checkout.preview({ lines, ...extra });
  return t.svc.checkout.commit({
    lines,
    ...extra,
    payments: [{ method: 'cash', amount: preview.total }],
  });
}

export const first = <T>(xs: readonly T[], what = 'item'): T => {
  const x = xs[0];
  if (x === undefined) throw new Error(`Expected at least one ${what}`);
  return x;
};
