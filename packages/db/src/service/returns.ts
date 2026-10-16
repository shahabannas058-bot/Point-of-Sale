import {
  PaymentMethodSchema,
  ServiceError,
  UuidV7Schema,
  type ApprovalReason,
  type CheckoutApi,
  type Invoice,
  type Paisa,
  type PaymentInput,
  type ReturnPreview,
  type ReturnableLine,
} from '@pos/shared';
import {
  allocate,
  assertPaymentsMatchTotal,
  negPaisa,
  paisa,
  saleTotals,
  type PricedLine,
} from '@pos/core';
import {
  resolveApproval,
  toInvoiceView,
  withApprovalNote,
  writeInvoice,
  type LineSpec,
  type PaymentSpec,
} from './checkout';
import { canDo, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optText, reqText } from './errors';
import { loadShop } from './meta';
import { loadInvoiceBy, requireInvoice } from './queries';
import type { SqlDriver } from '../types';

type InvoiceLine = Invoice['lines'][number];
interface LineState {
  line: InvoiceLine;
  returnedQty: number;
  remainingQty: number;
}
interface ReturnContext {
  original: Invoice;
  states: LineState[];
  /** Magnitude of invoice-level discount already handed back by earlier returns/voids. */
  priorInvoiceDiscount: number;
}
interface ComputedReturn {
  specs: LineSpec[];
  subtotal: Paisa; // negative
  invoiceDiscount: Paisa; // <= 0
  total: Paisa; // <= 0
  complete: boolean;
}

/*
 * sale_lines has no "original line" column, so earlier returns are matched to original lines by item
 * (phone unit or variant) and handed out first-in-first-out by line number. For the common case (one line
 * per item) this is exact; stock quantities are always exact because they are ledger sums per item.
 */
async function loadReturnContext(
  driver: SqlDriver,
  originalSaleId: string,
): Promise<ReturnContext> {
  const original = await requireInvoice(driver, originalSaleId);
  if (original.kind !== 'sale')
    throw new ServiceError('RETURN_NOT_ALLOWED', 'Only a sale invoice can be returned', {
      kind: original.kind,
    });
  const prior = await driver.query<{
    phone_unit_id: string | null;
    variant_id: string | null;
    qty: number;
  }>(
    `SELECT l.phone_unit_id, l.variant_id, -SUM(l.quantity) AS qty
     FROM sale_lines l JOIN sales s ON s.id = l.sale_id
     WHERE s.original_sale_id = ? AND s.kind IN ('return', 'void')
     GROUP BY l.phone_unit_id, l.variant_id`,
    [original.id],
  );
  const pool = new Map(
    prior.map((r) => [
      r.phone_unit_id !== null ? `u:${r.phone_unit_id}` : `v:${r.variant_id ?? ''}`,
      r.qty,
    ]),
  );
  const states = [...original.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line): LineState => {
      const key = line.phoneUnitId !== null ? `u:${line.phoneUnitId}` : `v:${line.variantId ?? ''}`;
      const available = pool.get(key) ?? 0;
      const returnedQty = Math.min(available, line.quantity);
      pool.set(key, available - returnedQty);
      return { line, returnedQty, remainingQty: line.quantity - returnedQty };
    });
  const disc = await driver.query<{ d: number }>(
    "SELECT COALESCE(-SUM(discount_total), 0) AS d FROM sales WHERE original_sale_id = ? AND kind IN ('return', 'void')",
    [original.id],
  );
  return { original, states, priorInvoiceDiscount: disc[0]?.d ?? 0 };
}

/** Cumulative share of a line discount for k of N units; differences give each return its exact share. */
function lineDiscountShare(discount: number, k: number, n: number): number {
  if (discount === 0 || k === 0) return 0;
  if (k >= n) return discount;
  return allocate(paisa(discount), [k, n - k])[0] ?? 0;
}

