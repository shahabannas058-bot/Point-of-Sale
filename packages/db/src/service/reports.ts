import { paisa, verifyChain } from '@pos/core';
import { PAYMENT_METHODS, type Paisa, type PaymentMethod, type PosService } from '@pos/shared';
import { loadMeta, one, q, requirePerm, scalar, variantViews, type Ctx } from './context';
import { allInvoices } from './checkout';
import { intIn } from './errors';

export function reportsApi(ctx: Ctx): PosService['reports'] {
  return {
    async summary(range) {
      requirePerm(ctx, 'view_reports');
      const from = intIn(range.fromMs, 'fromMs', 0, Number.MAX_SAFE_INTEGER);
      const to = intIn(range.toMs, 'toMs', 0, Number.MAX_SAFE_INTEGER);
      const meta = await loadMeta(ctx);
      const inRange = 's.created_at >= ? AND s.created_at < ?';

      const totals = await one<Record<string, number | null>>(
        ctx,
        `SELECT
           SUM(CASE WHEN s.kind = 'sale' THEN 1 ELSE 0 END)            AS sales_count,
           SUM(CASE WHEN s.kind <> 'sale' THEN 1 ELSE 0 END)           AS returns_count,
           SUM(CASE WHEN s.kind = 'sale' THEN s.total ELSE 0 END)      AS net_sales,
           SUM(CASE WHEN s.kind = 'sale' THEN s.discount_total ELSE 0 END) AS invoice_discounts,
           SUM(CASE WHEN s.kind <> 'sale' THEN -s.total ELSE 0 END)    AS returns_total
         FROM sales s WHERE ${inRange}`,
        [from, to],
      );
      const lines = await one<Record<string, number | null>>(
        ctx,
        `SELECT
           SUM(CASE WHEN s.kind = 'sale' THEN sl.quantity * sl.unit_price ELSE 0 END) AS gross,
           SUM(CASE WHEN s.kind = 'sale' THEN sl.discount_amount ELSE 0 END)          AS line_discounts,
           SUM(sl.quantity * sl.cost_price)                                           AS cogs
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id WHERE ${inRange}`,
        [from, to],
      );
      const methods = await q<{ method: PaymentMethod; amount: number }>(
        ctx,
        `SELECT p.method, SUM(p.amount) AS amount FROM payments p JOIN sales s ON s.id = p.sale_id
         WHERE ${inRange} GROUP BY p.method`,
        [from, to],
      );
      const byMethod = Object.fromEntries(PAYMENT_METHODS.map((m) => [m, paisa(0)])) as Record<
        PaymentMethod,
        Paisa
      >;
      for (const m of methods) byMethod[m.method] = paisa(Number(m.amount));

      const collected = await scalar(
        ctx,
        `SELECT COALESCE(SUM(-amount), 0) AS n FROM ledger_entries
         WHERE type = 'payment_received' AND created_at >= ? AND created_at < ?`,
        [from, to],
      );
      const collectedCash = await scalar(
        ctx,
        `SELECT COALESCE(SUM(-amount), 0) AS n FROM ledger_entries
         WHERE type = 'payment_received' AND method = 'cash' AND created_at >= ? AND created_at < ?`,
        [from, to],
      );

      const n = (v: number | null | undefined): number => Number(v ?? 0);
      const netSales = n(totals?.net_sales);
      const returnsTotal = n(totals?.returns_total);
      const cogs = n(lines?.cogs);
      const lowStock = (
        await variantViews(ctx, meta.branchId, 'WHERE av.is_active = 1 ORDER BY p.name')
      ).filter((v) => v.lowStock);
      return {
        range: { fromMs: from, toMs: to },
        salesCount: n(totals?.sales_count),
        returnsCount: n(totals?.returns_count),
        grossSales: paisa(n(lines?.gross)),
        discounts: paisa(n(lines?.line_discounts) + n(totals?.invoice_discounts)),
        netSales: paisa(netSales),
        returnsTotal: paisa(returnsTotal),
        netRevenue: paisa(netSales - returnsTotal),
        byMethod,
        khataCollected: paisa(collected),
        cashInDrawer: paisa(byMethod.cash + collectedCash),
        estimatedCogs: paisa(cogs),
        estimatedProfit: paisa(netSales - returnsTotal - cogs),
        lowStock,
      };
    },
  };
}

export function integrityApi(ctx: Ctx): PosService['integrity'] {
  return {
    async verifyChain() {
      const invoices = await allInvoices(ctx);
      const r = verifyChain(invoices);
      if (r.ok) return { ok: true, count: r.count, headSeq: r.headSeq, headHash: r.headHash };
      const bad = [...invoices].sort((a, b) => a.seq - b.seq)[r.index];
      return {
        ok: false,
        reason: r.reason,
        seq: bad?.seq ?? null,
        invoiceNo: bad?.invoiceNo ?? null,
      };
    },
    async checks() {
      return {
        salePaymentMismatch: await scalar(
          ctx,
          `SELECT COUNT(*) AS n FROM sales s
           WHERE s.total <> COALESCE((SELECT SUM(amount) FROM payments p WHERE p.sale_id = s.id), 0)`,
        ),
        saleLineMismatch: await scalar(
          ctx,
          `SELECT COUNT(*) AS n FROM sales s
           WHERE s.subtotal <> COALESCE((SELECT SUM(line_total) FROM sale_lines l WHERE l.sale_id = s.id), 0)`,
        ),
        badPhoneUnits: await scalar(
          ctx,
          'SELECT COUNT(*) AS n FROM v_phone_unit_on_hand WHERE on_hand NOT BETWEEN 0 AND 1',
        ),
        unsentOutbox: await scalar(ctx, 'SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL'),
      };
    },
  };
}
