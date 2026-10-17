import {
  GENESIS_HASH,
  HASH_VERSION,
  allocate,
  assertPaymentsMatchTotal,
  discountBps,
  exceedsDiscountLimit,
  formatInvoiceNo,
  mulPaisa,
  paisa,
  saleTotals,
  sealInvoice,
  sumPaisa,
} from '@pos/core';
import {
  PAYMENT_METHODS,
  hasPermission,
  isServiceError,
  isUuidV7,
  type ApprovalReason,
  type CartPreview,
  type CheckoutDraft,
  type Id,
  type Invoice,
  type InvoiceSummary,
  type InvoiceView,
  type Paisa,
  type PaymentInput,
  type PaymentMethod,
  type PosService,
  type ReturnableLine,
  type ReturnLineInput,
  type SaleKind,
  type SaleLine,
  type SalePayment,
} from '@pos/shared';
import type { SqlValue, Statement } from '../driver';
import {
  consumeApproval,
  emit,
  insert,
  loadMeta,
  one,
  phoneLabel,
  q,
  requirePerm,
  scalar,
  takeApproval,
  variantLabel,
  write,
  type Ctx,
  type Meta,
} from './context';
import { customerBalance, ledgerStatement } from './parties';
import { discountMoney, fail, intIn, invalid, money, optText } from './errors';

const MAX_CHAIN_RETRIES = 2;

interface LineSpec {
  productId: Id;
  phoneUnitId: Id | null;
  variantId: Id | null;
  description: string;
  quantity: number;
  unitPrice: Paisa;
  costPrice: Paisa;
  discountAmount: Paisa;
  onHand: number;
}

interface Cart {
  items: LineSpec[];
  lineTotals: Paisa[];
  gross: Paisa;
  lineDiscounts: Paisa;
  subtotal: Paisa;
  invoiceDiscount: Paisa;
  total: Paisa;
  customer: { id: Id; creditLimit: number | null } | null;
  balance: number;
}

const slice200 = (s: string): string => s.slice(0, 200);

