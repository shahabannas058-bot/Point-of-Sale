import { compareReorder, paisa, reorderFigures } from '@pos/core';
import {
  ServiceError,
  pktDate,
  type InsightsApi,
  type ItemInsight,
  type Paisa,
  type ReorderSuggestion,
} from '@pos/shared';
import { canDo, requirePermission, type Ctx } from './deps';
import { guardApi, invalid, optIntIn } from './errors';
import { itemViewForSession } from './cost-mask';
import { toItemView, type Raw } from './mappers';
import { unsellableExpired } from './batches';
import { loadShop, type ShopMeta } from './meta';
import { ITEM_VIEW_SQL, customerBalance, requireItemView } from './queries';

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
    `SELECT item_id AS item, unit_cost, created_at FROM stock_movements
     WHERE branch_id = ? AND quantity > 0 AND type IN ('purchase', 'adjustment')
       AND unit_cost IS NOT NULL ${id === null ? '' : 'AND item_id = ?'}
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
  itemId: string,
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
     WHERE s.kind = 'sale' AND s.customer_id = ? AND sl.item_id = ?
     ORDER BY s.created_at DESC, s.seq DESC LIMIT 1`,
    [customerId, itemId],
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
  itemId: string,
): Promise<number> {
  // return / void lines carry negative quantities, so the sum is net of returns
  const rows = await ctx.driver.query<{ n: number }>(
    `SELECT COALESCE(SUM(sl.quantity), 0) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.branch_id = ? AND s.created_at >= ? AND sl.item_id = ?`,
    [branchId, since, itemId],
  );
  return Math.max(0, Number(rows[0]?.n ?? 0));
}

interface ItemFacts {
  onHand: number;
  expiredOnHand: number;
  lastPurchase: ItemInsight['lastPurchase'];
}

async function itemFacts(ctx: Ctx, shop: ShopMeta, itemId: string): Promise<ItemFacts> {
  const { branchId } = shop;
  const v = await requireItemView(ctx.driver, itemId, branchId);
  // stock in expired batches can never be sold, so the till shows it apart
  const expiredOnHand = await unsellableExpired(ctx.driver, shop, itemId, pktDate(ctx.clock()));
  let lastPurchase: ItemInsight['lastPurchase'] = null;
  if (canDo(ctx, 'view_cost')) {
    const c = (await lastCosts(ctx, branchId, itemId)).get(itemId);
    lastPurchase = c ? { unitCost: paisa(c.unitCost), at: c.at } : null;
  }
  return { onHand: v.onHand - expiredOnHand, expiredOnHand, lastPurchase };
}

async function customerFacts(
  ctx: Ctx,
  customerId: string,
  itemId: string,
): Promise<Pick<ItemInsight, 'lastSoldToCustomer' | 'customerBalance'>> {
  const exists = await ctx.driver.query('SELECT id FROM customers WHERE id = ?', [customerId]);
  if (exists.length === 0)
    throw new ServiceError('NOT_FOUND', 'Customer not found', { field: 'customerId' });
  return {
    lastSoldToCustomer: await lastSoldTo(ctx, customerId, itemId),
    customerBalance: paisa(await customerBalance(ctx.driver, customerId)),
  };
}

export function createInsightsApi(ctx: Ctx): InsightsApi {
  return guardApi<InsightsApi>({
    async item(input) {
      requirePermission(ctx, 'sell');
      const itemId = optId(input.itemId, 'itemId');
      const customerId = optId(input.customerId, 'customerId');
      if (itemId === null) throw invalid('itemId', 'itemId is required');
      const shop = await loadShop(ctx.driver);
      const { branchId } = shop;

      const facts = await itemFacts(ctx, shop, itemId);
      const sold = await soldSince(ctx, branchId, ctx.clock() - INSIGHT_DAYS * DAY_MS, itemId);
      const party =
        customerId === null
          ? { lastSoldToCustomer: null, customerBalance: null as Paisa | null }
          : await customerFacts(ctx, customerId, itemId);

      return {
        onHand: facts.onHand,
        expiredOnHand: facts.expiredOnHand,
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
        await ctx.driver.query<Raw>(`${ITEM_VIEW_SQL} WHERE it.is_active = 1`, [branchId])
      ).map((r) => itemViewForSession(ctx, toItemView(r)));
      const soldRows = await ctx.driver.query<{ item_id: string; n: number }>(
        `SELECT sl.item_id, SUM(sl.quantity) AS n FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
         WHERE s.branch_id = ? AND s.created_at >= ?
         GROUP BY sl.item_id`,
        [branchId, ctx.clock() - days * DAY_MS],
      );
      const soldBy = new Map(soldRows.map((r) => [r.item_id, Math.max(0, Number(r.n))]));
      const showCost = canDo(ctx, 'view_cost');
      const costs = showCost ? await lastCosts(ctx, branchId, null) : new Map<string, CostAt>();

      const rows: ReorderSuggestion[] = [];
      for (const item of items) {
        const sold = soldBy.get(item.item.id) ?? 0;
        const f = reorderFigures({
          onHand: item.onHand,
          reorderLevel: item.item.reorderLevel,
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
            ? paisa(costs.get(item.item.id)?.unitCost ?? item.item.costPrice)
            : null,
        });
      }
      const rank = (r: ReorderSuggestion) => ({
        daysLeft: r.daysLeft,
        onHand: r.item.onHand,
        reorderLevel: r.item.item.reorderLevel,
        label: r.item.label,
      });
      return [...rows].sort((a, b) => compareReorder(rank(a), rank(b)));
    },
  });
}
