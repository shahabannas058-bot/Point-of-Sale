import {
  GENESIS_HASH,
  InvoiceSchema,
  PaymentMethodSchema,
  ServiceError,
  UuidV7Schema,
  type ApprovalReason,
  type CartPreview,
  type CheckoutApi,
  type CheckoutDraft,
  type GuardAction,
  type Invoice,
  type InvoiceSummary,
  type InvoiceView,
  type Paisa,
  type PaymentMethod,
  type PreviewLine,
  type SaleKind,
  type UnsealedInvoice,
} from '@pos/shared';
import {
  assertPaymentsMatchTotal,
  formatInvoiceNo,
  paisa,
  saleTotals,
  sealInvoice,
  sumPaisa,
  type PricedLine,
} from '@pos/core';
import { WriteBatch } from './batch';
import { lookupApproval } from './auth';
import { canDo, requirePermission, requireSession, type Ctx } from './deps';
import { guardApi, intIn, invalid, mapError, money, optText } from './errors';
import { phoneLabel, type Raw } from './mappers';
import { loadShop, type ShopMeta } from './meta';
import {
  customerBalance,
  insertInvoice,
  insertLedger,
  insertMovement,
  loadCustomerRec,
  loadHead,
  loadInvoiceBy,
  loadPhoneView,
  loadVariantView,
  likePattern,
  phoneUnitInStock,
  requireInvoice,
  type CustomerRec,
} from './queries';
import type { SqlDriver, SqlValue } from '../types';

// ---------- shared invoice writer (used by sales, returns and voids) ----------
export interface LineSpec {
  productId: string;
  phoneUnitId: string | null;
  variantId: string | null;
  description: string;
  /** Signed: positive on a sale, negative on a return/void. */
  quantity: number;
  unitPrice: Paisa;
  costPrice: Paisa;
  /** Signed like quantity * unitPrice. */
  discountAmount: Paisa;
}
export interface PaymentSpec {
  method: PaymentMethod;
  /** Signed like the invoice total. */
  amount: Paisa;
  reference: string | null;
}
export interface InvoiceSpec {
  action: GuardAction;
  kind: SaleKind;
  saleId: string;
  originalSaleId: string | null;
  customerId: string | null;
  note: string | null;
  lines: LineSpec[];
  /** Stored as sales.discount_total (invoice-level only); negative on returns. */
  invoiceDiscount: Paisa;
  payments: PaymentSpec[];
}

const MAX_CHAIN_RETRIES = 2;

/**
 * Steps 5-8 of the commit algorithm. Must run inside ctx.lock. Reads the chain head, seals, calls the
 * licence hook, then writes invoice + stock movements + ledger + outbox in ONE driver.batch.
 */