/** Validates the cart against live stock and prices it. Same checks, in the same order, as SalesService.cs. */
async function priceCart(ctx: Ctx, draft: CheckoutDraft, meta: Meta): Promise<Cart> {
  if (!Array.isArray(draft.lines) || draft.lines.length === 0)
    fail('EMPTY_CART', 'The cart is empty');
  const invoiceDiscount =
    draft.invoiceDiscount === undefined
      ? 0
      : discountMoney(draft.invoiceDiscount, 'invoiceDiscount');

  let customer: Cart['customer'] = null;
  let balance = 0;
  if (draft.customerId !== undefined && draft.customerId !== null) {
    const row = await one<{ id: string; is_active: number; credit_limit: number | null }>(
      ctx,
      'SELECT id, is_active, credit_limit FROM customers WHERE id = ?',
      [draft.customerId],
    );
    if (!row || row.is_active === 0)
      fail('NOT_FOUND', 'Customer not found', { id: draft.customerId });
    customer = { id: (row as { id: string }).id, creditLimit: row?.credit_limit ?? null };
    balance = await customerBalance(ctx, customer.id);
  }

  const requested = new Map<string, number>();
  for (const l of draft.lines)
    if (l.variantId)
      requested.set(
        l.variantId,
        (requested.get(l.variantId) ?? 0) + (Number.isSafeInteger(l.quantity) ? l.quantity : 0),
      );

  const items: LineSpec[] = [];
  const usedUnits = new Set<string>();
  const cumulative = new Map<string, number>();
  for (const [idx, l] of draft.lines.entries()) {
    const lineNo = idx + 1;
    const field = `lines.${String(idx)}`;
    const phoneUnitId = l.phoneUnitId ?? null;
    const variantId = l.variantId ?? null;
    if ((phoneUnitId === null) === (variantId === null))
      invalid(field, 'Each line needs exactly one of phoneUnitId / variantId');
    const quantity = intIn(l.quantity, `${field}.quantity`, 1, 1_000_000);
    const discount =
      l.discountAmount === undefined || l.discountAmount === null
        ? 0
        : discountMoney(l.discountAmount, `${field}.discountAmount`);

    if (phoneUnitId !== null) {
      if (quantity !== 1) invalid(`${field}.quantity`, 'A phone unit is sold one at a time');
      const u = await one<Record<string, SqlValue>>(
        ctx,
        `SELECT pu.product_id, pu.imei1, pu.serial, pu.colour, pu.ram_gb, pu.storage_gb, pu.sale_price, pu.cost_price,
                p.brand, p.name
         FROM phone_units pu JOIN products p ON p.id = pu.product_id WHERE pu.id = ?`,
        [phoneUnitId],
      );
      if (!u) return fail('NOT_FOUND', 'Phone unit not found', { lineNo });
      const onHand = await scalar(
        ctx,
        'SELECT COALESCE(SUM(quantity), 0) AS n FROM stock_movements WHERE phone_unit_id = ? AND branch_id = ?',
        [phoneUnitId, meta.branchId],
      );
      if (usedUnits.has(phoneUnitId) || onHand !== 1)
        fail('UNIT_NOT_IN_STOCK', 'This phone is not in stock', { lineNo, phoneUnitId });
      usedUnits.add(phoneUnitId);
      const idText = u.imei1 !== null ? `IMEI ${String(u.imei1)}` : `SN ${String(u.serial ?? '')}`;
      const label = phoneLabel(
        String(u.brand),
        String(u.name),
        u.colour === null ? null : String(u.colour),
        u.ram_gb === null ? null : Number(u.ram_gb),
        u.storage_gb === null ? null : Number(u.storage_gb),
      );
      items.push({
        productId: String(u.product_id),
        phoneUnitId,
        variantId: null,
        description: slice200(`${label} · ${idText}`),
        quantity: 1,
        unitPrice: paisa(Number(u.sale_price)),
        costPrice: paisa(Number(u.cost_price)),
        discountAmount: paisa(discount),
        onHand: 1,
      });
    } else {
      const v = await one<Record<string, SqlValue>>(
        ctx,
        `SELECT av.id, av.product_id, av.model, av.colour, av.sale_price, av.cost_price, av.is_active, p.brand, p.name,
                COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm
                          WHERE sm.variant_id = av.id AND sm.branch_id = ?), 0) AS on_hand
         FROM accessory_variants av JOIN products p ON p.id = av.product_id WHERE av.id = ?`,
        [meta.branchId, variantId],
      );
      if (!v || Number(v.is_active) === 0)
        return fail('NOT_FOUND', 'Accessory not found', { lineNo });
      const vid = String(v.id);
      const cum = (cumulative.get(vid) ?? 0) + quantity;
      cumulative.set(vid, cum);
      const onHand = Number(v.on_hand);
      if (!meta.allowNegativeStock && cum > onHand)
        fail('STOCK_INSUFFICIENT', 'Not enough stock', {
          onHand,
          requested: requested.get(vid) ?? cum,
          lineNo,
        });
      items.push({
        productId: String(v.product_id),
        phoneUnitId: null,
        variantId: vid,
        description: slice200(
          variantLabel(
            String(v.brand),
            String(v.name),
            v.model === null ? null : String(v.model),
            v.colour === null ? null : String(v.colour),
          ),
        ),
        quantity,
        unitPrice: paisa(Number(v.sale_price)),
        costPrice: paisa(Number(v.cost_price)),
        discountAmount: paisa(discount),
        onHand,
      });
    }
  }

  const totals = saleTotals(items, paisa(invoiceDiscount));
  return {
    items,
    lineTotals: totals.lineTotals,
    gross: sumPaisa(items.map((i) => mulPaisa(i.unitPrice, i.quantity))),
    lineDiscounts: sumPaisa(items.map((i) => i.discountAmount)),
    subtotal: totals.subtotal,
    invoiceDiscount: paisa(invoiceDiscount),
    total: totals.total,
    customer,
    balance,
  };
}

