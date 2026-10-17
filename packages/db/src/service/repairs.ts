import { assertPaymentsMatchTotal, exceedsDiscountLimit, paisa } from '@pos/core';
import {
  PAYMENT_METHODS,
  REPAIR_STATUSES,
  REPAIR_TRANSITIONS,
  hasPermission,
  isServiceError,
  type Id,
  type PaymentInput,
  type PaymentMethod,
  type PosRepairsApi,
  type RepairPart,
  type RepairPayment,
  type RepairPaymentKind,
  type RepairStatus,
  type RepairStatusChange,
  type RepairTicket,
  type RepairTicketView,
} from '@pos/shared';
import type { SqlValue, Statement } from '../driver';
import {
  consumeApproval,
  emit,
  insert,
  loadMeta,
  one,
  q,
  requirePerm,
  scalar,
  takeApproval,
  variantLabel,
  variantView,
  write,
  type Ctx,
} from './context';
import { parsePayments } from './checkout';
import { ledgerStatement } from './parties';
import { fail, intIn, invalid, isValidImei, money, optText, text } from './errors';

type Row = Record<string, SqlValue>;
type CashMethod = Exclude<PaymentMethod, 'khata'>;

const TICKET_PREFIX = 'R';
const LIST_LIMIT = 200;
const MAX_PART_QTY = 1_000;

const CLOSED: readonly RepairStatus[] = ['delivered', 'cancelled'];

const formatTicketNo = (seq: number): string => `${TICKET_PREFIX}-${String(seq).padStart(6, '0')}`;