function computeReturn(
  rc: ReturnContext,
  requested: { lineId: string; quantity: number }[],
): ComputedReturn {
  const byId = new Map<string, LineState>(rc.states.map((s) => [s.line.id, s]));
  const qtyByLine = new Map<string, number>();
  for (const r of requested) {
    if (!byId.has(r.lineId))
      throw new ServiceError('NOT_FOUND', 'Line not found on this invoice', { lineId: r.lineId });
    const q = intIn(r.quantity, 'quantity', 1, 1_000_000);
    qtyByLine.set(r.lineId, (qtyByLine.get(r.lineId) ?? 0) + q);
  }
  const specs: LineSpec[] = [];
  for (const st of rc.states) {
    const q = qtyByLine.get(st.line.id);
    if (q === undefined) continue;
    if (q > st.remainingQty)
      throw new ServiceError('ALREADY_RETURNED', 'More units than are left to return', {
        lineId: st.line.id,
        remainingQty: st.remainingQty,
        requested: q,
      });
    const n = st.line.quantity;
    const d = st.line.discountAmount;
    const share =
      lineDiscountShare(d, st.returnedQty + q, n) - lineDiscountShare(d, st.returnedQty, n);
    specs.push({
      productId: st.line.productId,
      phoneUnitId: st.line.phoneUnitId,
      variantId: st.line.variantId,
      description: st.line.description,
      quantity: -q,
      unitPrice: st.line.unitPrice,
      costPrice: st.line.costPrice,
      discountAmount: paisa(-share),
    });
  }
  if (specs.length === 0)
    return {
      specs,
      subtotal: paisa(0),
      invoiceDiscount: paisa(0),
      total: paisa(0),
      complete: false,
    };

  const priced = specs.map((s): PricedLine => ({
    quantity: s.quantity,
    unitPrice: s.unitPrice,
    discountAmount: s.discountAmount,
  }));
  const subtotal = saleTotals(priced, paisa(0)).subtotal;
  const absSub = negPaisa(subtotal);
  const complete = rc.states.every(
    (st) => st.remainingQty - (qtyByLine.get(st.line.id) ?? 0) === 0,
  );

  const dInv = rc.original.discountTotal;
  const remaining = dInv - rc.priorInvoiceDiscount;
  let give = 0;
  if (dInv > 0 && absSub > 0) {
    if (complete) give = Math.min(remaining, absSub);
    else {
      const origSub = rc.original.subtotal;
      const share = allocate(paisa(dInv), [absSub, Math.max(0, origSub - absSub)])[0] ?? 0;
      give = Math.min(remaining, share, absSub);
    }
  }
  const invoiceDiscount = paisa(-give);
  return {
    specs,
    subtotal,
    invoiceDiscount,
    total: paisa(subtotal - invoiceDiscount),
    complete,
  };
}

/** Negative amounts split over the original payments by largest remainder. */
function suggestRefund(original: Invoice, total: Paisa): PaymentInput[] {
  if (total === 0 || original.payments.length === 0) return [];
  const shares = allocate(
    total,
    original.payments.map((p) => p.amount),
  );
  return original.payments
    .map((p, i): PaymentInput => ({ method: p.method, amount: shares[i] ?? 0 }))
    .filter((p) => p.amount !== 0);
}

const toReturnableLines = (states: LineState[]): ReturnableLine[] =>
  states.map((st) => ({
    lineId: st.line.id,
    lineNo: st.line.lineNo,
    description: st.line.description,
    soldQty: st.line.quantity,
    returnedQty: st.returnedQty,
    remainingQty: st.remainingQty,
    unitPrice: st.line.unitPrice,
  }));

type ReturnsPart = Pick<CheckoutApi, 'previewReturn' | 'createReturn' | 'voidSale'>;