export function parsePayments(payments: unknown): PaymentInput[] {
  if (!Array.isArray(payments)) return invalid('payments', 'payments are required');
  return payments.map((p: unknown, idx) => {
    const field = `payments.${String(idx)}`;
    if (typeof p !== 'object' || p === null)
      return invalid(field, 'Each payment must be an object');
    const o = p as Record<string, unknown>;
    if (typeof o.method !== 'string' || !(PAYMENT_METHODS as readonly string[]).includes(o.method))
      invalid(`${field}.method`, 'Unknown payment method');
    return {
      method: o.method as PaymentMethod,
      amount: money(o.amount, `${field}.amount`, { allowZero: false }),
      reference: optText(o.reference, `${field}.reference`, 100),
    };
  });
}

// ---------------- reading invoices ----------------

export async function loadInvoice(ctx: Ctx, idOrNo: string): Promise<Invoice | null> {
  const s = await one(ctx, 'SELECT * FROM sales WHERE id = ? OR invoice_no = ?', [idOrNo, idOrNo]);
  if (!s) return null;
  const id = String(s.id);
  const lines = await q(ctx, 'SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY line_no', [id]);
  const pays = await q(ctx, 'SELECT * FROM payments WHERE sale_id = ? ORDER BY id', [id]);
  const n = (v: SqlValue | undefined): number => Number(v ?? 0);
  const sn = (v: SqlValue | undefined): string | null =>
    v === null || v === undefined ? null : String(v);
  return {
    id,
    deviceId: String(s.device_id),
    seq: n(s.seq),
    invoiceNo: String(s.invoice_no),
    kind: String(s.kind) as SaleKind,
    originalSaleId: sn(s.original_sale_id),
    branchId: String(s.branch_id),
    customerId: sn(s.customer_id),
    cashierId: String(s.cashier_id),
    subtotal: paisa(n(s.subtotal)),
    discountTotal: paisa(n(s.discount_total)),
    total: paisa(n(s.total)),
    note: sn(s.note),
    createdAt: n(s.created_at),
    hashVersion: n(s.hash_version),
    prevHash: String(s.prev_hash),
    hash: String(s.hash),
    lines: lines.map((l): SaleLine => ({
      id: String(l.id),
      saleId: id,
      lineNo: n(l.line_no),
      productId: String(l.product_id),
      phoneUnitId: sn(l.phone_unit_id),
      variantId: sn(l.variant_id),
      description: String(l.description),
      quantity: n(l.quantity),
      unitPrice: paisa(n(l.unit_price)),
      costPrice: paisa(n(l.cost_price)),
      discountAmount: paisa(n(l.discount_amount)),
      lineTotal: paisa(n(l.line_total)),
      createdAt: n(l.created_at),
    })),
    payments: pays.map((p): SalePayment => ({
      id: String(p.id),
      saleId: id,
      method: String(p.method) as PaymentMethod,
      amount: paisa(n(p.amount)),
      reference: sn(p.reference),
      createdAt: n(p.created_at),
    })),
  };
}

async function toView(ctx: Ctx, inv: Invoice): Promise<InvoiceView> {
  const r = await one<{
    customer_name: string | null;
    cashier_name: string | null;
    original_no: string | null;
  }>(
    ctx,
    `SELECT (SELECT name FROM customers WHERE id = ?) AS customer_name,
            (SELECT display_name FROM users WHERE id = ?) AS cashier_name,
            (SELECT invoice_no FROM sales WHERE id = ?) AS original_no`,
    [inv.customerId, inv.cashierId, inv.originalSaleId],
  );
  return {
    invoice: inv,
    customerName: r?.customer_name ?? null,
    cashierName: r?.cashier_name ?? '—',
    originalInvoiceNo: r?.original_no ?? null,
  };
}

// ---------------- writing invoices ----------------

interface InvoiceDraft {
  kind: SaleKind;
  saleId: Id;
  originalSaleId: Id | null;
  customerId: Id | null;
  cashierId: Id;
  /** lineNo is optional: a sale numbers its lines 1..n, a return reuses the original line numbers. */
  lines: (Omit<SaleLine, 'id' | 'saleId' | 'lineNo' | 'createdAt'> & { lineNo?: number })[];
  subtotal: Paisa;
  discountTotal: Paisa;
  total: Paisa;
  payments: { method: PaymentMethod; amount: number; reference: string | null }[];
  note: string | null;
}

