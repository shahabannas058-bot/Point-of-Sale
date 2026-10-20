import { paisa } from '@pos/core';
import {
  ServiceError,
  type CategorySales,
  type DashboardData,
  type DashboardInput,
  type TrendPoint,
} from '@pos/shared';
import type { SqlDriver } from '../types';
import { grossSql } from './report-sql';

/** A year of days plus slack; keeps the bound-parameter list small. */
export const MAX_DASHBOARD_BUCKETS = 400;
const TOP_CATEGORIES = 5;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function assertBuckets(buckets: readonly number[]): void {
  const ok =
    Array.isArray(buckets) &&
    buckets.length >= 2 &&
    buckets.length <= MAX_DASHBOARD_BUCKETS + 1 &&
    buckets.every((b, i) => Number.isSafeInteger(b) && (i === 0 || b > (buckets[i - 1] ?? b)));
  if (!ok) throw new ServiceError('VALIDATION', 'Invalid dashboard buckets', { field: 'buckets' });
}

async function loadTrend(driver: SqlDriver, buckets: readonly number[]): Promise<TrendPoint[]> {
  const pairs = buckets.slice(1).map((to, i) => [buckets[i] ?? to, to] as const);
  const rows = await driver.query<{ f: number; revenue: unknown; cnt: unknown; cogs: unknown }>(
    `WITH b(f, t) AS (VALUES ${pairs.map(() => '(?, ?)').join(', ')})
     SELECT b.f AS f,
       (SELECT SUM(s.total) FROM sales s WHERE s.created_at >= b.f AND s.created_at < b.t) AS revenue,
       (SELECT SUM(s.kind = 'sale') FROM sales s WHERE s.created_at >= b.f AND s.created_at < b.t) AS cnt,
       (SELECT SUM(${grossSql('l.cost_price')}) FROM sale_lines l JOIN sales s ON s.id = l.sale_id
          WHERE s.created_at >= b.f AND s.created_at < b.t) AS cogs
     FROM b ORDER BY b.f`,
    pairs.flat(),
  );
  return pairs.map(([fromMs, toMs], i) => {
    const row = rows[i];
    const revenue = num(row?.revenue);
    return {
      fromMs,
      toMs,
      revenue: paisa(revenue),
      profit: paisa(revenue - num(row?.cogs)),
      salesCount: num(row?.cnt),
    };
  });
}

async function loadInventoryValue(driver: SqlDriver, branchId: string): Promise<number> {
  const rows = await driver.query<{ v: unknown }>(
    `SELECT
       COALESCE((SELECT SUM((q.on_hand * q.cost_price + q.unit_scale / 2) / q.unit_scale)
         FROM (SELECT av.cost_price, av.unit_scale,
                 (SELECT SUM(sm.quantity) FROM stock_movements sm
                   WHERE sm.variant_id = av.id AND sm.branch_id = ?) AS on_hand
               FROM accessory_variants av) q
         WHERE q.on_hand > 0), 0)
     + COALESCE((SELECT SUM(pu.cost_price) FROM phone_units pu
         WHERE (SELECT SUM(sm.quantity) FROM stock_movements sm
                 WHERE sm.phone_unit_id = pu.id AND sm.branch_id = ?) > 0), 0) AS v`,
    [branchId, branchId],
  );
  return num(rows[0]?.v);
}

async function loadTopCategories(
  driver: SqlDriver,
  fromMs: number,
  toMs: number,
): Promise<CategorySales[]> {
  const rows = await driver.query<{ category: string; revenue: unknown }>(
    `SELECT COALESCE(p.category, '') AS category, SUM(l.line_total) AS revenue
     FROM sale_lines l JOIN sales s ON s.id = l.sale_id JOIN products p ON p.id = l.product_id
     WHERE s.created_at >= ? AND s.created_at < ?
     GROUP BY COALESCE(p.category, '')
     HAVING SUM(l.line_total) > 0
     ORDER BY revenue DESC, category
     LIMIT ${TOP_CATEGORIES}`,
    [fromMs, toMs],
  );
  return rows.map((r) => ({ category: r.category, revenue: paisa(num(r.revenue)) }));
}

/** Caller has checked permission, the licence and the buckets. */
export async function loadDashboard(
  driver: SqlDriver,
  branchId: string,
  { buckets }: DashboardInput,
): Promise<DashboardData> {
  const fromMs = buckets[0] ?? 0;
  const toMs = buckets[buckets.length - 1] ?? 0;
  return {
    trend: await loadTrend(driver, buckets),
    inventoryValue: paisa(await loadInventoryValue(driver, branchId)),
    topCategories: await loadTopCategories(driver, fromMs, toMs),
  };
}
