import {
  ServiceError,
  daysBetween,
  hasModule,
  pktDate,
  type BatchesApi,
  type BatchView,
  type ModuleId,
  type UnitLabel,
  type UnitScale,
} from '@pos/shared';
import type { SqlDriver, SqlValue } from '../types';
import { WriteBatch } from './batch';
import { requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, reqText } from './errors';
import { variantLabel } from './mappers';
import { loadShop } from './meta';
import { insertMovement } from './queries';

const DAY_MS = 86_400_000;

export interface BatchRec {
  id: string;
  variantId: string;
  branchId: string;
  batchNo: string | null;
  /** Pakistan calendar date, YYYY-MM-DD. */
  expiryDate: string;
  purchaseId: string | null;
  createdBy: string;
  createdAt: number;
}

export function insertBatch(b: WriteBatch, r: BatchRec): void {
  b.add(
    `INSERT INTO stock_batches (id, variant_id, branch_id, batch_no, expiry_date, purchase_id, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      r.id,
      r.variantId,
      r.branchId,
      r.batchNo,
      r.expiryDate,
      r.purchaseId,
      r.createdBy,
      r.createdAt,
    ],
  ).emit('stock_batch', r.id, 'insert', r);
}

// ---------- stock per batch ----------
interface BatchStock {
  id: string;
  expiryDate: string;
  onHand: number;
}

/** True when the item has ever been received with a batch (so the sale path can skip all batch work otherwise). */
export async function hasBatches(driver: SqlDriver, variantId: string): Promise<boolean> {
  const rows = await driver.query<{ n: number }>(
    'SELECT 1 AS n FROM stock_batches WHERE variant_id = ? LIMIT 1',
    [variantId],
  );
  return rows.length > 0;
}

/** Batches of one item that still hold stock, earliest expiry first. */
async function batchStock(
  driver: SqlDriver,
  variantId: string,
  branchId: string,
): Promise<BatchStock[]> {
  const rows = await driver.query<{ id: string; expiry_date: string; on_hand: number }>(
    `SELECT sb.id AS id, sb.expiry_date AS expiry_date, COALESCE(SUM(sm.quantity), 0) AS on_hand
     FROM stock_batches sb LEFT JOIN stock_movements sm ON sm.batch_id = sb.id
     WHERE sb.variant_id = ? AND sb.branch_id = ?
     GROUP BY sb.id HAVING COALESCE(SUM(sm.quantity), 0) > 0
     ORDER BY sb.expiry_date, sb.created_at, sb.rowid`,
    [variantId, branchId],
  );
  return rows.map((r) => ({ id: r.id, expiryDate: r.expiry_date, onHand: r.on_hand }));
}

/** Units of the item that sit in batches already past their expiry date (so they cannot be sold). */
export async function expiredOnHand(
  driver: SqlDriver,
  variantId: string,
  branchId: string,
  today: string,
): Promise<number> {
  return (await batchStock(driver, variantId, branchId))
    .filter((b) => b.expiryDate < today)
    .reduce((sum, b) => sum + b.onHand, 0);
}

// ---------- allocating sale and return movements to batches ----------
export interface Allocation {
  /** null = stock that belongs to no batch. */
  batchId: string | null;
  /** Positive base units. */
  quantity: number;
}

function addTo(out: Allocation[], batchId: string | null, quantity: number): void {
  if (quantity <= 0) return;
  const same = out.find((a) => a.batchId === batchId);
  if (same === undefined) out.push({ batchId, quantity });
  else same.quantity += quantity;
}

export interface TakeOutOptions {
  /**
   * Whether batches past their expiry date may give stock. A sale or a repair part never takes expired goods; an
   * adjustment may, because throwing expired stock away is exactly what an adjustment is for.
   */
  includeExpired: boolean;
  /** What earlier lines of the same write already took from each batch. */
  taken?: Map<string, number>;
}

/**
 * First expiry, first out. Takes `quantity` from the item's batches, nearest expiry first (skipping expired ones unless
 * `includeExpired`); whatever they cannot cover comes from stock without a batch. Every stock-out of a batch-tracked
 * item (sale, adjustment, repair part) must go through here, so that the sum of the batches' stock keeps matching
 * the item's stock.
 */
export async function allocateTakeOut(
  driver: SqlDriver,
  variantId: string,
  branchId: string,
  quantity: number,
  today: string,
  options: TakeOutOptions,
): Promise<Allocation[]> {
  const taken = options.taken ?? new Map<string, number>();
  const out: Allocation[] = [];
  let remaining = quantity;
  for (const b of await batchStock(driver, variantId, branchId)) {
    if (remaining === 0) break;
    if (!options.includeExpired && b.expiryDate < today) continue;
    const available = b.onHand - (taken.get(b.id) ?? 0);
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    addTo(out, b.id, take);
    taken.set(b.id, (taken.get(b.id) ?? 0) + take);
    remaining -= take;
  }
  addTo(out, null, remaining);
  return out;
}

/**
 * Sale allocation: never from an expired batch. `taken` carries what earlier lines of the same sale already took.
 */
export const allocateSale = (
  driver: SqlDriver,
  variantId: string,
  branchId: string,
  quantity: number,
  today: string,
  taken: Map<string, number>,
): Promise<Allocation[]> =>
  allocateTakeOut(driver, variantId, branchId, quantity, today, { includeExpired: false, taken });

/** True when the shop owns `batch_expiry` and the item has ever been received with a batch. */
export async function isBatchTracked(
  driver: SqlDriver,
  modules: readonly ModuleId[],
  variantId: string,
): Promise<boolean> {
  return hasModule(modules, 'batch_expiry') && (await hasBatches(driver, variantId));
}

/**
 * The parts a stock-out of `quantity` splits into. One part without a batch when the shop has no `batch_expiry`
 * module or the item never had a batch, so such items keep producing exactly one movement as before.
 */
export async function takeOutParts(
  driver: SqlDriver,
  shop: { modules: readonly ModuleId[]; branchId: string },
  variantId: string,
  quantity: number,
  today: string,
  options: TakeOutOptions,
): Promise<Allocation[]> {
  if (!(await isBatchTracked(driver, shop.modules, variantId)))
    return [{ batchId: null, quantity }];
  return allocateTakeOut(driver, variantId, shop.branchId, quantity, today, options);
}

/** Units that cannot leave because they sit in expired batches; 0 when the item is not batch-tracked. */
export async function unsellableExpired(
  driver: SqlDriver,
  shop: { modules: readonly ModuleId[]; branchId: string },
  variantId: string,
  today: string,
): Promise<number> {
  if (!(await isBatchTracked(driver, shop.modules, variantId))) return 0;
  return expiredOnHand(driver, variantId, shop.branchId, today);
}

/**
 * Puts returned goods back into the batches they left from, in the order they left, never more than a batch gave
 * (earlier returns of the same sale are counted). `restored` carries what earlier lines of the same return restored.
 */
export async function allocateReturn(
  driver: SqlDriver,
  originalSaleId: string,
  variantId: string,
  quantity: number,
  restored: Map<string | null, number>,
): Promise<Allocation[]> {
  const sold = await driver.query<{ batch_id: string | null; sold: number }>(
    `SELECT batch_id, -SUM(quantity) AS sold FROM stock_movements
     WHERE type = 'sale' AND ref_type = 'sale' AND ref_id = ? AND variant_id = ?
     GROUP BY batch_id ORDER BY MIN(rowid)`,
    [originalSaleId, variantId],
  );
  const back = await driver.query<{ batch_id: string | null; back: number }>(
    `SELECT sm.batch_id AS batch_id, SUM(sm.quantity) AS back
     FROM stock_movements sm JOIN sales s ON s.id = sm.ref_id
     WHERE sm.type = 'return' AND sm.ref_type = 'sale' AND sm.variant_id = ? AND s.original_sale_id = ?
     GROUP BY sm.batch_id`,
    [variantId, originalSaleId],
  );
  const alreadyBack = new Map(back.map((r) => [r.batch_id, r.back]));
  const out: Allocation[] = [];
  let remaining = quantity;
  for (const s of sold) {
    if (remaining === 0) break;
    const room = s.sold - (alreadyBack.get(s.batch_id) ?? 0) - (restored.get(s.batch_id) ?? 0);
    if (room <= 0) continue;
    const give = Math.min(room, remaining);
    addTo(out, s.batch_id, give);
    restored.set(s.batch_id, (restored.get(s.batch_id) ?? 0) + give);
    remaining -= give;
  }
  addTo(out, null, remaining);
  return out;
}

// ---------- the API ----------
interface BatchRow {
  id: string;
  variant_id: string;
  batch_no: string | null;
  expiry_date: string;
  created_at: number;
  unit_scale: UnitScale;
  unit_label: UnitLabel;
  model: string | null;
  colour: string | null;
  brand: string;
  name: string;
  on_hand: number;
}

export function createBatchesApi(ctx: Ctx): BatchesApi {
  return guardApi<BatchesApi>({
    async list(f = {}) {
      requireSession(ctx);
      const shop = await loadShop(ctx.driver);
      const withinDays =
        f.withinDays === undefined ? null : intIn(f.withinDays, 'withinDays', 0, 3650);
      const today = pktDate(ctx.clock());
      const where = ['sb.branch_id = ?'];
      const params: SqlValue[] = [shop.branchId];
      if (f.variantId !== undefined) {
        where.push('sb.variant_id = ?');
        params.push(f.variantId);
      }
      if (withinDays !== null) {
        where.push('sb.expiry_date <= ?');
        params.push(
          new Date(Date.parse(`${today}T00:00:00Z`) + withinDays * DAY_MS)
            .toISOString()
            .slice(0, 10),
        );
      }
      const rows = await ctx.driver.query<BatchRow>(
        `SELECT sb.id AS id, sb.variant_id AS variant_id, sb.batch_no AS batch_no,
                sb.expiry_date AS expiry_date, sb.created_at AS created_at,
                av.unit_scale AS unit_scale, av.unit_label AS unit_label, av.model AS model, av.colour AS colour,
                p.brand AS brand, p.name AS name, COALESCE(SUM(sm.quantity), 0) AS on_hand
         FROM stock_batches sb
         JOIN accessory_variants av ON av.id = sb.variant_id
         JOIN products p ON p.id = av.product_id
         LEFT JOIN stock_movements sm ON sm.batch_id = sb.id
         WHERE ${where.join(' AND ')}
         GROUP BY sb.id HAVING COALESCE(SUM(sm.quantity), 0) > 0
         ORDER BY sb.expiry_date, sb.created_at, sb.rowid`,
        params,
      );
      return rows.map((r): BatchView => ({
        id: r.id,
        variantId: r.variant_id,
        label: variantLabel({ brand: r.brand, name: r.name }, { model: r.model, colour: r.colour }),
        batchNo: r.batch_no,
        expiryDate: r.expiry_date,
        onHand: r.on_hand,
        unitScale: r.unit_scale,
        unitLabel: r.unit_label,
        daysLeft: daysBetween(today, r.expiry_date),
        createdAt: r.created_at,
      }));
    },

    async writeOff(i) {
      const session = requirePermission(ctx, 'adjust_stock');
      const reason = reqText(i.reason, 'reason', 1, 300);
      const shop = await loadShop(ctx.driver);
      await ctx.lock(async () => {
        const found = await ctx.driver.query<{ variant_id: string }>(
          'SELECT variant_id FROM stock_batches WHERE id = ? AND branch_id = ?',
          [String(i.batchId), shop.branchId],
        );
        const variantId = found[0]?.variant_id;
        if (variantId === undefined)
          throw new ServiceError('NOT_FOUND', 'Batch not found', { id: i.batchId });
        const stock = await ctx.driver.query<{ n: number }>(
          'SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE batch_id = ?',
          [i.batchId],
        );
        const onHand = stock[0]?.n ?? 0;
        if (onHand <= 0) throw invalid('batchId', 'This batch has no stock left to write off');
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        insertMovement(b, {
          id: ctx.newId(),
          branchId: shop.branchId,
          type: 'adjustment',
          phoneUnitId: null,
          variantId,
          batchId: i.batchId,
          quantity: -onHand,
          unitCost: null,
          refType: null,
          refId: null,
          reason,
          createdBy: session.user.id,
          createdAt: at,
        });
        await ctx.assertCanSell({ action: 'stock_entry', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
      });
    },
  });
}
