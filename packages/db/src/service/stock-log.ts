import type { StockLogEntry, StockLogPage, StockLogQuery, UnitLabel, UnitScale } from '@pos/shared';
import type { Ctx } from './deps';
import { optText } from './errors';
import { bounds, cursor, pageLimit } from './item-history';
import { variantLabel } from './mappers';
import { likePattern } from './queries';
import type { SqlValue } from '../types';

/*
 * Stock adjustment log: every 'adjustment' movement of the branch (opening stock, count corrections, write-offs),
 * newest first, so the owner can see who changed stock by hand and why. Balances are a
 * window SUM over each item's WHOLE ledger (oldest -> newest), with the range, text filter and cursor applied on
 * top, so a filtered page still shows true before / after figures.
 */

interface LogRow {
  id: string;
  created_at: number;
  quantity: number;
  reason: string | null;
  variant_id: string;
  brand: string;
  name: string;
  model: string | null;
  v_colour: string | null;
  unit_scale: number;
  unit_label: string;
  batch_id: string | null;
  batch_no: string | null;
  expiry_date: string | null;
  created_by: string;
  display_name: string | null;
  balance_after: number;
}

const BASE_SQL = `
  SELECT * FROM (
    SELECT sm.id, sm.created_at, sm.type, sm.quantity, sm.reason, sm.variant_id,
           p.brand, p.name, av.model, av.colour AS v_colour, av.unit_scale, av.unit_label,
           sm.batch_id, sb.batch_no, sb.expiry_date,
           sm.created_by, u.display_name,
           SUM(sm.quantity) OVER (
             PARTITION BY sm.variant_id ORDER BY sm.created_at, sm.id
           ) AS balance_after
    FROM stock_movements sm
    JOIN accessory_variants av ON av.id = sm.variant_id
    JOIN products p            ON p.id = av.product_id
    LEFT JOIN users u          ON u.id = sm.created_by
    LEFT JOIN stock_batches sb ON sb.id = sm.batch_id
    WHERE sm.branch_id = ?
  )
  WHERE type = 'adjustment'
    AND (? IS NULL OR created_at >= ?)
    AND (? IS NULL OR created_at <= ?)
    AND (? IS NULL OR (brand || ' ' || name) LIKE ? ESCAPE '\\' OR COALESCE(model, '') LIKE ? ESCAPE '\\'
         OR COALESCE(reason, '') LIKE ? ESCAPE '\\' OR COALESCE(display_name, '') LIKE ? ESCAPE '\\')`;

const PAGE_SQL = `${BASE_SQL}
    AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
  ORDER BY created_at DESC, id DESC
  LIMIT ?`;

const SUMMARY_SQL = `SELECT COUNT(*) AS n, COALESCE(SUM(quantity > 0), 0) AS ups, COALESCE(SUM(quantity < 0), 0) AS downs
  FROM (${BASE_SQL})`;

function toEntry(r: LogRow): StockLogEntry {
  const quantity = Number(r.quantity);
  const balanceAfter = Number(r.balance_after);
  return {
    id: r.id,
    at: Number(r.created_at),
    item: { variantId: r.variant_id },
    label: variantLabel({ brand: r.brand, name: r.name }, { model: r.model, colour: r.v_colour }),
    unitScale: Number(r.unit_scale) as UnitScale,
    unitLabel: r.unit_label as UnitLabel,
    quantity,
    balanceBefore: balanceAfter - quantity,
    balanceAfter,
    reason: r.reason,
    batch:
      r.batch_id !== null && r.expiry_date !== null
        ? { id: r.batch_id, batchNo: r.batch_no, expiryDate: r.expiry_date }
        : null,
    by: { id: r.created_by, displayName: r.display_name ?? '' },
  };
}

/** Caller has already checked the permission. Throws VALIDATION. */
export async function queryStockLog(
  ctx: Ctx,
  branchId: string,
  q: StockLogQuery = {},
): Promise<StockLogPage> {
  const { from, to } = bounds(q);
  const limit = pageLimit(q.limit);
  const before = cursor(q.before);
  const text = q.q === undefined ? null : optText(q.q, 'q', 100);
  const like = text === null ? null : likePattern(text);

  const filters: SqlValue[] = [branchId, from, from, to, to, like, like, like, like, like];
  const beforeAt: SqlValue = before === null ? null : before.at;
  const beforeId: SqlValue = before === null ? null : before.id;
  const rows = await ctx.driver.query<LogRow>(PAGE_SQL, [
    ...filters,
    beforeAt,
    beforeAt,
    beforeAt,
    beforeId,
    limit + 1, // one extra row tells us whether an older page exists
  ]);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextBefore =
    rows.length > limit && last !== undefined ? { at: Number(last.created_at), id: last.id } : null;

  const totals = (
    await ctx.driver.query<{ n: number; ups: number; downs: number }>(SUMMARY_SQL, filters)
  )[0];
  return {
    entries: page.map(toEntry),
    nextBefore,
    summary: {
      count: Number(totals?.n ?? 0),
      increases: Number(totals?.ups ?? 0),
      decreases: Number(totals?.downs ?? 0),
    },
  };
}
