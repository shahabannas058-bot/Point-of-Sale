import { compareReorder, paisa, reorderFigures } from '@pos/core';
import {
  ServiceError,
  type InsightsApi,
  type ItemInsight,
  type Paisa,
  type ReorderSuggestion,
} from '@pos/shared';
import { canDo, requirePermission, type Ctx } from './deps';
import { guardApi, invalid, optIntIn } from './errors';
import { toVariantView, type Raw } from './mappers';
import { loadShop } from './meta';
import { VARIANT_VIEW_SQL, customerBalance, requireVariantView } from './queries';

const DAY_MS = 86_400_000;
const INSIGHT_DAYS = 30;
/** Items that run out within this many days are suggested even above their reorder level. */
const LEAD_DAYS = 7;
const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_COVER_DAYS = 14;

interface CostAt {
  unitCost: number;
  at: number;
}

const optId = (v: unknown, field: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() !== '') return v;
  throw invalid(field, 'Must be an id');
};

/** Latest incoming unit cost (purchase or opening stock) per item; rows oldest first so the last one wins. */
async function lastCosts(
  ctx: Ctx,
  branchId: string,
  id: string | null,
): Promise<Map<string, CostAt>> {
  const rows = await ctx.driver.query<{ item: string; unit_cost: number; created_at: number }>(
    `SELECT variant_id AS item, unit_cost, created_at FROM stock_movements
     WHERE branch_id = ? AND quantity > 0 AND type IN ('purchase', 'adjustment')
       AND unit_cost IS NOT NULL ${id === null ? '' : 'AND variant_id = ?'}
     ORDER BY created_at, rowid`,
    id === null ? [branchId] : [branchId, id],
  );
  const out = new Map<string, CostAt>();
  for (const r of rows)
    out.set(r.item, { unitCost: Number(r.unit_cost), at: Number(r.created_at) });
  return out;
}

async function lastSoldTo(
  ctx: Ctx,
  customerId: string,
  variantId: string,
): Promise<ItemInsight['lastSoldToCustomer']> {
  const rows = await ctx.driver.query<{
    line_total: number;
    quantity: number;
    unit_scale: number;
    created_at: number;
    invoice_no: string;
  }>(
    `SELECT sl.line_total, sl.quantity, sl.unit_scale, s.created_at, s.invoice_no
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.kind = 'sale' AND s.customer_id = ? AND sl.variant_id = ?
     ORDER BY s.created_at DESC, s.seq DESC LIMIT 1`,
    [customerId, variantId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    // what the customer actually paid per priced unit (piece / kg), after the line discount
    unitPrice: paisa(
      Math.round((Number(r.line_total) * Number(r.unit_scale)) / Number(r.quantity)),
    ),
    at: Number(r.created_at),
    invoiceNo: String(r.invoice_no),
  };
}

async function soldSince(
  ctx: Ctx,
  branchId: string,
  since: number,
  variantId: string,
): Promise<number> {
  // return / void lines carry negative quantities, so the sum is net of returns
  const rows = await ctx.driver.query<{ n: number }>(
    `SELECT COALESCE(SUM(sl.quantity), 0) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.branch_id = ? AND s.created_at >= ? AND sl.variant_id = ?`,
    [branchId, since, variantId],
  );
  return Math.max(0, Number(rows[0]?.n ?? 0));
}

interface ItemFacts {
  onHand: number;
  lastPurchase: ItemInsight['lastPurchase'];
}

async function variantFacts(ctx: Ctx, branchId: string, variantId: string): Promise<ItemFacts> {
  const v = await requireVariantView(ctx.driver, variantId, branchId);
  let lastPurchase: ItemInsight['lastPurchase'] = null;
  if (canDo(ctx, 'view_cost')) {
    const c = (await lastCosts(ctx, branchId, variantId)).get(variantId);
    lastPurchase = c ? { unitCost: paisa(c.unitCost), at: c.at } : null;
  }
  return { onHand: v.onHand, lastPurchase };
}

async function customerFacts(
  ctx: Ctx,
  customerId: string,
  variantId: string,
): Promise<Pick<ItemInsight, 'lastSoldToCustomer' | 'customerBalance'>> {
  const exists = await ctx.driver.query('SELECT id FROM customers WHERE id = ?', [customerId]);
  if (exists.length === 0)
    throw new ServiceError('NOT_FOUND', 'Customer not found', { field: 'customerId' });
  return {
    lastSoldToCustomer: await lastSoldTo(ctx, customerId, variantId),
    customerBalance: paisa(await customerBalance(ctx.driver, customerId)),
  };
}

export function createInsightsApi(ctx: Ctx): InsightsApi {
  return guardApi<InsightsApi>({
    async item(input) {
      requirePermission(ctx, 'sell');
      const variantId = optId(input.variantId, 'variantId');
      const customerId = optId(input.customerId, 'customerId');
      if (variantId === null) throw invalid('variantId', 'variantId is required');
      const { branchId } = await loadShop(ctx.driver);

      const facts = await variantFacts(ctx, branchId, variantId);
      const sold = await soldSince(ctx, branchId, ctx.clock() - INSIGHT_DAYS * DAY_MS, variantId);
      const party =
        customerId === null
          ? { lastSoldToCustomer: null, customerBalance: null as Paisa | null }
          : await customerFacts(ctx, customerId, variantId);

      return {
        onHand: facts.onHand,
        lastPurchase: facts.lastPurchase,
        ...party,
        soldLast30Days: sold,
      };
    },

    async reorder(options = {}) {
      requirePermission(ctx, 'view_catalog');
      const days = optIntIn(options.days, 'days', 1, 365) ?? DEFAULT_WINDOW_DAYS;
      const coverDays = optIntIn(options.coverDays, 'coverDays', 1, 180) ?? DEFAULT_COVER_DAYS;
      const { branchId } = await loadShop(ctx.driver);
      const items = (
        await ctx.driver.query<Raw>(`${VARIANT_VIEW_SQL} WHERE av.is_active = 1`, [branchId])
      ).map(toVariantView);
      const soldRows = await ctx.driver.query<{ variant_id: string; n: number }>(
        `SELECT sl.variant_id, SUM(sl.quantity) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
         WHERE s.branch_id = ? AND s.created_at >= ?
         GROUP BY sl.variant_id`,
        [branchId, ctx.clock() - days * DAY_MS],
      );
      const soldBy = new Map(soldRows.map((r) => [r.variant_id, Math.max(0, Number(r.n))]));
      const showCost = canDo(ctx, 'view_cost');
      const costs = showCost ? await lastCosts(ctx, branchId, null) : new Map<string, CostAt>();

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
      return [...rows].sort((a, b) => compareReorder(rank(a), rank(b)));
    },
  });
}