export async function writeInvoice(
  ctx: Ctx,
  shop: ShopMeta,
  cashierId: string,
  spec: InvoiceSpec,
): Promise<Invoice> {
  const totals = saleTotals(
    spec.lines.map((l): PricedLine => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountAmount: l.discountAmount,
    })),
    spec.invoiceDiscount,
  );
  assertPaymentsMatchTotal(totals.total, spec.payments);

  for (let attempt = 0; ; attempt += 1) {
    try {
      const head = await loadHead(ctx.driver, shop.deviceId);
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;
      // invoices never go back in time, even if the system clock does
      const createdAt = Math.max(ctx.clock(), head?.createdAt ?? 0);
      const unsealed = {
        id: spec.saleId,
        deviceId: shop.deviceId,
        seq,
        invoiceNo: formatInvoiceNo(shop.invoicePrefix, seq),
        kind: spec.kind,
        originalSaleId: spec.originalSaleId,
        branchId: shop.branchId,
        customerId: spec.customerId,
        cashierId,
        subtotal: totals.subtotal,
        discountTotal: spec.invoiceDiscount,
        total: totals.total,
        note: spec.note,
        createdAt,
        hashVersion: 1,
        lines: spec.lines.map((l, i) => ({
          id: ctx.newId(),
          saleId: spec.saleId,
          lineNo: i + 1,
          productId: l.productId,
          phoneUnitId: l.phoneUnitId,
          variantId: l.variantId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          costPrice: l.costPrice,
          discountAmount: l.discountAmount,
          lineTotal: totals.lineTotals[i],
          createdAt,
        })),
        payments: spec.payments.map((p) => ({
          id: ctx.newId(),
          saleId: spec.saleId,
          method: p.method,
          amount: p.amount,
          reference: p.reference,
          createdAt,
        })),
      } as unknown as UnsealedInvoice;
      const invoice = InvoiceSchema.parse(sealInvoice(prevHash, unsealed));

      await ctx.assertCanSell({ action: spec.action, branchId: shop.branchId, now: createdAt });

      const b = new WriteBatch(ctx.newId, createdAt);
      insertInvoice(b, invoice);
      for (const l of invoice.lines)
        insertMovement(b, {
          id: ctx.newId(),
          branchId: shop.branchId,
          type: spec.kind === 'sale' ? 'sale' : 'return',
          phoneUnitId: l.phoneUnitId,
          variantId: l.variantId,
          quantity: -l.quantity,
          unitCost: l.costPrice,
          refType: 'sale',
          refId: invoice.id,
          reason: null,
          createdBy: cashierId,
          createdAt,
        });
      const khata = sumPaisa(
        invoice.payments.filter((p) => p.method === 'khata').map((p) => p.amount),
      );
      if (khata !== 0 && invoice.customerId !== null)
        insertLedger(b, {
          id: ctx.newId(),
          customerId: invoice.customerId,
          supplierId: null,
          type: spec.kind === 'sale' ? 'sale_credit' : 'return_credit',
          amount: khata,
          method: null,
          saleId: invoice.id,
          purchaseId: null,
          note: null,
          createdBy: cashierId,
          createdAt,
        });
      await b.commit(ctx.driver);
      return invoice;
    } catch (e) {
      const mapped = mapError(e);
      // Only a second writer (another window) can fork the chain; under our lock it cannot happen.
      if (mapped.code === 'CHAIN_CONFLICT' && attempt < MAX_CHAIN_RETRIES) continue;
      throw mapped;
    }
  }
}

// ---------- approvals / policy ----------
export function resolveApproval(
  ctx: Ctx,
  needed: ApprovalReason[],
  token: string | undefined,
): { approvedBy: string | null } {
  const first = needed[0];
  if (first === undefined) return { approvedBy: null };
  const approver = lookupApproval(ctx, token);
  if (approver === null)
    throw new ServiceError('APPROVAL_REQUIRED', 'Manager approval is required', {
      reason: first,
      reasons: needed,
    });
  return { approvedBy: approver };
}

export function withApprovalNote(note: string | null, approvedBy: string | null): string | null {
  if (approvedBy === null) return note;
  return [note, `approved:${approvedBy}`].filter((p): p is string => p !== null).join(' | ');
}

/** Exact comparison: discount/gross > maxBps/10000 (no floor, so 1 paisa over the limit counts). */
export const exceedsDiscountLimit = (discount: number, gross: number, maxBps: number): boolean =>
  BigInt(discount) * 10_000n > BigInt(maxBps) * BigInt(gross);

const discountMoney = (v: unknown, field: string): Paisa => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v < 0)
    throw new ServiceError('DISCOUNT_INVALID', `${field} must not be negative`, { field });
  return money(v, field);
};

// ---------- cart pricing ----------
interface PricedItem {
  lineNo: number;
  spec: LineSpec;
  onHand: number;
}
interface PricedCart {
  items: PricedItem[];
  gross: Paisa;
  lineDiscounts: Paisa;
  subtotal: Paisa;
  invoiceDiscount: Paisa;
  total: Paisa;
  customer: CustomerRec | null;
  balance: number;
}

