import { compareReorder, paisa, reorderFigures } from '@pos/core';
import type { Id, ItemInsight, Paisa, PosService, ReorderSuggestion } from '@pos/shared';
import type { SqlValue } from '../driver';
import {
  can,
  loadMeta,
  one,
  phoneView,
  q,
  requirePerm,
  scalar,
  variantView,
  variantViews,
  type Ctx,
} from './context';
import { fail, invalid, optIntIn } from './errors';
import { customerBalance } from './parties';

const DAY_MS = 86_400_000;
const INSIGHT_DAYS = 30;
/** Items that run out within this many days are suggested even above their reorder level. */
const LEAD_DAYS = 7;

/** Which sale lines count as "this item": one accessory variant, or every unit of one phone model. */
interface ItemMatch {
  sql: string;
  param: SqlValue;
}

const optId = (v: unknown, field: string): Id | null => {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' && v.trim() !== '' ? v : invalid(field, 'Must be an id');
};

/** Latest opening / purchase unit cost recorded in the stock ledger, oldest first so the last row wins. */
async function lastCosts(
  ctx: Ctx,
  branchId: Id,
  column: 'variant_id' | 'phone_unit_id',
  id: Id | null,
): Promise<Map<Id, { unitCost: number; at: number }>> {
  const rows = await q<{ item: string; unit_cost: number; created_at: number }>(
    ctx,
    `SELECT ${column} AS item, unit_cost, created_at FROM stock_movements
     WHERE branch_id = ? AND type IN ('opening', 'purchase') AND unit_cost IS NOT NULL
       AND ${column} IS NOT NULL ${id ? `AND ${column} = ?` : ''}
     ORDER BY created_at, rowid`,
    id ? [branchId, id] : [branchId],
  );
  const out = new Map<Id, { unitCost: number; at: number }>();
  for (const r of rows)
    out.set(r.item, { unitCost: Number(r.unit_cost), at: Number(r.created_at) });
  return out;
}

async function lastSoldTo(
  ctx: Ctx,
  customerId: Id,
  match: ItemMatch,
): Promise<ItemInsight['lastSoldToCustomer']> {
  const r = await one<{
    line_total: number;
    quantity: number;
    created_at: number;
    invoice_no: string;
  }>(
    ctx,
    `SELECT sl.line_total, sl.quantity, s.created_at, s.invoice_no
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.kind = 'sale' AND s.customer_id = ? AND ${match.sql}
     ORDER BY s.created_at DESC, s.seq DESC LIMIT 1`,
    [customerId, match.param],
  );
  if (!r) return null;
  return {
    // what the customer actually paid per unit, after the line discount
    unitPrice: paisa(Math.round(Number(r.line_total) / Number(r.quantity))),
    at: Number(r.created_at),
    invoiceNo: String(r.invoice_no),
  };
}

export function insightsApi(ctx: Ctx): PosService['insights'] {
  return {
    async item(input) {
      requirePerm(ctx, 'sell');
      const variantId = optId(input.variantId, 'variantId');
      const phoneUnitId = optId(input.phoneUnitId, 'phoneUnitId');
      const customerId = optId(input.customerId, 'customerId');
      if ((variantId === null) === (phoneUnitId === null))
        invalid('variantId', 'Give exactly one of variantId or phoneUnitId');
      const { branchId } = await loadMeta(ctx);

      let onHand: number;
      let match: ItemMatch;
      let lastPurchase: ItemInsight['lastPurchase'] = null;
      if (variantId) {
        const v = await variantView(ctx, branchId, variantId);
        onHand = v.onHand;
        match = { sql: 'sl.variant_id = ?', param: variantId };
        if (can(ctx, 'view_cost')) {
          const c = (await lastCosts(ctx, branchId, 'variant_id', variantId)).get(variantId);
          lastPurchase = c ? { unitCost: paisa(c.unitCost), at: c.at } : null;
        }
      } else {
        const u = await phoneView(ctx, phoneUnitId as Id);
        onHand = u.inStock ? 1 : 0;
        match = { sql: 'sl.product_id = ? AND sl.phone_unit_id IS NOT NULL', param: u.product.id };
        if (can(ctx, 'view_cost')) {
          const c = (await lastCosts(ctx, branchId, 'phone_unit_id', u.unit.id)).get(u.unit.id);
          lastPurchase = {
            unitCost: paisa(c?.unitCost ?? u.unit.costPrice),
            at: c?.at ?? u.unit.createdAt,
          };
        }
      }

      const since = ctx.now() - INSIGHT_DAYS * DAY_MS;
      // return / void lines carry negative quantities, so the sum is net of returns
      const sold = await scalar(
        ctx,
        `SELECT COALESCE(SUM(sl.quantity), 0) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
         WHERE s.branch_id = ? AND s.created_at >= ? AND ${match.sql}`,
        [branchId, since, match.param],
      );

      let lastSoldToCustomer: ItemInsight['lastSoldToCustomer'] = null;
      let balance: Paisa | null = null;
      if (customerId) {
        const exists = await one(ctx, 'SELECT id FROM customers WHERE id = ?', [customerId]);
        if (!exists) fail('NOT_FOUND', 'Customer not found', { field: 'customerId' });
        lastSoldToCustomer = await lastSoldTo(ctx, customerId, match);
        balance = paisa(await customerBalance(ctx, customerId));
      }

      return {
        onHand,
        lastPurchase,
        lastSoldToCustomer,
        customerBalance: balance,
        soldLast30Days: Math.max(0, sold),
      };
    },

    async reorder(options = {}) {
      requirePerm(ctx, 'view_catalog');
      const days = optIntIn(options.days, 'days', 1, 365) ?? 30;
      const coverDays = optIntIn(options.coverDays, 'coverDays', 1, 180) ?? 14;
      const { branchId } = await loadMeta(ctx);
      const items = await variantViews(ctx, branchId, 'WHERE av.is_active = 1');
      const since = ctx.now() - days * DAY_MS;
      const soldRows = await q<{ variant_id: string; n: number }>(
        ctx,
        `SELECT sl.variant_id, SUM(sl.quantity) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
         WHERE s.branch_id = ? AND s.created_at >= ? AND sl.variant_id IS NOT NULL
         GROUP BY sl.variant_id`,
        [branchId, since],
      );
      const soldBy = new Map(soldRows.map((r) => [r.variant_id, Math.max(0, Number(r.n))]));
      const showCost = can(ctx, 'view_cost');
      const costs = showCost
        ? await lastCosts(ctx, branchId, 'variant_id', null)
        : new Map<Id, { unitCost: number; at: number }>();

      const rows: ReorderSuggestion[] = [];
      for (const item of items) {
        const sold = soldBy.get(item.variant.id) ?? 0;
        const f = reorderFigures({
          onHand: item.onHand,
          reorderLevel: item.variant.reorderLevel,
          sold,
          days,
          coverDays,
          leadDays: LEAD_DAYS,
        });
        if (!f.needsReorder) continue;
        rows.push({
          item,
          sold,
          dailyAvg: f.dailyAvg,
          daysLeft: f.daysLeft,
          suggestedQty: f.suggestedQty,
          unitCost: showCost
            ? paisa(costs.get(item.variant.id)?.unitCost ?? item.variant.costPrice)
            : null,
        });
      }
      const rank = (r: ReorderSuggestion) => ({
        daysLeft: r.daysLeft,
        onHand: r.item.onHand,
        reorderLevel: r.item.variant.reorderLevel,
        label: r.item.label,
      });
      return rows.sort((a, b) => compareReorder(rank(a), rank(b)));
    },
  };
}
