import { assertPaymentsMatchTotal, paisa } from '@pos/core';
import {
  PaymentMethodSchema,
  REPAIR_STATUSES,
  REPAIR_TRANSITIONS,
  ServiceError,
  pktDate,
  type PaymentInput,
  type PaymentMethod,
  type RepairPart,
  type RepairPayment,
  type RepairPaymentKind,
  type RepairsApi,
  type RepairStatus,
  type RepairStatusChange,
  type RepairTicket,
  type RepairTicketView,
} from '@pos/shared';
import { WriteBatch } from './batch';
import { takeOutParts, unsellableExpired } from './batches';
import { consumeApproval } from './auth';
import { isValidImei } from './catalog';
import { exceedsDiscountLimit, resolveApproval, withApprovalNote } from './checkout';
import { canDo, requirePermission, type Ctx } from './deps';
import { guardApi, intIn, invalid, money, optText, reqText } from './errors';
import { mapRow, variantLabel, type Raw } from './mappers';
import { loadShop } from './meta';
import {
  customerBalance,
  insertLedger,
  insertMovement,
  loadCustomerRec,
  requireVariantView,
} from './queries';
import { insertRec, updateRec } from './rec';
import type { SqlValue } from '../types';

const TICKET_PREFIX = 'R';
const LIST_LIMIT = 200;
const MAX_PART_QTY = 1_000;
const CLOSED: readonly RepairStatus[] = ['delivered', 'cancelled'];
const NON_KHATA = PaymentMethodSchema.exclude(['khata']);
const TICKET_MUTABLE = [
  'problem',
  'conditionNotes',
  'accessories',
  'estimatedCost',
  'finalCharge',
  'technicianId',
  'promisedAt',
  'status',
  'updatedAt',
  'closedAt',
] as const;

const formatTicketNo = (seq: number): string => `${TICKET_PREFIX}-${String(seq).padStart(6, '0')}`;

const notFound = (what: string, id: string): ServiceError =>
  new ServiceError('NOT_FOUND', `${what} not found`, { id });

function cashMethod(m: unknown, field: string): Exclude<PaymentMethod, 'khata'> {
  const parsed = NON_KHATA.safeParse(m);
  if (!parsed.success) throw invalid(field, 'Unknown payment method');
  return parsed.data;
}

function optEpoch(v: unknown, field: string): number | null {
  return v === undefined || v === null ? null : intIn(v, field, 0, Number.MAX_SAFE_INTEGER);
}

function parsePayments(payments: unknown): PaymentInput[] {
  if (!Array.isArray(payments)) throw invalid('payments', 'payments are required');
  return payments.map((p: unknown, idx): PaymentInput => {
    const field = `payments.${String(idx)}`;
    if (typeof p !== 'object' || p === null) throw invalid(field, 'Each payment must be an object');
    const o = p as Record<string, unknown>;
    const method = PaymentMethodSchema.safeParse(o.method);
    if (!method.success) throw invalid(`${field}.method`, 'Unknown payment method');
    return {
      method: method.data,
      amount: money(o.amount, `${field}.amount`, { allowZero: false }),
      reference: optText(o.reference, `${field}.reference`, 100),
    };
  });
}

// ---------------- reading ----------------

/** The ticket_seq column is an internal counter; the contract entity does not carry it. */
function toTicket(row: Raw): RepairTicket {
  const { ticket_seq: _seq, ...rest } = row;
  return mapRow<RepairTicket>(rest);
}

async function loadTicket(ctx: Ctx, idOrNo: string): Promise<RepairTicket> {
  const rows = await ctx.driver.query<Raw>(
    'SELECT * FROM repair_tickets WHERE id = ? OR ticket_no = ?',
    [idOrNo, idOrNo],
  );
  const row = rows[0];
  if (row === undefined) throw notFound('Repair ticket', idOrNo);
  return toTicket(row);
}