/** head -> seal -> licence -> ONE atomic batch with stock movements, khata entries and outbox rows. */
async function writeInvoice(ctx: Ctx, meta: Meta, d: InvoiceDraft): Promise<Invoice> {
  for (let attempt = 0; ; attempt++) {
    try {
      const head = await one<{ seq: number; hash: string; created_at: number }>(
        ctx,
        'SELECT seq, hash, created_at FROM sales WHERE device_id = ? ORDER BY seq DESC LIMIT 1',
        [meta.deviceId],
      );
      const seq = (head?.seq ?? 0) + 1;
      const prevHash = head?.hash ?? GENESIS_HASH;
      const createdAt = Math.max(ctx.now(), head?.created_at ?? 0); // invoices never go back in time

      const invoice = sealInvoice(prevHash, {
        id: d.saleId,
        deviceId: meta.deviceId,
        seq,
        invoiceNo: formatInvoiceNo(meta.prefix, seq),
        kind: d.kind,
        originalSaleId: d.originalSaleId,
        branchId: meta.branchId,
        customerId: d.customerId,
        cashierId: d.cashierId,
        subtotal: d.subtotal,
        discountTotal: d.discountTotal,
        total: d.total,
        note: d.note,
        createdAt,
        hashVersion: HASH_VERSION,
        lines: d.lines.map((l, i) => ({
          ...l,
          id: ctx.newId(),
          saleId: d.saleId,
          lineNo: l.lineNo ?? i + 1,
          createdAt,
        })),
        payments: d.payments.map((p) => ({
          id: ctx.newId(),
          saleId: d.saleId,
          method: p.method,
          amount: paisa(p.amount),
          reference: p.reference,
          createdAt,
        })),
      });

      ctx.licence(d.kind, meta.branchId, createdAt);

      const { lines, payments, ...header } = invoice;
      const stmts: Statement[] = [
        insert('sales', {
          id: invoice.id,
          device_id: invoice.deviceId,
          seq: invoice.seq,
          invoice_no: invoice.invoiceNo,
          kind: invoice.kind,
          original_sale_id: invoice.originalSaleId,
          branch_id: invoice.branchId,
          customer_id: invoice.customerId,
          cashier_id: invoice.cashierId,
          subtotal: invoice.subtotal,
          discount_total: invoice.discountTotal,
          total: invoice.total,
          note: invoice.note,
          created_at: invoice.createdAt,
          hash_version: invoice.hashVersion,
          prev_hash: invoice.prevHash,
          hash: invoice.hash,
        }),
      ];
      for (const l of lines)
        stmts.push(
          insert('sale_lines', {
            id: l.id,
            sale_id: l.saleId,
            line_no: l.lineNo,
            product_id: l.productId,
            phone_unit_id: l.phoneUnitId,
            variant_id: l.variantId,
            description: l.description,
            quantity: l.quantity,
            unit_price: l.unitPrice,
            cost_price: l.costPrice,
            discount_amount: l.discountAmount,
            line_total: l.lineTotal,
            created_at: l.createdAt,
          }),
        );
      for (const p of payments)
        stmts.push(
          insert('payments', {
            id: p.id,
            sale_id: p.saleId,
            method: p.method,
            amount: p.amount,
            reference: p.reference,
            created_at: p.createdAt,
          }),
        );
      stmts.push(emit(ctx, 'sale', invoice.id, { ...header, lines, payments }, createdAt));

      // stock is a ledger: a sale appends -quantity, a return/void appends +quantity
      for (const l of lines) {
        const id = ctx.newId();
        const row = {
          id,
          branch_id: meta.branchId,
          type: d.kind,
          phone_unit_id: l.phoneUnitId,
          variant_id: l.variantId,
          quantity: -l.quantity,
          unit_cost: l.costPrice,
          ref_type: 'sale',
          ref_id: invoice.id,
          reason: null,
          created_by: d.cashierId,
          created_at: createdAt,
        };
        stmts.push(insert('stock_movements', row), emit(ctx, 'stock_movement', id, row, createdAt));
      }

      const khata = payments.filter((p) => p.method === 'khata').reduce((a, p) => a + p.amount, 0);
      if (khata !== 0 && invoice.customerId !== null)
        stmts.push(
          ...ledgerStatement(ctx, {
            customerId: invoice.customerId,
            type: d.kind === 'sale' ? 'sale_credit' : 'return_credit',
            amount: khata,
            saleId: invoice.id,
            note: d.kind === 'sale' ? null : d.note,
            userId: d.cashierId,
            t: createdAt,
          }),
        );

      await write(ctx, stmts);
      return invoice;
    } catch (e) {
      // Only a second writer can fork the chain; under ctx.lock it cannot happen. Retry like the C# side.
      if (isServiceError(e) && e.code === 'CHAIN_CONFLICT' && attempt < MAX_CHAIN_RETRIES) continue;
      throw e;
    }
  }
}

