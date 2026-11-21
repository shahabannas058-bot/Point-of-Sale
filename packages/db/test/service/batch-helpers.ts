import { formatModuleList, type ModuleId, type ItemView } from '@pos/shared';
import { META, upsertMeta } from '../../src/service/meta';
import { PINS, makeService, type TestService } from './helpers';

const DAY = 86_400_000;
const PKT_OFFSET = 5 * 3_600_000; // Pakistan time, UTC+5
/** Calendar date (YYYY-MM-DD) in Pakistan time. Deliberately re-implemented here to cross-check the service. */
export const ymd = (ms: number): string => new Date(ms + PKT_OFFSET).toISOString().slice(0, 10);
/** The date `n` days from the test clock's now (negative = in the past). */
export const inDays = (t: TestService, n: number): string => ymd(t.clock.peek() + n * DAY);

/** An empty kiryana shop with an owner and a cashier; the owner is logged in. */
export async function shopOf(): Promise<TestService> {
  const t = await makeService({ seed: false });
  await t.svc.setup.firstRun({
    shopName: 'Test Store',
    branchName: 'Main',
    invoicePrefix: 'K',
    owner: { username: 'owner', displayName: 'Owner', pin: PINS.owner },
  });
  await t.loginAs('owner');
  await t.svc.auth.createUser({
    username: 'cash',
    displayName: 'Cashier',
    role: 'cashier',
    pin: PINS.cash,
  });
  return t;
}

/** Replaces the shop's module list, as a licence that grants fewer modules would. */
export async function setModules(t: TestService, modules: readonly ModuleId[]): Promise<void> {
  await t.driver.batch([upsertMeta(META.modules, formatModuleList(modules))]);
}

export async function addMilk(t: TestService): Promise<ItemView> {
  return t.svc.catalog.createItem({
    product: { brand: 'Olpers', name: 'Milk 1L' },
    sku: 'MILK-1L',
    costPrice: 29_000,
    salePrice: 32_000,
    reorderLevel: 2,
  });
}

export async function addSupplier(t: TestService): Promise<string> {
  return (await t.svc.purchasing.createSupplier({ name: 'Dairy Distributors' })).id;
}

export interface Delivery {
  qty: number;
  days: number;
  batchNo?: string | null;
}
/** One purchase with one line per delivery; read the batches back with `batches.list`. */
export async function receive(
  t: TestService,
  itemId: string,
  deliveries: Delivery[],
): Promise<void> {
  const supplierId = await addSupplier(t);
  await t.svc.purchasing.receive({
    supplierId,
    items: deliveries.map((d) => ({
      itemId,
      quantity: d.qty,
      unitCost: 29_000,
      batch: { batchNo: d.batchNo ?? null, expiryDate: inDays(t, d.days) },
    })),
  });
}

export const batchOnHand = async (t: TestService, batchNo: string): Promise<number> =>
  (await t.svc.batches.list()).find((b) => b.batchNo === batchNo)?.onHand ?? 0;

/** Sum of every batch's stock (empty batches included) for one item, straight from the ledger. */
export async function batchedOnHand(t: TestService, itemId: string): Promise<number> {
  const rows = await t.driver.query<{ n: number }>(
    `SELECT COALESCE(SUM(sm.quantity), 0) AS n FROM stock_movements sm
     JOIN stock_batches sb ON sb.id = sm.batch_id WHERE sm.item_id = ?`,
    [itemId],
  );
  return rows[0]?.n ?? 0;
}