async function priceCart(ctx: Ctx, shop: ShopMeta, draft: CheckoutDraft): Promise<PricedCart> {
  if (!Array.isArray(draft.lines) || draft.lines.length === 0)
    throw new ServiceError('EMPTY_CART', 'The cart is empty');
  const invoiceDiscount =
    draft.invoiceDiscount === undefined
      ? paisa(0)
      : discountMoney(draft.invoiceDiscount, 'invoiceDiscount');

  let customer: CustomerRec | null = null;
  let balance = 0;
  if (draft.customerId !== undefined && draft.customerId !== null) {
    customer = await loadCustomerRec(ctx.driver, draft.customerId);
    if (!customer.isActive) throw new ServiceError('NOT_FOUND', 'Customer not found');
    balance = await customerBalance(ctx.driver, customer.id);
  }

  // total requested per accessory variant across all lines (a variant may appear on several lines)
  const requested = new Map<string, number>();
  for (const l of draft.lines)
    if (l.variantId !== undefined)
      requested.set(
        l.variantId,
        (requested.get(l.variantId) ?? 0) + (Number.isSafeInteger(l.quantity) ? l.quantity : 0),
      );

  const items: PricedItem[] = [];
  const usedUnits = new Set<string>();
  const cumulative = new Map<string, number>();
  for (const [idx, l] of draft.lines.entries()) {
    const lineNo = idx + 1;
    const field = `lines.${idx}`;
    if ((l.phoneUnitId === undefined) === (l.variantId === undefined))
      throw invalid(field, 'Each line needs exactly one of phoneUnitId / variantId');
    const quantity = intIn(l.quantity, `${field}.quantity`, 1, 1_000_000);
    const discount = discountMoney(l.discountAmount ?? 0, `${field}.discountAmount`);

    if (l.phoneUnitId !== undefined) {
      if (quantity !== 1) throw invalid(`${field}.quantity`, 'A phone unit is sold one at a time');
      const view = await loadPhoneView(ctx.driver, l.phoneUnitId);
      if (view === null) throw new ServiceError('NOT_FOUND', 'Phone unit not found', { lineNo });
      if (
        usedUnits.has(l.phoneUnitId) ||
        !(await phoneUnitInStock(ctx.driver, l.phoneUnitId, shop.branchId))
      )
        throw new ServiceError('UNIT_NOT_IN_STOCK', 'This phone is not in stock', {
          lineNo,
          phoneUnitId: l.phoneUnitId,
        });
      usedUnits.add(l.phoneUnitId);
      const id =
        view.unit.imei1 !== null ? `IMEI ${view.unit.imei1}` : `SN ${view.unit.serial ?? ''}`;
      items.push({
        lineNo,
        onHand: 1,
        spec: {
          productId: view.unit.productId,
          phoneUnitId: l.phoneUnitId,
          variantId: null,
          description: `${phoneLabel(view.product, view.unit)} · ${id}`.slice(0, 200),
          quantity: 1,
          unitPrice: view.unit.salePrice,
          costPrice: view.unit.costPrice,
          discountAmount: discount,
        },
      });
    } else {
      const view = await loadVariantView(ctx.driver, l.variantId ?? '', shop.branchId);
      if (view === null || !view.variant.isActive)
        throw new ServiceError('NOT_FOUND', 'Accessory not found', { lineNo });
      const cum = (cumulative.get(view.variant.id) ?? 0) + quantity;
      cumulative.set(view.variant.id, cum);
      if (!shop.settings.allowNegativeStock && cum > view.onHand)
        throw new ServiceError('STOCK_INSUFFICIENT', 'Not enough stock', {
          onHand: view.onHand,
          requested: requested.get(view.variant.id) ?? cum,
          lineNo,
        });
      items.push({
        lineNo,
        onHand: view.onHand,
        spec: {
          productId: view.variant.productId,
          phoneUnitId: null,
          variantId: view.variant.id,
          description: view.label.slice(0, 200),
          quantity,
          unitPrice: view.variant.salePrice,
          costPrice: view.variant.costPrice,
          discountAmount: discount,
        },
      });
    }
  }

  const priced = items.map((it): PricedLine => ({
    quantity: it.spec.quantity,
    unitPrice: it.spec.unitPrice,
    discountAmount: it.spec.discountAmount,
  }));
  const totals = saleTotals(priced, invoiceDiscount);
  return {
    items,
    gross: sumPaisa(items.map((it) => paisa(it.spec.quantity * it.spec.unitPrice))),
    lineDiscounts: sumPaisa(items.map((it) => it.spec.discountAmount)),
    subtotal: totals.subtotal,
    invoiceDiscount,
    total: totals.total,
    customer,
    balance,
  };
}

