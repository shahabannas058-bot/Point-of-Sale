import { paisa } from '@pos/core';
import {
  PAYMENT_METHODS,
  ServiceError,
  type Paisa,
  type PaymentMethod,
  type PeriodSummary,
  type ReportsApi,
} from '@pos/shared';
import { requirePermission, type Ctx } from './deps';
import { guardApi } from './errors';
import { toVariantView, type Raw } from './mappers';
import { loadShop } from './meta';
import { VARIANT_VIEW_SQL } from './queries';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export function createReportsApi(ctx: Ctx): ReportsApi {
  return guardApi<ReportsApi>({
    async summary(range): Promise<PeriodSummary> {
      requirePermission(ctx, 'view_reports');
      if (
        !Number.isSafeInteger(range.fromMs) ||
        !Number.isSafeInteger(range.toMs) ||
        range.toMs < range.fromMs
      )
        throw new ServiceError('VALIDATION', 'Invalid report range', { field: 'range' });
      const shop = await loadShop(ctx.driver);
      await ctx.assertCanSell({ action: 'report', branchId: shop.branchId, now: ctx.clock() });
      const r: [number, number] = [range.fromMs, range.toMs];
      const q = async (sql: string): Promise<Raw> => (await ctx.driver.query<Raw>(sql, r))[0] ?? {};

      const counts = await q(
        `SELECT
           COALESCE(SUM(kind = 'sale'), 0) AS sales_count,
           COALESCE(SUM(kind IN ('return', 'void')), 0) AS returns_count,
           COALESCE(SUM(CASE WHEN kind = 'sale' THEN total END), 0) AS net_sales,
           COALESCE(-SUM(CASE WHEN kind IN ('return', 'void') THEN total END), 0) AS returns_total,
           COALESCE(SUM(CASE WHEN kind = 'sale' THEN discount_total END), 0) AS invoice_discounts
         FROM sales WHERE created_at >= ? AND created_at < ?`,
      );
      const lines = await q(
        `SELECT
           COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN l.quantity * l.unit_price END), 0) AS gross,
           COALESCE(SUM(CASE WHEN s.kind = 'sale' THEN l.discount_amount END), 0) AS line_discounts,
           COALESCE(SUM(l.quantity * l.cost_price), 0) AS cogs
         FROM sale_lines l JOIN sales s ON s.id = l.sale_id
         WHERE s.created_at >= ? AND s.created_at < ?`,
      );
      const payRows = await ctx.driver.query<{ method: PaymentMethod; amount: number }>(
        `SELECT p.method AS method, SUM(p.amount) AS amount
         FROM payments p JOIN sales s ON s.id = p.sale_id
         WHERE s.created_at >= ? AND s.created_at < ? GROUP BY p.method`,
        r,
      );
      const khata = await q(
        `SELECT
           COALESCE(-SUM(amount), 0) AS collected,
           COALESCE(-SUM(CASE WHEN method = 'cash' THEN amount END), 0) AS cash_collected
         FROM ledger_entries
         WHERE customer_id IS NOT NULL AND type = 'payment_received' AND created_at >= ? AND created_at < ?`,
      );

      const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, paisa(0)])) as Record<
        PaymentMethod,
        Paisa
      >;
      for (const row of payRows) byMethod[row.method] = paisa(row.amount);

      const netSales = num(counts.net_sales);
      const returnsTotal = num(counts.returns_total);
      const netRevenue = netSales - returnsTotal;
      const cogs = num(lines.cogs);
      const low = await ctx.driver.query<Raw>(
        `${VARIANT_VIEW_SQL} WHERE av.is_active = 1 AND on_hand <= av.reorder_level ORDER BY p.brand, p.name, av.sku`,
        [shop.branchId],
      );
      return {
        range,
        salesCount: num(counts.sales_count),
        returnsCount: num(counts.returns_count),
        grossSales: paisa(num(lines.gross)),
        discounts: paisa(num(lines.line_discounts) + num(counts.invoice_discounts)),
        netSales: paisa(netSales),
        returnsTotal: paisa(returnsTotal),
        netRevenue: paisa(netRevenue),
        byMethod,
        khataCollected: paisa(num(khata.collected)),
        cashInDrawer: paisa(byMethod.cash + num(khata.cash_collected)),
        estimatedCogs: paisa(cogs),
        estimatedProfit: paisa(netRevenue - cogs),
        lowStock: low.map(toVariantView),
      };
    },
  });
}
