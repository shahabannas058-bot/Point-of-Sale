import { verifyChain as verifyInvoices } from '@pos/core';
import {
  GENESIS_HASH,
  InvoiceSchema,
  type ChainReport,
  type IntegrityApi,
  type Invoice,
} from '@pos/shared';
import { requireSession, type Ctx } from './deps';
import { guardApi } from './errors';
import type { Raw } from './mappers';
import { loadShop } from './meta';
import { assembleInvoiceInput } from './queries';

const PAGE = 500;

function groupBySale(rows: readonly Raw[]): Map<string, Raw[]> {
  const out = new Map<string, Raw[]>();
  for (const r of rows) {
    const key = r.sale_id as string;
    const list = out.get(key);
    if (list === undefined) out.set(key, [r]);
    else list.push(r);
  }
  return out;
}

export function createIntegrityApi(ctx: Ctx): IntegrityApi {
  const count = async (sql: string): Promise<number> =>
    (await ctx.driver.query<{ n: number }>(sql))[0]?.n ?? 0;

  return guardApi<IntegrityApi>({
    async verifyChain(): Promise<ChainReport> {
      requireSession(ctx);
      const shop = await loadShop(ctx.driver);
      let startSeq = 1;
      let prevHash: string = GENESIS_HASH;
      let total = 0;
      for (;;) {
        const sales = await ctx.driver.query<Raw>(
          'SELECT * FROM sales WHERE device_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
          [shop.deviceId, startSeq, PAGE],
        );
        if (sales.length === 0) break;
        const lastSeq = Number(sales[sales.length - 1]?.seq);
        const lines = await ctx.driver.query<Raw>(
          `SELECT l.* FROM sale_lines l JOIN sales s ON s.id = l.sale_id
           WHERE s.device_id = ? AND s.seq >= ? AND s.seq <= ? ORDER BY s.seq, l.line_no`,
          [shop.deviceId, startSeq, lastSeq],
        );
        const pays = await ctx.driver.query<Raw>(
          `SELECT p.* FROM payments p JOIN sales s ON s.id = p.sale_id
           WHERE s.device_id = ? AND s.seq >= ? AND s.seq <= ? ORDER BY s.seq, p.id`,
          [shop.deviceId, startSeq, lastSeq],
        );
        const linesBy = groupBySale(lines);
        const paysBy = groupBySale(pays);

        const invoices: Invoice[] = [];
        for (const [i, s] of sales.entries()) {
          const parsed = InvoiceSchema.safeParse(
            assembleInvoiceInput(
              s,
              linesBy.get(s.id as string) ?? [],
              paysBy.get(s.id as string) ?? [],
            ),
          );
          if (!parsed.success)
            return {
              ok: false,
              reason: `Invoice failed validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
              seq: startSeq + i,
              invoiceNo: typeof s.invoice_no === 'string' ? s.invoice_no : null,
            };
          invoices.push(parsed.data);
        }
        const result = verifyInvoices(invoices, { startSeq, startPrevHash: prevHash });
        if (!result.ok)
          return {
            ok: false,
            reason: result.reason,
            seq: startSeq + result.index,
            invoiceNo: invoices[result.index]?.invoiceNo ?? null,
          };
        total += result.count;
        prevHash = result.headHash;
        startSeq = result.headSeq + 1;
        if (sales.length < PAGE) break;
      }
      return { ok: true, count: total, headSeq: startSeq - 1, headHash: prevHash };
    },

    async checks() {
      requireSession(ctx);
      return {
        salePaymentMismatch: await count('SELECT COUNT(*) AS n FROM v_sale_payment_mismatch'),
        saleLineMismatch: await count('SELECT COUNT(*) AS n FROM v_sale_line_mismatch'),
        badPhoneUnits: await count(
          `SELECT COUNT(*) AS n FROM (SELECT phone_unit_id FROM stock_movements
             WHERE phone_unit_id IS NOT NULL GROUP BY phone_unit_id HAVING SUM(quantity) NOT BETWEEN 0 AND 1)`,
        ),
        unsentOutbox: await count('SELECT COUNT(*) AS n FROM outbox WHERE sent_at IS NULL'),
      };
    },
  });
}