const effectiveBps = (discount: number, gross: number): number =>
  gross <= 0 ? 0 : Number((BigInt(discount) * 10_000n) / BigInt(gross));

// ---------- views ----------
export async function toInvoiceView(driver: SqlDriver, invoice: Invoice): Promise<InvoiceView> {
  const one = async (sql: string, id: string | null): Promise<string | null> => {
    if (id === null) return null;
    const rows = await driver.query<{ v: string }>(sql, [id]);
    return rows[0]?.v ?? null;
  };
  return {
    invoice,
    customerName: await one('SELECT name AS v FROM customers WHERE id = ?', invoice.customerId),
    cashierName:
      (await one('SELECT display_name AS v FROM users WHERE id = ?', invoice.cashierId)) ?? '',
    originalInvoiceNo: await one(
      'SELECT invoice_no AS v FROM sales WHERE id = ?',
      invoice.originalSaleId,
    ),
  };
}

export type CheckoutPart = Pick<CheckoutApi, 'preview' | 'commit' | 'getInvoice' | 'listInvoices'>;

export function createCheckoutPart(ctx: Ctx): CheckoutPart {
  return guardApi<CheckoutPart>({
    async preview(draft: CheckoutDraft): Promise<CartPreview> {
      requirePermission(ctx, 'sell');
      const shop = await loadShop(ctx.driver);
      const cart = await priceCart(ctx, shop, draft);
      const totalDiscount = cart.lineDiscounts + cart.invoiceDiscount;
      const needsApproval: ApprovalReason[] = [];
      if (
        !canDo(ctx, 'discount_unlimited') &&
        exceedsDiscountLimit(totalDiscount, cart.gross, shop.settings.cashierMaxDiscountBps)
      )
        needsApproval.push('discount');
      const lines: PreviewLine[] = cart.items.map((it) => ({
        lineNo: it.lineNo,
        description: it.spec.description,
        quantity: it.spec.quantity,
        unitPrice: it.spec.unitPrice,
        discountAmount: it.spec.discountAmount,
        lineTotal: paisa(it.spec.quantity * it.spec.unitPrice - it.spec.discountAmount),
        onHand: it.onHand,
      }));
      return {
        lines,
        grossTotal: cart.gross,
        lineDiscounts: cart.lineDiscounts,
        subtotal: cart.subtotal,
        invoiceDiscount: cart.invoiceDiscount,
        total: cart.total,
        effectiveDiscountBps: effectiveBps(totalDiscount, cart.gross),
        needsApproval,
        customerBalance: cart.customer === null ? null : paisa(cart.balance),
        creditLimit:
          cart.customer === null || cart.customer.creditLimit === null
            ? null
            : paisa(cart.customer.creditLimit),
      };
    },

    async commit(input): Promise<Invoice> {
      const session = requirePermission(ctx, 'sell'); // 1. session + permission
      const shop = await loadShop(ctx.driver);
      if (input.saleId !== undefined && !UuidV7Schema.safeParse(input.saleId).success)
        throw invalid('saleId', 'saleId must be a UUID v7');
      const note = optText(input.note, 'note', 400);
      return ctx.lock(async () => {
        if (input.saleId !== undefined) {
          const existing = await loadInvoiceBy(ctx.driver, 'id', input.saleId); // 2. idempotency
          if (existing !== null) return existing;
        }
        const cart = await priceCart(ctx, shop, input); // 1 (empty cart) + 3 stock
        // 4. payments, policy
        if (!Array.isArray(input.payments)) throw invalid('payments', 'payments are required');
        const payments = input.payments.map((p, idx): PaymentSpec => {
          const method = PaymentMethodSchema.safeParse(p.method);
          if (!method.success) throw invalid(`payments.${idx}.method`, 'Unknown payment method');
          return {
            method: method.data,
            amount: money(p.amount, `payments.${idx}.amount`, { allowZero: false }),
            reference: optText(p.reference, `payments.${idx}.reference`, 100),
          };
        });
        const khata = sumPaisa(payments.filter((p) => p.method === 'khata').map((p) => p.amount));
        if (khata > 0 && cart.customer === null)
          throw new ServiceError('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
        assertPaymentsMatchTotal(cart.total, payments);

        const needed: ApprovalReason[] = [];
        if (!canDo(ctx, 'discount_unlimited')) {
          if (
            exceedsDiscountLimit(
              cart.lineDiscounts + cart.invoiceDiscount,
              cart.gross,
              shop.settings.cashierMaxDiscountBps,
            )
          )
            needed.push('discount');
          const limit = cart.customer?.creditLimit ?? null;
          if (khata > 0 && limit !== null && cart.balance + khata > limit)
            needed.push('credit_limit');
        }
        const { approvedBy } = resolveApproval(ctx, needed, input.approvalToken);

        const invoice = await writeInvoice(ctx, shop, session.user.id, {
          action: 'sale',
          kind: 'sale',
          saleId: input.saleId ?? ctx.newId(),
          originalSaleId: null,
          customerId: cart.customer?.id ?? null,
          note: withApprovalNote(note, approvedBy),
          lines: cart.items.map((it) => it.spec),
          invoiceDiscount: cart.invoiceDiscount,
          payments,
        });
        if (approvedBy !== null && input.approvalToken !== undefined)
          ctx.approvals.delete(input.approvalToken); // consumed only after the batch succeeded
        return invoice;
      });
    },

    async getInvoice(idOrInvoiceNo: string): Promise<InvoiceView> {
      requireSession(ctx);
      return toInvoiceView(ctx.driver, await requireInvoice(ctx.driver, idOrInvoiceNo));
    },

    async listInvoices(f = {}): Promise<InvoiceSummary[]> {
      requireSession(ctx);
      const conds: string[] = [];
      const params: SqlValue[] = [];
      if (f.fromMs !== undefined) {
        conds.push('s.created_at >= ?');
        params.push(f.fromMs);
      }
      if (f.toMs !== undefined) {
        conds.push('s.created_at < ?');
        params.push(f.toMs);
      }
      if (f.customerId !== undefined) {
        conds.push('s.customer_id = ?');
        params.push(f.customerId);
      }
      if (f.kind !== undefined) {
        conds.push('s.kind = ?');
        params.push(f.kind);
      }
      if (f.q !== undefined && f.q.trim() !== '') {
        const like = likePattern(f.q.trim());
        conds.push(`(s.invoice_no LIKE ? ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM sale_lines l JOIN phone_units pu ON pu.id = l.phone_unit_id
          WHERE l.sale_id = s.id AND (pu.imei1 LIKE ? ESCAPE '\\' OR pu.imei2 LIKE ? ESCAPE '\\')))`);
        params.push(like, like, like);
      }
      const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
      params.push(limit);
      const rows = await ctx.driver.query<Raw>(
        `SELECT s.id, s.invoice_no, s.kind, s.created_at, c.name AS customer_name, u.display_name AS cashier_name,
           s.total,
           COALESCE((SELECT -SUM(r.total) FROM sales r WHERE r.original_sale_id = s.id), 0) AS returned_total
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id JOIN users u ON u.id = s.cashier_id
         ${conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''}
         ORDER BY s.seq DESC LIMIT ?`,
        params,
      );
      return rows.map((r): InvoiceSummary => ({
        id: r.id as string,
        invoiceNo: r.invoice_no as string,
        kind: r.kind as SaleKind,
        createdAt: Number(r.created_at),
        customerName: (r.customer_name as string | null) ?? null,
        cashierName: r.cashier_name as string,
        total: paisa(Number(r.total)),
        returnedTotal: paisa(Number(r.returned_total)),
      }));
    },
  });
}