// ---------------- returns ----------------

async function returnedSoFar(
  ctx: Ctx,
  orig: Invoice,
): Promise<Map<number, { qty: number; discount: number }>> {
  const rows = await q<{ line_no: number; qty: number; disc: number }>(
    ctx,
    `SELECT sl.line_no, SUM(-sl.quantity) AS qty, SUM(-sl.discount_amount) AS disc
     FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
     WHERE s.original_sale_id = ? GROUP BY sl.line_no`,
    [orig.id],
  );
  return new Map(
    rows.map((r) => [Number(r.line_no), { qty: Number(r.qty), discount: Number(r.disc) }]),
  );
}

function returnableLines(orig: Invoice, done: Map<number, { qty: number }>): ReturnableLine[] {
  return orig.lines.map((l) => {
    const r = done.get(l.lineNo)?.qty ?? 0;
    return {
      lineId: l.id,
      lineNo: l.lineNo,
      description: l.description,
      soldQty: l.quantity,
      returnedQty: r,
      remainingQty: l.quantity - r,
      unitPrice: l.unitPrice,
    };
  });
}

interface ReturnPlan {
  orig: Invoice;
  lines: InvoiceDraft['lines'];
  subtotal: Paisa;
  discountTotal: Paisa;
  total: Paisa;
}

/** Plans a (partial) return. Each return line reuses the original line number, so returns add up per line. */
async function planReturn(
  ctx: Ctx,
  originalSaleId: Id,
  pick: readonly ReturnLineInput[],
): Promise<ReturnPlan> {
  const orig = await loadInvoice(ctx, originalSaleId);
  if (!orig || orig.id !== originalSaleId) return fail('NOT_FOUND', 'Invoice not found');
  if (orig.kind !== 'sale') fail('RETURN_NOT_ALLOWED', 'Only sales can be returned');
  const done = await returnedSoFar(ctx, orig);
  const merged = new Map<Id, number>(); // the same line picked twice counts once
  for (const [idx, p] of pick.entries())
    merged.set(
      p.lineId,
      (merged.get(p.lineId) ?? 0) +
        intIn(p.quantity, `lines.${String(idx)}.quantity`, 0, 1_000_000),
    );
  const lines: InvoiceDraft['lines'] = [];
  for (const [lineId, qty] of merged) {
    if (qty === 0) continue;
    const p = { lineId };
    const src = orig.lines.find((l) => l.id === p.lineId);
    if (!src) return fail('NOT_FOUND', 'Line not found', { lineId: p.lineId });
    const prior = done.get(src.lineNo) ?? { qty: 0, discount: 0 };
    const remaining = src.quantity - prior.qty;
    if (qty > remaining) fail('ALREADY_RETURNED', 'More than remaining quantity', { remaining });
    // proportional discount share; the final unit takes the remainder so it always nets to zero
    const share =
      qty === remaining
        ? src.discountAmount - prior.discount
        : Math.floor((src.discountAmount * qty) / src.quantity);
    lines.push({
      productId: src.productId,
      phoneUnitId: src.phoneUnitId,
      variantId: src.variantId,
      description: src.description,
      quantity: -qty,
      unitPrice: src.unitPrice,
      costPrice: src.costPrice,
      discountAmount: paisa(-share),
      lineTotal: paisa(-(qty * src.unitPrice - share)),
      lineNo: src.lineNo,
    });
  }
  if (lines.length === 0) invalid('lines', 'Nothing selected to return');
  const subtotal = sumPaisa(lines.map((l) => l.lineTotal));
  const origSub = orig.subtotal === 0 ? 1 : orig.subtotal;
  const invDisc =
    orig.discountTotal === 0 ? 0 : Math.floor((orig.discountTotal * Math.abs(subtotal)) / origSub);
  return {
    orig,
    lines,
    subtotal,
    discountTotal: paisa(-invDisc),
    total: paisa(subtotal + invDisc),
  };
}