export function createReturnsPart(ctx: Ctx): ReturnsPart {
  const checkSaleId = (saleId: string | undefined): void => {
    if (saleId !== undefined && !UuidV7Schema.safeParse(saleId).success)
      throw invalid('saleId', 'saleId must be a UUID v7');
  };

  /** Shared tail of createReturn/voidSale (runs inside the lock). */
  const finish = async (args: {
    kind: 'return' | 'void';
    saleId: string | undefined;
    reason: string;
    approvalToken: string | undefined;
    originalSaleId: string;
    pick: (rc: ReturnContext) => { lineId: string; quantity: number }[];
    refund: (rc: ReturnContext, comp: ComputedReturn) => PaymentSpec[];
  }): Promise<Invoice> => {
    const session = requireSession(ctx);
    const shop = await loadShop(ctx.driver);
    if (args.saleId !== undefined) {
      const existing = await loadInvoiceBy(ctx.driver, 'id', args.saleId);
      if (existing !== null) return existing;
    }
    const needed: ApprovalReason[] = canDo(ctx, 'return_void') ? [] : [args.kind];
    const { approvedBy } = resolveApproval(ctx, needed, args.approvalToken);

    const rc = await loadReturnContext(ctx.driver, args.originalSaleId);
    const picked = args.pick(rc);
    const comp = computeReturn(rc, picked);
    if (comp.specs.length === 0) throw new ServiceError('EMPTY_CART', 'Nothing selected to return');
    const payments = args.refund(rc, comp);
    if (payments.some((p) => p.method === 'khata') && rc.original.customerId === null)
      throw new ServiceError('KHATA_NEEDS_CUSTOMER', 'Khata refund needs a customer');
    assertPaymentsMatchTotal(comp.total, payments);

    const invoice = await writeInvoice(ctx, shop, session.user.id, {
      action: args.kind,
      kind: args.kind,
      saleId: args.saleId ?? ctx.newId(),
      originalSaleId: rc.original.id,
      customerId: rc.original.customerId,
      note: withApprovalNote(args.reason, approvedBy),
      lines: comp.specs,
      invoiceDiscount: comp.invoiceDiscount,
      payments,
    });
    if (approvedBy !== null && args.approvalToken !== undefined)
      ctx.approvals.delete(args.approvalToken);
    return invoice;
  };

  return guardApi<ReturnsPart>({
    async previewReturn(originalSaleId, lines): Promise<ReturnPreview> {
      requireSession(ctx);
      const rc = await loadReturnContext(ctx.driver, originalSaleId);
      const comp = computeReturn(rc, lines);
      return {
        original: await toInvoiceView(ctx.driver, rc.original),
        lines: toReturnableLines(rc.states),
        total: comp.total,
        suggestedRefund: suggestRefund(rc.original, comp.total),
      };
    },

    async createReturn(i) {
      requireSession(ctx);
      const reason = reqText(i.reason, 'reason', 1, 300);
      checkSaleId(i.saleId);
      if (!Array.isArray(i.lines) || i.lines.length === 0)
        throw new ServiceError('EMPTY_CART', 'Nothing selected to return');
      if (!Array.isArray(i.refund)) throw invalid('refund', 'refund is required');
      const refund = i.refund.map((p, idx): PaymentSpec => {
        const method = PaymentMethodSchema.safeParse(p.method);
        if (!method.success) throw invalid(`refund.${idx}.method`, 'Unknown payment method');
        return {
          method: method.data,
          amount: negPaisa(money(p.amount, `refund.${idx}.amount`, { allowZero: false })),
          reference: optText(p.reference, `refund.${idx}.reference`, 100),
        };
      });
      return ctx.lock(() =>
        finish({
          kind: 'return',
          saleId: i.saleId,
          reason,
          approvalToken: i.approvalToken,
          originalSaleId: i.originalSaleId,
          pick: () => i.lines,
          refund: () => refund,
        }),
      );
    },

    async voidSale(i) {
      requireSession(ctx);
      const reason = reqText(i.reason, 'reason', 1, 300);
      checkSaleId(i.saleId);
      return ctx.lock(() =>
        finish({
          kind: 'void',
          saleId: i.saleId,
          reason,
          approvalToken: i.approvalToken,
          originalSaleId: i.originalSaleId,
          pick: (rc) => {
            const left = rc.states.filter((s) => s.remainingQty > 0);
            if (left.length === 0)
              throw new ServiceError(
                'ALREADY_RETURNED',
                'Every unit of this sale was already returned',
              );
            return left.map((s) => ({ lineId: s.line.id, quantity: s.remainingQty }));
          },
          // the refund mirrors the original payments (scaled if part of the sale was returned earlier)
          refund: (rc, comp) =>
            suggestRefund(rc.original, comp.total).map((p) => ({
              method: p.method,
              amount: paisa(p.amount),
              reference: null,
            })),
        }),
      );
    },
  });
}