const str = (v: SqlValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);
const num = (v: SqlValue | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const toTicket = (r: Row): RepairTicket => ({
  id: String(r.id),
  ticketNo: String(r.ticket_no),
  branchId: String(r.branch_id),
  customerId: str(r.customer_id),
  customerName: String(r.customer_name),
  customerPhone: str(r.customer_phone),
  deviceBrand: String(r.device_brand),
  deviceModel: String(r.device_model),
  imei: str(r.imei),
  serial: str(r.serial),
  problem: String(r.problem),
  conditionNotes: str(r.condition_notes),
  accessories: str(r.accessories),
  estimatedCost: paisa(Number(r.estimated_cost)),
  finalCharge: r.final_charge === null ? null : paisa(Number(r.final_charge)),
  technicianId: str(r.technician_id),
  promisedAt: num(r.promised_at),
  status: String(r.status) as RepairStatus,
  createdBy: String(r.created_by),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  closedAt: num(r.closed_at),
});

const checkCashMethod = (m: unknown, field: string): CashMethod => {
  if (typeof m !== 'string' || m === 'khata' || !(PAYMENT_METHODS as readonly string[]).includes(m))
    return invalid(field, 'Unknown payment method');
  return m as CashMethod;
};

const optEpoch = (v: unknown, field: string): number | null =>
  v === undefined || v === null ? null : intIn(v, field, 0, Number.MAX_SAFE_INTEGER);

// ---------------- reading ----------------

async function loadTicket(ctx: Ctx, idOrNo: string): Promise<RepairTicket> {
  const r = await one(ctx, 'SELECT * FROM repair_tickets WHERE id = ? OR ticket_no = ?', [
    idOrNo,
    idOrNo,
  ]);
  return r ? toTicket(r) : fail('NOT_FOUND', 'Repair ticket not found', { id: idOrNo });
}

async function loadOpenTicket(ctx: Ctx, id: Id): Promise<RepairTicket> {
  const t = await loadTicket(ctx, id);
  if (CLOSED.includes(t.status))
    fail('IMMUTABLE_RECORD', 'This ticket is closed', { status: t.status });
  return t;
}

const paidSoFar = (ctx: Ctx, ticketId: Id): Promise<number> =>
  scalar(ctx, 'SELECT COALESCE(SUM(amount), 0) AS n FROM repair_payments WHERE ticket_id = ?', [
    ticketId,
  ]);

async function ticketView(ctx: Ctx, idOrNo: string): Promise<RepairTicketView> {
  const ticket = await loadTicket(ctx, idOrNo);
  const tech =
    ticket.technicianId === null
      ? undefined
      : await one<{ display_name: string }>(ctx, 'SELECT display_name FROM users WHERE id = ?', [
          ticket.technicianId,
        ]);
  const history = await q(
    ctx,
    `SELECT h.*, u.display_name FROM repair_status_history h JOIN users u ON u.id = h.changed_by
     WHERE h.ticket_id = ? ORDER BY h.changed_at, h.id`,
    [ticket.id],
  );
  const parts = await q(
    ctx,
    `SELECT rp.*, av.model, av.colour, p.brand, p.name
     FROM repair_parts rp JOIN accessory_variants av ON av.id = rp.variant_id
     JOIN products p ON p.id = av.product_id
     WHERE rp.ticket_id = ? ORDER BY rp.created_at, rp.id`,
    [ticket.id],
  );
  const pays = await q(
    ctx,
    'SELECT * FROM repair_payments WHERE ticket_id = ? ORDER BY created_at, id',
    [ticket.id],
  );
  const payments = pays.map((r): RepairPayment => ({
    id: String(r.id),
    ticketId: ticket.id,
    kind: String(r.kind) as RepairPaymentKind,
    method: String(r.method) as PaymentMethod,
    amount: paisa(Number(r.amount)),
    reference: str(r.reference),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
  }));
  const paidTotal = payments.reduce((a, p) => a + p.amount, 0);
  const due = CLOSED.includes(ticket.status)
    ? 0
    : (ticket.finalCharge ?? ticket.estimatedCost) - paidTotal;
  return {
    ticket,
    technicianName: tech?.display_name ?? null,
    history: history.map((r): RepairStatusChange => ({
      id: String(r.id),
      ticketId: ticket.id,
      fromStatus: str(r.from_status) as RepairStatus | null,
      toStatus: String(r.to_status) as RepairStatus,
      note: str(r.note),
      changedBy: String(r.changed_by),
      changedByName: String(r.display_name),
      changedAt: Number(r.changed_at),
    })),
    parts: parts.map((r): RepairPart => ({
      id: String(r.id),
      ticketId: ticket.id,
      variantId: String(r.variant_id),
      label: variantLabel(String(r.brand), String(r.name), str(r.model), str(r.colour)),
      quantity: Number(r.quantity),
      unitCost: paisa(Number(r.unit_cost)),
      unitPrice: paisa(Number(r.unit_price)),
      createdBy: String(r.created_by),
      createdAt: Number(r.created_at),
    })),
    payments,
    paidTotal: paisa(paidTotal),
    balanceDue: paisa(due),
  };
}

// ---------------- statement builders ----------------

function historyStatements(
  ctx: Ctx,
  h: { ticketId: Id; from: RepairStatus | null; to: RepairStatus; note: string | null },
  userId: Id,
  t: number,
): Statement[] {
  const id = ctx.newId();
  const row = {
    id,
    ticket_id: h.ticketId,
    from_status: h.from,
    to_status: h.to,
    note: h.note,
    changed_by: userId,
    changed_at: t,
  };
  return [insert('repair_status_history', row), emit(ctx, 'repair_status', id, row, t)];
}

function paymentStatements(
  ctx: Ctx,
  p: {
    ticketId: Id;
    kind: RepairPaymentKind;
    method: PaymentMethod;
    amount: number;
    reference: string | null;
  },
  userId: Id,
  t: number,
): Statement[] {
  const id = ctx.newId();
  const row = {
    id,
    ticket_id: p.ticketId,
    kind: p.kind,
    method: p.method,
    amount: p.amount,
    reference: p.reference,
    created_by: userId,
    created_at: t,
  };
  return [insert('repair_payments', row), emit(ctx, 'repair_payment', id, row, t)];
}

/** UPDATE of the ticket row (current status / editable fields) plus its outbox row. */
function ticketUpdate(ctx: Ctx, id: Id, cols: Record<string, SqlValue>, t: number): Statement[] {
  const keys = Object.keys(cols);
  return [
    {
      sql: `UPDATE repair_tickets SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...keys.map((k) => cols[k] ?? null), t, id],
    },
    emit(ctx, 'repair_ticket', id, { id, ...cols, updated_at: t }, t, 'update'),
  ];
}

async function requireTechnician(ctx: Ctx, id: unknown): Promise<Id | null> {
  if (id === undefined || id === null) return null;
  const u = await one(ctx, 'SELECT id FROM users WHERE id = ? AND is_active = 1', [
    typeof id === 'string' ? id : '',
  ]);
  return u ? String(u.id) : fail('NOT_FOUND', 'Technician not found', { field: 'technicianId' });
}

/** Approval from a manager PIN; re-tags APPROVAL_REQUIRED with the reason like checkout does. */
function approvalFor(ctx: Ctx, token: string | undefined, reason: 'discount' | 'void'): string {
  try {
    return takeApproval(ctx, token, reason);
  } catch (e) {
    if (isServiceError(e) && e.code === 'APPROVAL_REQUIRED') e.details.reasons = [reason];
    throw e;
  }
}

const withApproval = (note: string | null, approvedBy: string | null): string | null =>
  approvedBy === null
    ? note
    : note === null
      ? `approved:${approvedBy}`
      : `${note} | approved:${approvedBy}`;

// ---------------- API ----------------

export function repairsApi(ctx: Ctx): PosRepairsApi {
  return {
    create: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const { branchId } = await loadMeta(ctx);
        const t = ctx.now();

        let customerId: Id | null = null;
        let customerName: string;
        let customerPhone: string | null;
        if (i.customerId !== undefined && i.customerId !== null) {
          const c = await one(ctx, 'SELECT * FROM customers WHERE id = ? AND is_active = 1', [
            i.customerId,
          ]);
          if (!c) return fail('NOT_FOUND', 'Customer not found', { id: i.customerId });
          customerId = String(c.id);
          customerName = String(c.name);
          customerPhone = str(c.phone);
        } else {
          if (!i.walkIn) return invalid('customer', 'Pick a customer or enter a walk-in name');
          customerName = text(i.walkIn.name, 'walkIn.name', 120);
          customerPhone = optText(i.walkIn.phone, 'walkIn.phone', 30);
        }

        const imei = optText(i.imei, 'imei', 15);
        if (imei !== null && !isValidImei(imei)) invalid('imei', 'imei is not a valid IMEI');
        const advance = i.advance ?? null;
        const advanceAmount =
          advance === null ? 0 : money(advance.amount, 'advance.amount', { allowZero: false });
        const advanceMethod =
          advance === null ? null : checkCashMethod(advance.method, 'advance.method');

        const seq =
          (await scalar(ctx, 'SELECT COALESCE(MAX(ticket_seq), 0) AS n FROM repair_tickets')) + 1;
        const id = ctx.newId();
        const row = {
          id,
          ticket_seq: seq,
          ticket_no: formatTicketNo(seq),
          branch_id: branchId,
          customer_id: customerId,
          customer_name: customerName,
          customer_phone: customerPhone,
          device_brand: optText(i.deviceBrand, 'deviceBrand', 60) ?? '',
          device_model: text(i.deviceModel, 'deviceModel', 120),
          imei,
          serial: optText(i.serial, 'serial', 60),
          problem: text(i.problem, 'problem', 400),
          condition_notes: optText(i.conditionNotes, 'conditionNotes', 400),
          accessories: optText(i.accessories, 'accessories', 200),
          estimated_cost: money(i.estimatedCost, 'estimatedCost'),
          final_charge: null,
          technician_id: await requireTechnician(ctx, i.technicianId),
          promised_at: optEpoch(i.promisedAt, 'promisedAt'),
          status: 'received',
          created_by: s.user.id,
          created_at: t,
          updated_at: t,
          closed_at: null,
        };
        const stmts: Statement[] = [
          insert('repair_tickets', row),
          emit(ctx, 'repair_ticket', id, row, t),
          ...historyStatements(
            ctx,
            { ticketId: id, from: null, to: 'received', note: null },
            s.user.id,
            t,
          ),
        ];
        if (advanceMethod !== null)
          stmts.push(
            ...paymentStatements(
              ctx,
              {
                ticketId: id,
                kind: 'advance',
                method: advanceMethod,
                amount: advanceAmount,
                reference: optText(advance?.reference, 'advance.reference', 100),
              },
              s.user.id,
              t,
            ),
          );
        await write(ctx, stmts);
        return ticketView(ctx, id);
      }),

    async get(idOrNo) {
      requirePerm(ctx, 'sell');
      return ticketView(ctx, idOrNo);
    },

    async list(f = {}) {
      requirePerm(ctx, 'sell');
      const where: string[] = [];
      const params: SqlValue[] = [];
      if (f.status !== undefined) {
        if (!(REPAIR_STATUSES as readonly string[]).includes(f.status))
          invalid('status', 'Unknown repair status');
        where.push('status = ?');
        params.push(f.status);
      }
      if (f.openOnly) where.push("status NOT IN ('delivered', 'cancelled')");
      if (f.customerId) {
        where.push('customer_id = ?');
        params.push(f.customerId);
      }
      const qy = f.q?.trim().toLowerCase();
      if (qy) {
        where.push(
          "lower(ticket_no || ' ' || customer_name || ' ' || COALESCE(customer_phone,'') || ' ' || device_brand || ' ' || device_model || ' ' || COALESCE(imei,'') || ' ' || COALESCE(serial,'')) LIKE ? ESCAPE '\\'",
        );
        params.push(`%${qy.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      }
      const limit = f.limit === undefined ? LIST_LIMIT : intIn(f.limit, 'limit', 1, 1_000);
      const rows = await q(
        ctx,
        `SELECT * FROM repair_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, ticket_seq DESC LIMIT ?`,
        [...params, limit],
      );
      return rows.map(toTicket);
    },

    update: (id, patch) =>
      ctx.lock(async () => {
        requirePerm(ctx, 'sell');
        await loadOpenTicket(ctx, id);
        const has = (k: keyof typeof patch): boolean =>
          Object.prototype.hasOwnProperty.call(patch, k);
        const cols: Record<string, SqlValue> = {};
        if (patch.problem !== undefined) cols.problem = text(patch.problem, 'problem', 400);
        if (has('conditionNotes'))
          cols.condition_notes = optText(patch.conditionNotes, 'conditionNotes', 400);
        if (has('accessories')) cols.accessories = optText(patch.accessories, 'accessories', 200);
        if (patch.estimatedCost !== undefined)
          cols.estimated_cost = money(patch.estimatedCost, 'estimatedCost');
        if (has('finalCharge'))
          cols.final_charge =
            patch.finalCharge === null || patch.finalCharge === undefined
              ? null
              : money(patch.finalCharge, 'finalCharge');
        if (has('technicianId'))
          cols.technician_id = await requireTechnician(ctx, patch.technicianId);
        if (has('promisedAt')) cols.promised_at = optEpoch(patch.promisedAt, 'promisedAt');
        if (Object.keys(cols).length > 0) await write(ctx, ticketUpdate(ctx, id, cols, ctx.now()));
        return ticketView(ctx, id);
      }),

    setStatus: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const ticket = await loadTicket(ctx, i.ticketId);
        if (!REPAIR_TRANSITIONS[ticket.status].includes(i.status))
          invalid('status', `Cannot move a ticket from ${ticket.status} to ${String(i.status)}`);
        const t = ctx.now();
        await write(ctx, [
          ...ticketUpdate(ctx, ticket.id, { status: i.status }, t),
          ...historyStatements(
            ctx,
            {
              ticketId: ticket.id,
              from: ticket.status,
              to: i.status,
              note: optText(i.note, 'note', 400),
            },
            s.user.id,
            t,
          ),
        ]);
        return ticketView(ctx, ticket.id);
      }),

    addPart: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const meta = await loadMeta(ctx);
        const ticket = await loadOpenTicket(ctx, i.ticketId);
        const quantity = intIn(i.quantity, 'quantity', 1, MAX_PART_QTY);
        const part = await variantView(ctx, meta.branchId, i.variantId);
        if (!part.variant.isActive) fail('NOT_FOUND', 'Accessory not found', { id: i.variantId });
        if (!meta.allowNegativeStock && part.onHand < quantity)
          fail('STOCK_INSUFFICIENT', 'Not enough stock', {
            onHand: part.onHand,
            requested: quantity,
          });
        const t = ctx.now();
        const movementId = ctx.newId();
        const movement = {
          id: movementId,
          branch_id: meta.branchId,
          type: 'adjustment',
          phone_unit_id: null,
          variant_id: part.variant.id,
          quantity: -quantity,
          unit_cost: part.variant.costPrice,
          ref_type: 'repair',
          ref_id: ticket.id,
          reason: 'repair part',
          created_by: s.user.id,
          created_at: t,
        };
        const partId = ctx.newId();
        const partRow = {
          id: partId,
          ticket_id: ticket.id,
          variant_id: part.variant.id,
          quantity,
          unit_cost: part.variant.costPrice,
          unit_price: part.variant.salePrice,
          stock_movement_id: movementId,
          created_by: s.user.id,
          created_at: t,
        };
        await write(ctx, [
          insert('stock_movements', movement),
          emit(ctx, 'stock_movement', movementId, movement, t),
          insert('repair_parts', partRow),
          emit(ctx, 'repair_part', partId, partRow, t),
        ]);
        return ticketView(ctx, ticket.id);
      }),

    deliver: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const meta = await loadMeta(ctx);
        const ticket = await loadTicket(ctx, i.ticketId);
        if (ticket.status !== 'ready')
          invalid('status', `Only a ready ticket can be delivered (it is ${ticket.status})`);
        const finalCharge =
          i.finalCharge === undefined
            ? (ticket.finalCharge ?? ticket.estimatedCost)
            : money(i.finalCharge, 'finalCharge');
        const note = optText(i.note, 'note', 400);
        const payments: PaymentInput[] = parsePayments(i.payments);
        const paid = await paidSoFar(ctx, ticket.id);
        const balance = finalCharge - paid;
        const khata = payments
          .filter((p) => p.method === 'khata')
          .reduce((a, p) => a + p.amount, 0);
        if (khata > 0 && balance < 0) invalid('payments', 'A refund cannot go to khata');
        if (khata > 0 && ticket.customerId === null)
          fail('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
        assertPaymentsMatchTotal(
          paisa(Math.abs(balance)),
          payments.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
        );

        // A final charge below the estimate is a discount: same cashier limit as the till.
        let approvedBy: string | null = null;
        if (
          finalCharge < ticket.estimatedCost &&
          !hasPermission(s.user.role, 'discount_unlimited') &&
          exceedsDiscountLimit(
            ticket.estimatedCost - finalCharge,
            ticket.estimatedCost,
            meta.maxDiscountBps,
          )
        )
          approvedBy = approvalFor(ctx, i.approvalToken, 'discount');

        const t = ctx.now();
        const stmts: Statement[] = [
          ...ticketUpdate(
            ctx,
            ticket.id,
            { status: 'delivered', final_charge: finalCharge, closed_at: t },
            t,
          ),
          ...historyStatements(
            ctx,
            {
              ticketId: ticket.id,
              from: ticket.status,
              to: 'delivered',
              note: withApproval(note, approvedBy),
            },
            s.user.id,
            t,
          ),
        ];
        for (const p of payments)
          stmts.push(
            ...paymentStatements(
              ctx,
              {
                ticketId: ticket.id,
                kind: balance < 0 ? 'refund' : 'balance',
                method: p.method,
                amount: balance < 0 ? -p.amount : p.amount,
                reference: p.reference ?? null,
              },
              s.user.id,
              t,
            ),
          );
        // Khata balance goes on the customer's ledger (no repair-specific ledger type exists in 0004).
        if (khata > 0 && ticket.customerId !== null)
          stmts.push(
            ...ledgerStatement(ctx, {
              customerId: ticket.customerId,
              type: 'adjustment',
              amount: khata,
              note: `Repair ${ticket.ticketNo}`,
              userId: s.user.id,
              t,
            }),
          );
        await write(ctx, stmts);
        if (approvedBy !== null) consumeApproval(ctx, i.approvalToken);
        return ticketView(ctx, ticket.id);
      }),

    cancel: (i) =>
      ctx.lock(async () => {
        const s = requirePerm(ctx, 'sell');
        const ticket = await loadTicket(ctx, i.ticketId);
        if (CLOSED.includes(ticket.status))
          invalid('status', `A ${ticket.status} ticket cannot be cancelled`);
        const reason = text(i.reason, 'reason', 400);
        const refundMethod =
          i.refundMethod === undefined ? 'cash' : checkCashMethod(i.refundMethod, 'refundMethod');
        const paid = await paidSoFar(ctx, ticket.id);
        const approvedBy =
          paid > 0 && !hasPermission(s.user.role, 'return_void')
            ? approvalFor(ctx, i.approvalToken, 'void')
            : null;

        const t = ctx.now();
        const stmts: Statement[] = [
          ...ticketUpdate(ctx, ticket.id, { status: 'cancelled', closed_at: t }, t),
          ...historyStatements(
            ctx,
            {
              ticketId: ticket.id,
              from: ticket.status,
              to: 'cancelled',
              note: withApproval(reason, approvedBy),
            },
            s.user.id,
            t,
          ),
        ];
        // The advance goes back in full. Parts already fitted stay consumed (they were used).
        if (paid > 0)
          stmts.push(
            ...paymentStatements(
              ctx,
              {
                ticketId: ticket.id,
                kind: 'refund',
                method: refundMethod,
                amount: -paid,
                reference: null,
              },
              s.user.id,
              t,
            ),
          );
        await write(ctx, stmts);
        if (approvedBy !== null) consumeApproval(ctx, i.approvalToken);
        return ticketView(ctx, ticket.id);
      }),
  };
}