export function checkoutApi(ctx: Ctx): PosService['checkout'] {
  const cashierOrFail = (): Id => requirePerm(ctx, 'sell').user.id;

  async function finishReturn(
    kind: 'return' | 'void',
    plan: ReturnPlan,
    refund: readonly PaymentInput[],
    reason: string,
    saleId: Id | undefined,
    meta: Meta,
  ): Promise<Invoice> {
    const pays = parsePayments(refund).map((p) => ({
      ...p,
      amount: -p.amount,
      reference: p.reference ?? null,
    }));
    assertPaymentsMatchTotal(
      plan.total,
      pays.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
    );
    if (pays.some((p) => p.method === 'khata') && !plan.orig.customerId)
      fail('KHATA_NEEDS_CUSTOMER', 'Khata refund needs a customer');
    const lines = [...plan.lines].sort((a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0));
    return writeInvoice(ctx, meta, {
      kind,
      saleId: saleId ?? ctx.newId(),
      originalSaleId: plan.orig.id,
      customerId: plan.orig.customerId,
      cashierId: cashierOrFail(),
      lines,
      subtotal: plan.subtotal,
      discountTotal: plan.discountTotal,
      total: plan.total,
      payments: pays.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference })),
      note: reason,
    });
  }

  const guardReturn = (token: string | undefined, reason: ApprovalReason): void => {
    const s = requirePerm(ctx, 'sell');
    if (!hasPermission(s.user.role, 'return_void')) takeApproval(ctx, token, reason);
  };

  return {
    async preview(draft): Promise<CartPreview> {
      requirePerm(ctx, 'sell');
      const meta = await loadMeta(ctx);
      const cart = await priceCart(ctx, draft, meta);
      const disc = cart.lineDiscounts + cart.invoiceDiscount;
      const needsApproval: ApprovalReason[] = [];
      if (!ctx.session || !hasPermission(ctx.session.user.role, 'discount_unlimited')) {
        if (exceedsDiscountLimit(disc, cart.gross, meta.maxDiscountBps))
          needsApproval.push('discount');
      }
      return {
        lines: cart.items.map((it, i) => ({
          lineNo: i + 1,
          description: it.description,
          quantity: it.quantity,
          unitPrice: it.unitPrice,
          discountAmount: it.discountAmount,
          lineTotal: cart.lineTotals[i] ?? paisa(0),
          onHand: it.onHand,
        })),
        grossTotal: cart.gross,
        lineDiscounts: cart.lineDiscounts,
        subtotal: cart.subtotal,
        invoiceDiscount: cart.invoiceDiscount,
        total: cart.total,
        effectiveDiscountBps: discountBps(disc, cart.gross),
        needsApproval,
        customerBalance: cart.customer ? paisa(cart.balance) : null,
        creditLimit:
          cart.customer?.creditLimit === null || !cart.customer
            ? null
            : paisa(cart.customer.creditLimit),
      };
    },

    commit: (input) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const meta = await loadMeta(ctx);
        if (input.saleId !== undefined && !isUuidV7(input.saleId))
          invalid('saleId', 'saleId must be a UUID v7');
        const note = optText(input.note, 'note', 400);
        if (input.saleId) {
          const existing = await loadInvoice(ctx, input.saleId);
          if (existing) return existing; // idempotent retry
        }
        const cart = await priceCart(ctx, input, meta);
        const payments = parsePayments(input.payments);
        const khata = payments
          .filter((p) => p.method === 'khata')
          .reduce((a, p) => a + p.amount, 0);
        if (khata > 0 && !cart.customer) fail('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
        assertPaymentsMatchTotal(
          cart.total,
          payments.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
        );

        const needed: ApprovalReason[] = [];
        if (!hasPermission(s.user.role, 'discount_unlimited')) {
          if (
            exceedsDiscountLimit(
              cart.lineDiscounts + cart.invoiceDiscount,
              cart.gross,
              meta.maxDiscountBps,
            )
          )
            needed.push('discount');
          const limit = cart.customer?.creditLimit;
          if (khata > 0 && limit !== null && limit !== undefined && cart.balance + khata > limit)
            needed.push('credit_limit');
        }
        let approvedBy: string | null = null;
        const first = needed[0];
        if (first) {
          try {
            approvedBy = takeApproval(ctx, input.approvalToken, first);
          } catch (e) {
            if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED') e.details.reasons = needed;
            throw e;
          }
        }
        const finalNote =
          approvedBy === null
            ? note
            : note === null
              ? `approved:${approvedBy}`
              : `${note} | approved:${approvedBy}`;

        const invoice = await writeInvoice(ctx, meta, {
          kind: 'sale',
          saleId: input.saleId ?? ctx.newId(),
          originalSaleId: null,
          customerId: cart.customer?.id ?? null,
          cashierId: s.user.id,
          lines: cart.items.map((it, i) => ({
            productId: it.productId,
            phoneUnitId: it.phoneUnitId,
            variantId: it.variantId,
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unitPrice,
            costPrice: it.costPrice,
            discountAmount: it.discountAmount,
            lineTotal: cart.lineTotals[i] ?? paisa(0),
          })),
          subtotal: cart.subtotal,
          discountTotal: cart.invoiceDiscount,
          total: cart.total,
          payments: payments.map((p) => ({
            method: p.method,
            amount: p.amount,
            reference: p.reference ?? null,
          })),
          note: finalNote,
        });
        if (approvedBy !== null) consumeApproval(ctx, input.approvalToken); // only after the write succeeded
        return invoice;
      }),

    async getInvoice(idOrNo) {
      requirePerm(ctx, 'sell');
      const inv = await loadInvoice(ctx, idOrNo);
      return inv ? toView(ctx, inv) : fail('NOT_FOUND', 'Invoice not found');
    },

    async listInvoices(f = {}) {
      requirePerm(ctx, 'sell');
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (f.fromMs !== undefined) {
        where.push('s.created_at >= ?');
        params.push(f.fromMs);
      }
      if (f.toMs !== undefined) {
        where.push('s.created_at < ?');
        params.push(f.toMs);
      }
      if (f.kind) {
        where.push('s.kind = ?');
        params.push(f.kind);
      }
      if (f.customerId) {
        where.push('s.customer_id = ?');
        params.push(f.customerId);
      }
      const qy = f.q?.trim();
      if (qy) {
        where.push(
          `(lower(s.invoice_no) LIKE ? OR EXISTS (SELECT 1 FROM sale_lines sl JOIN phone_units pu ON pu.id = sl.phone_unit_id
             WHERE sl.sale_id = s.id AND (pu.imei1 = ? OR pu.imei2 = ? OR pu.serial = ?)))`,
        );
        params.push(`%${qy.toLowerCase()}%`, qy, qy, qy);
      }
      const rows = await q(
        ctx,
        `SELECT s.id, s.invoice_no, s.kind, s.created_at, s.total,
                c.name AS customer_name, u.display_name AS cashier_name,
                COALESCE((SELECT SUM(-r.total) FROM sales r WHERE r.original_sale_id = s.id), 0) AS returned_total
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.cashier_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY s.seq DESC LIMIT ?`,
        [...params, f.limit ?? 200],
      );
      return rows.map((r): InvoiceSummary => ({
        id: String(r.id),
        invoiceNo: String(r.invoice_no),
        kind: String(r.kind) as SaleKind,
        createdAt: Number(r.created_at),
        customerName: r.customer_name === null ? null : String(r.customer_name),
        cashierName: r.cashier_name === null ? '—' : String(r.cashier_name),
        total: paisa(Number(r.total)),
        returnedTotal: paisa(Number(r.returned_total)),
      }));
    },

    async previewReturn(id, pick) {
      requirePerm(ctx, 'sell');
      const orig = await loadInvoice(ctx, id);
      if (!orig || orig.id !== id) return fail('NOT_FOUND', 'Invoice not found');
      const done = await returnedSoFar(ctx, orig);
      const effective = pick.filter((p) => p.quantity > 0);
      const plan =
        orig.kind === 'sale' && effective.length > 0 ? await planReturn(ctx, id, effective) : null;
      const total = plan ? plan.total : paisa(0);
      const weights = orig.payments.map((p) => p.amount);
      const suggestedRefund: PaymentInput[] =
        plan && total !== 0 && weights.length > 0
          ? allocate(paisa(Math.abs(total)), weights)
              .map((amount, i) => ({
                method: orig.payments[i]?.method ?? 'cash',
                amount: amount,
              }))
              .filter((r) => r.amount !== 0)
          : [];
      return {
        original: await toView(ctx, orig),
        lines: returnableLines(orig, done),
        total,
        suggestedRefund,
      };
    },

    createReturn: (i) =>
      ctx.lock(async () => {
        guardReturn(i.approvalToken, 'return');
        const meta = await loadMeta(ctx);
        const reason = optText(i.reason, 'reason', 200) ?? invalid('reason', 'Reason is required');
        const plan = await planReturn(ctx, i.originalSaleId, i.lines);
        const inv = await finishReturn('return', plan, i.refund, reason, i.saleId, meta);
        consumeApproval(ctx, i.approvalToken);
        return inv;
      }),

    voidSale: (i) =>
      ctx.lock(async () => {
        guardReturn(i.approvalToken, 'void');
        const meta = await loadMeta(ctx);
        const reason = optText(i.reason, 'reason', 200) ?? invalid('reason', 'Reason is required');
        const orig = await loadInvoice(ctx, i.originalSaleId);
        if (!orig || orig.id !== i.originalSaleId) return fail('NOT_FOUND', 'Invoice not found');
        if (orig.kind !== 'sale') fail('RETURN_NOT_ALLOWED', 'Only sales can be voided');
        const remaining = returnableLines(orig, await returnedSoFar(ctx, orig))
          .filter((l) => l.remainingQty > 0)
          .map((l) => ({ lineId: l.lineId, quantity: l.remainingQty }));
        if (remaining.length === 0) fail('ALREADY_RETURNED', 'Nothing left to void');
        const plan = await planReturn(ctx, orig.id, remaining);
        const refund: PaymentInput[] = allocate(
          paisa(Math.abs(plan.total)),
          orig.payments.map((p) => p.amount),
        )
          .map((amount, idx) => ({
            method: orig.payments[idx]?.method ?? 'cash',
            amount: amount,
          }))
          .filter((p) => p.amount > 0);
        const inv = await finishReturn('void', plan, refund, reason, i.saleId, meta);
        consumeApproval(ctx, i.approvalToken);
        return inv;
      }),
  };
}

/** Every invoice of this device, oldest first (integrity check). */
export async function allInvoices(ctx: Ctx): Promise<Invoice[]> {
  const meta = await loadMeta(ctx);
  const ids = await q<{ id: string }>(
    ctx,
    'SELECT id FROM sales WHERE device_id = ? ORDER BY seq',
    [meta.deviceId],
  );
  const out: Invoice[] = [];
  for (const { id } of ids) {
    const inv = await loadInvoice(ctx, id);
    if (inv) out.push(inv);
  }
  return out;
}