async function loadOpenTicket(ctx: Ctx, idOrNo: string): Promise<RepairTicket> {
  const t = await loadTicket(ctx, idOrNo);
  if (CLOSED.includes(t.status))
    throw new ServiceError('IMMUTABLE_RECORD', 'This ticket is closed', { status: t.status });
  return t;
}

async function paidSoFar(ctx: Ctx, ticketId: string): Promise<number> {
  const rows = await ctx.driver.query<{ n: number }>(
    'SELECT COALESCE(SUM(amount), 0) AS n FROM repair_payments WHERE ticket_id = ?',
    [ticketId],
  );
  return rows[0]?.n ?? 0;
}

async function ticketView(ctx: Ctx, idOrNo: string): Promise<RepairTicketView> {
  const ticket = await loadTicket(ctx, idOrNo);
  const tech =
    ticket.technicianId === null
      ? undefined
      : (
          await ctx.driver.query<{ display_name: string }>(
            'SELECT display_name FROM users WHERE id = ?',
            [ticket.technicianId],
          )
        )[0];
  const history = await ctx.driver.query<Raw>(
    `SELECT h.*, u.display_name FROM repair_status_history h JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = ? ORDER BY h.changed_at, h.id`,
    [ticket.id],
  );
  const parts = await ctx.driver.query<Raw>(
    `SELECT rp.*, av.model, av.colour, p.brand, p.name
     FROM repair_parts rp JOIN accessory_variants av ON av.id = rp.variant_id
     JOIN products p ON p.id = av.product_id
     WHERE rp.ticket_id = ? ORDER BY rp.created_at, rp.id`,
    [ticket.id],
  );
  const pays = await ctx.driver.query<Raw>(
    'SELECT * FROM repair_payments WHERE ticket_id = ? ORDER BY created_at, id',
    [ticket.id],
  );
  const payments = pays.map((r) => mapRow<RepairPayment>(r));
  const paidTotal = payments.reduce((a, p) => a + p.amount, 0);
  const due = CLOSED.includes(ticket.status)
    ? 0
    : (ticket.finalCharge ?? ticket.estimatedCost) - paidTotal;
  return {
    ticket,
    technicianName: tech?.display_name ?? null,
    history: history.map((r): RepairStatusChange => {
      const { display_name: name, ...h } = r;
      return {
        ...mapRow<Omit<RepairStatusChange, 'changedByName'>>(h),
        changedByName: String(name),
      };
    }),
    parts: parts.map((r): RepairPart => {
      const { model, colour, brand, name, ...rp } = r;
      return {
        ...mapRow<Omit<RepairPart, 'label'>>(rp),
        label: variantLabel(
          { brand: String(brand), name: String(name) },
          {
            model: typeof model === 'string' ? model : null,
            colour: typeof colour === 'string' ? colour : null,
          },
        ),
      };
    }),
    payments,
    paidTotal: paisa(paidTotal),
    balanceDue: paisa(due),
  };
}

// ---------------- record builders ----------------

function addHistory(
  ctx: Ctx,
  b: WriteBatch,
  h: { ticketId: string; from: RepairStatus | null; to: RepairStatus; note: string | null },
  userId: string,
  at: number,
): void {
  insertRec(b, 'repair_status_history', 'repair_status', {
    id: ctx.newId(),
    ticketId: h.ticketId,
    fromStatus: h.from,
    toStatus: h.to,
    note: h.note,
    changedBy: userId,
    changedAt: at,
  });
}

function addPayment(
  ctx: Ctx,
  b: WriteBatch,
  p: {
    ticketId: string;
    kind: RepairPaymentKind;
    method: PaymentMethod;
    amount: number;
    reference: string | null;
  },
  userId: string,
  at: number,
): void {
  insertRec(b, 'repair_payments', 'repair_payment', {
    id: ctx.newId(),
    ticketId: p.ticketId,
    kind: p.kind,
    method: p.method,
    amount: p.amount,
    reference: p.reference,
    createdBy: userId,
    createdAt: at,
  });
}

async function requireTechnician(ctx: Ctx, id: unknown): Promise<string | null> {
  if (id === undefined || id === null) return null;
  const rows = await ctx.driver.query<{ id: string }>(
    'SELECT id FROM users WHERE id = ? AND is_active = 1',
    [typeof id === 'string' ? id : ''],
  );
  const row = rows[0];
  if (row === undefined)
    throw new ServiceError('NOT_FOUND', 'Technician not found', { field: 'technicianId' });
  return row.id;
}

// ---------------- API ----------------

export function createRepairsApi(ctx: Ctx): RepairsApi {
  return guardApi<RepairsApi>({
    async create(i) {
      const session = requirePermission(ctx, 'sell');
      const imei = optText(i.imei, 'imei', 15);
      if (imei !== null && !isValidImei(imei)) throw invalid('imei', 'imei is not a valid IMEI');
      const deviceBrand = optText(i.deviceBrand, 'deviceBrand', 60) ?? '';
      const deviceModel = reqText(i.deviceModel, 'deviceModel', 1, 120);
      const serial = optText(i.serial, 'serial', 60);
      const problem = reqText(i.problem, 'problem', 1, 400);
      const conditionNotes = optText(i.conditionNotes, 'conditionNotes', 400);
      const accessories = optText(i.accessories, 'accessories', 200);
      const estimatedCost = money(i.estimatedCost, 'estimatedCost');
      const promisedAt = optEpoch(i.promisedAt, 'promisedAt');
      const advance = i.advance ?? null;
      const advanceAmount =
        advance === null ? 0 : money(advance.amount, 'advance.amount', { allowZero: false });
      const advanceMethod = advance === null ? null : cashMethod(advance.method, 'advance.method');
      const advanceRef =
        advance === null ? null : optText(advance.reference, 'advance.reference', 100);

      const id = await ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        let customerId: string | null = null;
        let customerName: string;
        let customerPhone: string | null;
        if (i.customerId !== undefined && i.customerId !== null) {
          const c = await loadCustomerRec(ctx.driver, i.customerId);
          if (!c.isActive) throw notFound('Customer', i.customerId);
          customerId = c.id;
          customerName = c.name;
          customerPhone = c.phone;
        } else {
          if (!i.walkIn) throw invalid('customer', 'Pick a customer or enter a walk-in name');
          customerName = reqText(i.walkIn.name, 'walkIn.name', 1, 120);
          customerPhone = optText(i.walkIn.phone, 'walkIn.phone', 30);
        }
        const technicianId = await requireTechnician(ctx, i.technicianId);
        const seqRows = await ctx.driver.query<{ n: number }>(
          'SELECT COALESCE(MAX(ticket_seq), 0) + 1 AS n FROM repair_tickets',
        );
        const seq = seqRows[0]?.n ?? 1;
        const at = ctx.clock();
        const ticketId = ctx.newId();
        const b = new WriteBatch(ctx.newId, at);
        insertRec(b, 'repair_tickets', 'repair_ticket', {
          id: ticketId,
          ticketSeq: seq,
          ticketNo: formatTicketNo(seq),
          branchId: shop.branchId,
          customerId,
          customerName,
          customerPhone,
          deviceBrand,
          deviceModel,
          imei,
          serial,
          problem,
          conditionNotes,
          accessories,
          estimatedCost,
          finalCharge: null,
          technicianId,
          promisedAt,
          status: 'received',
          createdBy: session.user.id,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
        });
        addHistory(
          ctx,
          b,
          { ticketId, from: null, to: 'received', note: null },
          session.user.id,
          at,
        );
        if (advanceMethod !== null)
          addPayment(
            ctx,
            b,
            {
              ticketId,
              kind: 'advance',
              method: advanceMethod,
              amount: advanceAmount,
              reference: advanceRef,
            },
            session.user.id,
            at,
          );
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return ticketId;
      });
      return ticketView(ctx, id);
    },

    async get(idOrNo) {
      requirePermission(ctx, 'sell');
      return ticketView(ctx, idOrNo);
    },

    async list(f = {}) {
      requirePermission(ctx, 'sell');
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (f.status !== undefined) {
        if (!(REPAIR_STATUSES as readonly string[]).includes(f.status))
          throw invalid('status', 'Unknown repair status');
        where.push('status = ?');
        params.push(f.status);
      }
      if (f.openOnly === true) where.push("status NOT IN ('delivered', 'cancelled')");
      if (f.customerId !== undefined && f.customerId !== '') {
        where.push('customer_id = ?');
        params.push(f.customerId);
      }
      const needle = f.q?.trim().toLowerCase();
      if (needle !== undefined && needle !== '') {
        where.push(
          "lower(ticket_no || ' ' || customer_name || ' ' || COALESCE(customer_phone,'') || ' ' || device_brand || ' ' || device_model || ' ' || COALESCE(imei,'') || ' ' || COALESCE(serial,'')) LIKE ? ESCAPE '\\'",
        );
        params.push(`%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      }
      const limit = f.limit === undefined ? LIST_LIMIT : intIn(f.limit, 'limit', 1, 1_000);
      const rows = await ctx.driver.query<Raw>(
        `SELECT * FROM repair_tickets ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, ticket_seq DESC LIMIT ?`,
        [...params, limit],
      );
      return rows.map(toTicket);
    },

    async update(id, patch) {
      requirePermission(ctx, 'sell');
      await ctx.lock(async () => {
        const cur = await loadOpenTicket(ctx, id);
        const has = (k: keyof typeof patch): boolean =>
          Object.prototype.hasOwnProperty.call(patch, k);
        const at = ctx.clock();
        const next: RepairTicket = { ...cur, updatedAt: at };
        let changed = false;
        if (patch.problem !== undefined) {
          next.problem = reqText(patch.problem, 'problem', 1, 400);
          changed = true;
        }
        if (has('conditionNotes')) {
          next.conditionNotes = optText(patch.conditionNotes, 'conditionNotes', 400);
          changed = true;
        }
        if (has('accessories')) {
          next.accessories = optText(patch.accessories, 'accessories', 200);
          changed = true;
        }
        if (patch.estimatedCost !== undefined) {
          next.estimatedCost = money(patch.estimatedCost, 'estimatedCost');
          changed = true;
        }
        if (has('finalCharge')) {
          next.finalCharge =
            patch.finalCharge === null || patch.finalCharge === undefined
              ? null
              : money(patch.finalCharge, 'finalCharge');
          changed = true;
        }
        if (has('technicianId')) {
          next.technicianId = await requireTechnician(ctx, patch.technicianId);
          changed = true;
        }
        if (has('promisedAt')) {
          next.promisedAt = optEpoch(patch.promisedAt, 'promisedAt');
          changed = true;
        }
        if (!changed) return;
        const shop = await loadShop(ctx.driver);
        const b = new WriteBatch(ctx.newId, at);
        updateRec(b, 'repair_tickets', 'repair_ticket', next, TICKET_MUTABLE);
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
      });
      return ticketView(ctx, id);
    },

    async setStatus(i) {
      const session = requirePermission(ctx, 'sell');
      const ticketId = await ctx.lock(async () => {
        const cur = await loadTicket(ctx, i.ticketId);
        if (!REPAIR_TRANSITIONS[cur.status].includes(i.status))
          throw invalid('status', `Cannot move a ticket from ${cur.status} to ${String(i.status)}`);
        const note = optText(i.note, 'note', 400);
        const shop = await loadShop(ctx.driver);
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        updateRec(
          b,
          'repair_tickets',
          'repair_ticket',
          { ...cur, status: i.status, updatedAt: at },
          ['status', 'updatedAt'],
        );
        addHistory(
          ctx,
          b,
          { ticketId: cur.id, from: cur.status, to: i.status, note },
          session.user.id,
          at,
        );
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return cur.id;
      });
      return ticketView(ctx, ticketId);
    },

    async addPart(i) {
      const session = requirePermission(ctx, 'sell');
      const quantity = intIn(i.quantity, 'quantity', 1, MAX_PART_QTY);
      const ticketId = await ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        const ticket = await loadOpenTicket(ctx, i.ticketId);
        const part = await requireVariantView(ctx.driver, i.variantId, shop.branchId);
        if (!part.variant.isActive) throw notFound('Accessory', i.variantId);
        const at = ctx.clock();
        const today = pktDate(at);
        // Module batch_expiry: like a sale, a repair never fits an expired part, and the parts leave their
        // batches first-expiry-first. Each batch gives its own movement, and repair_parts links one row to one
        // movement, so a part fitted from two batches becomes two part rows that add up to the quantity asked.
        const expired = await unsellableExpired(ctx.driver, shop, part.variant.id, today);
        const sellable = part.onHand - expired;
        if (!shop.settings.allowNegativeStock && sellable < quantity)
          throw new ServiceError('STOCK_INSUFFICIENT', 'Not enough stock', {
            onHand: sellable,
            requested: quantity,
            ...(expired > 0 ? { expiredOnHand: expired } : {}),
          });
        const parts = await takeOutParts(ctx.driver, shop, part.variant.id, quantity, today, {
          includeExpired: false,
        });
        const b = new WriteBatch(ctx.newId, at);
        for (const p of parts) {
          const movementId = ctx.newId();
          // stock_movements.ref_type has no 'repair' value; repair_parts.stock_movement_id is the link back.
          insertMovement(b, {
            id: movementId,
            branchId: shop.branchId,
            type: 'adjustment',
            phoneUnitId: null,
            variantId: part.variant.id,
            batchId: p.batchId,
            quantity: -p.quantity,
            unitCost: part.variant.costPrice,
            refType: null,
            refId: null,
            reason: `Repair part ${ticket.ticketNo}`,
            createdBy: session.user.id,
            createdAt: at,
          });
          insertRec(b, 'repair_parts', 'repair_part', {
            id: ctx.newId(),
            ticketId: ticket.id,
            variantId: part.variant.id,
            quantity: p.quantity,
            unitCost: part.variant.costPrice,
            unitPrice: part.variant.salePrice,
            stockMovementId: movementId,
            createdBy: session.user.id,
            createdAt: at,
          });
        }
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        return ticket.id;
      });
      return ticketView(ctx, ticketId);
    },

    async deliver(i) {
      const session = requirePermission(ctx, 'sell');
      const payments = parsePayments(i.payments);
      const note = optText(i.note, 'note', 400);
      const ticketId = await ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        const ticket = await loadTicket(ctx, i.ticketId);
        if (ticket.status !== 'ready')
          throw invalid('status', `Only a ready ticket can be delivered (it is ${ticket.status})`);
        const finalCharge =
          i.finalCharge === undefined
            ? (ticket.finalCharge ?? ticket.estimatedCost)
            : money(i.finalCharge, 'finalCharge');
        const paid = await paidSoFar(ctx, ticket.id);
        const balance = finalCharge - paid;
        const khata = payments
          .filter((p) => p.method === 'khata')
          .reduce((a, p) => a + p.amount, 0);
        if (khata > 0 && balance < 0) throw invalid('payments', 'A refund cannot go to khata');
        if (khata > 0 && ticket.customerId === null)
          throw new ServiceError('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
        assertPaymentsMatchTotal(
          paisa(Math.abs(balance)),
          payments.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
        );

        // A final charge below the estimate is a discount (same cashier limit as the till); khata over the
        // customer's credit limit needs the same manager approval as a khata sale.
        const needed: ('discount' | 'credit_limit')[] = [];
        if (
          finalCharge < ticket.estimatedCost &&
          !canDo(ctx, 'discount_unlimited') &&
          exceedsDiscountLimit(
            ticket.estimatedCost - finalCharge,
            ticket.estimatedCost,
            shop.settings.cashierMaxDiscountBps,
          )
        )
          needed.push('discount');
        if (khata > 0 && ticket.customerId !== null && !canDo(ctx, 'discount_unlimited')) {
          const customer = await loadCustomerRec(ctx.driver, ticket.customerId);
          if (
            customer.creditLimit !== null &&
            (await customerBalance(ctx.driver, customer.id)) + khata > customer.creditLimit
          )
            needed.push('credit_limit');
        }
        const { approvedBy } = resolveApproval(ctx, needed, i.approvalToken);

        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        updateRec(
          b,
          'repair_tickets',
          'repair_ticket',
          {
            ...ticket,
            status: 'delivered',
            finalCharge: paisa(finalCharge),
            closedAt: at,
            updatedAt: at,
          },
          TICKET_MUTABLE,
        );
        addHistory(
          ctx,
          b,
          {
            ticketId: ticket.id,
            from: ticket.status,
            to: 'delivered',
            note: withApprovalNote(note, approvedBy),
          },
          session.user.id,
          at,
        );
        for (const p of payments)
          addPayment(
            ctx,
            b,
            {
              ticketId: ticket.id,
              kind: balance < 0 ? 'refund' : 'balance',
              method: p.method,
              amount: balance < 0 ? -p.amount : p.amount,
              reference: p.reference ?? null,
            },
            session.user.id,
            at,
          );
        // No repair-specific ledger type exists, so the khata part of a ticket is a customer 'adjustment'.
        if (khata > 0 && ticket.customerId !== null)
          insertLedger(b, {
            id: ctx.newId(),
            customerId: ticket.customerId,
            supplierId: null,
            type: 'adjustment',
            amount: khata,
            method: null,
            saleId: null,
            purchaseId: null,
            note: `Repair ${ticket.ticketNo}`,
            createdBy: session.user.id,
            createdAt: at,
          });
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        if (approvedBy !== null) consumeApproval(ctx, i.approvalToken);
        return ticket.id;
      });
      return ticketView(ctx, ticketId);
    },

    async cancel(i) {
      const session = requirePermission(ctx, 'sell');
      const reason = reqText(i.reason, 'reason', 1, 400);
      const refundMethod =
        i.refundMethod === undefined ? 'cash' : cashMethod(i.refundMethod, 'refundMethod');
      const ticketId = await ctx.lock(async () => {
        const shop = await loadShop(ctx.driver);
        const ticket = await loadTicket(ctx, i.ticketId);
        if (CLOSED.includes(ticket.status))
          throw invalid('status', `A ${ticket.status} ticket cannot be cancelled`);
        const paid = await paidSoFar(ctx, ticket.id);
        const { approvedBy } = resolveApproval(
          ctx,
          paid > 0 && !canDo(ctx, 'return_void') ? ['void'] : [],
          i.approvalToken,
        );
        const at = ctx.clock();
        const b = new WriteBatch(ctx.newId, at);
        updateRec(
          b,
          'repair_tickets',
          'repair_ticket',
          { ...ticket, status: 'cancelled', closedAt: at, updatedAt: at },
          TICKET_MUTABLE,
        );
        addHistory(
          ctx,
          b,
          {
            ticketId: ticket.id,
            from: ticket.status,
            to: 'cancelled',
            note: withApprovalNote(reason, approvedBy),
          },
          session.user.id,
          at,
        );
        // The advance goes back in full. Parts already fitted stay consumed (they were used).
        if (paid > 0)
          addPayment(
            ctx,
            b,
            {
              ticketId: ticket.id,
              kind: 'refund',
              method: refundMethod,
              amount: -paid,
              reference: null,
            },
            session.user.id,
            at,
          );
        await ctx.assertCanSell({ action: 'repair', branchId: shop.branchId, now: at });
        await b.commit(ctx.driver);
        if (approvedBy !== null) consumeApproval(ctx, i.approvalToken);
        return ticket.id;
      });
      return ticketView(ctx, ticketId);
    },
  });
}
