/* In-memory twins of the repairs + warranty sections for the mock PosService (?mock=1).
   Same contract as packages/db/src/service/{repairs,warranty}.ts: errors, permissions, approvals and the
   append-only history, kept in plain arrays. */
import { assertPaymentsMatchTotal, paisa } from '@pos/core';
import {
  PAYMENT_METHODS,
  REPAIR_STATUSES,
  REPAIR_TRANSITIONS,
  ServiceError,
  WARRANTY_KINDS,
  type AccessoryVariant,
  type ApprovalReason,
  type Customer,
  type ExpiringWarranty,
  type Invoice,
  type LedgerEntryType,
  type PaymentMethod,
  type Permission,
  type PhoneUnit,
  type PhoneUnitView,
  type PosRepairsApi,
  type PosWarrantyApi,
  type RepairPart,
  type RepairPayment,
  type RepairPaymentKind,
  type RepairStatus,
  type RepairStatusChange,
  type RepairTicket,
  type RepairTicketView,
  type ServiceErrorCode,
  type Session,
  type Warranty,
  type WarrantyStatus,
} from '@pos/shared';

type CashMethod = Exclude<PaymentMethod, 'khata'>;

const DAY_MS = 86_400_000;

const CLOSED: readonly RepairStatus[] = ['delivered', 'cancelled'];

const fail = (
  code: ServiceErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): never => {
  throw new ServiceError(code, message, details);
};
const invalid = (field: string, message: string): never => fail('VALIDATION', message, { field });

/** Turns a synchronous body into a promise so thrown ServiceErrors become rejections. */
const run = <T>(fn: () => T): Promise<T> => {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
};

const luhn = (s: string): boolean => {
  if (!/^\d{15}$/.test(s)) return false;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
};

const wholePaisa = (v: unknown, field: string, allowZero = true): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    return fail('MONEY_INVALID', `${field} must be a whole number of paisa`, { field });
  if (v < 0 || (v === 0 && !allowZero)) return invalid(field, `${field} must be positive`);
  return v;
};

const required = (v: unknown, field: string): string => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? invalid(field, `${field} is required`) : s;
};
const optional = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

const cashMethod = (m: unknown, field: string): CashMethod => {
  if (typeof m !== 'string' || m === 'khata' || !(PAYMENT_METHODS as readonly string[]).includes(m))
    return invalid(field, 'Unknown payment method');
  return m as CashMethod;
};

/** What the repairs / warranty twins need from the main mock (its state and helpers). */
export interface MockDeps {
  now: () => number;
  newId: () => string;
  session: () => Session | null;
  require: (p: Permission) => void;
  can: (p: Permission) => boolean;
  /** Validates and spends a manager approval token. */
  takeApproval: (token: string | undefined, reason: ApprovalReason) => void;
  maxDiscountBps: () => number;
  allowNegativeStock: () => boolean;
  branchId: () => string;
  customers: readonly Customer[];
  users: readonly { id: string; displayName: string; isActive: boolean }[];
  variants: readonly AccessoryVariant[];
  variantQty: Map<string, number>;
  variantLabel: (v: AccessoryVariant) => string;
  units: readonly PhoneUnit[];
  unitView: (u: PhoneUnit) => PhoneUnitView;
  invoices: readonly Invoice[];
  addLedger: (e: {
    customerId: string;
    type: LedgerEntryType;
    amount: number;
    note?: string | null;
  }) => void;
}

export function createMockRepairs(d: MockDeps): PosRepairsApi {
  const tickets: RepairTicket[] = [];
  const history: RepairStatusChange[] = [];
  const parts: RepairPart[] = [];
  const payments: RepairPayment[] = [];

  const me = (): Session => d.session() ?? fail('NOT_AUTHENTICATED', 'Sign in first');
  const nameOf = (id: string): string => d.users.find((u) => u.id === id)?.displayName ?? '—';
  const find = (idOrNo: string): RepairTicket =>
    tickets.find((t) => t.id === idOrNo || t.ticketNo === idOrNo) ??
    fail('NOT_FOUND', 'Repair ticket not found', { id: idOrNo });
  const paid = (id: string): number =>
    payments.filter((p) => p.ticketId === id).reduce((a, p) => a + p.amount, 0);
  const replace = (next: RepairTicket): void => {
    const i = tickets.findIndex((t) => t.id === next.id);
    tickets.splice(i, 1, next);
  };
  const log = (
    ticketId: string,
    from: RepairStatus | null,
    to: RepairStatus,
    note: string | null,
  ): void => {
    const s = me();
    history.push({
      id: d.newId(),
      ticketId,
      fromStatus: from,
      toStatus: to,
      note,
      changedBy: s.user.id,
      changedByName: s.user.displayName,
      changedAt: d.now(),
    });
  };
  const pay = (
    ticketId: string,
    kind: RepairPaymentKind,
    method: PaymentMethod,
    amount: number,
  ): void => {
    payments.push({
      id: d.newId(),
      ticketId,
      kind,
      method,
      amount: paisa(amount),
      reference: null,
      createdBy: me().user.id,
      createdAt: d.now(),
    });
  };
  const technician = (id: unknown): string | null => {
    if (id === undefined || id === null) return null;
    return (
      d.users.find((u) => u.id === id && u.isActive)?.id ??
      fail('NOT_FOUND', 'Technician not found', { field: 'technicianId' })
    );
  };
  const view = (idOrNo: string): RepairTicketView => {
    const ticket = find(idOrNo);
    const paidTotal = paid(ticket.id);
    return {
      ticket,
      technicianName: ticket.technicianId === null ? null : nameOf(ticket.technicianId),
      history: history.filter((h) => h.ticketId === ticket.id),
      parts: parts.filter((p) => p.ticketId === ticket.id),
      payments: payments.filter((p) => p.ticketId === ticket.id),
      paidTotal: paisa(paidTotal),
      balanceDue: paisa(
        CLOSED.includes(ticket.status)
          ? 0
          : (ticket.finalCharge ?? ticket.estimatedCost) - paidTotal,
      ),
    };
  };
  const open = (id: string): RepairTicket => {
    const t = find(id);
    if (CLOSED.includes(t.status)) fail('IMMUTABLE_RECORD', 'This ticket is closed');
    return t;
  };

  return {
    create: (i) =>
      run(() => {
        d.require('sell');
        const s = me();
        let customerId: string | null = null;
        let customerName: string;
        let customerPhone: string | null;
        if (i.customerId) {
          const c =
            d.customers.find((x) => x.id === i.customerId && x.isActive) ??
            fail('NOT_FOUND', 'Customer not found');
          customerId = c.id;
          customerName = c.name;
          customerPhone = c.phone;
        } else {
          if (!i.walkIn) return invalid('customer', 'Pick a customer or enter a walk-in name');
          customerName = required(i.walkIn.name, 'walkIn.name');
          customerPhone = optional(i.walkIn.phone);
        }
        const imei = optional(i.imei);
        if (imei !== null && !luhn(imei)) invalid('imei', 'imei is not a valid IMEI');
        const advance = i.advance ?? null;
        const advanceAmount =
          advance === null ? 0 : wholePaisa(advance.amount, 'advance.amount', false);
        const advanceMethod =
          advance === null ? null : cashMethod(advance.method, 'advance.method');
        const t = d.now();
        const seq = tickets.length + 1;
        const ticket: RepairTicket = {
          id: d.newId(),
          ticketNo: `R-${String(seq).padStart(6, '0')}`,
          branchId: d.branchId(),
          customerId,
          customerName,
          customerPhone,
          deviceBrand: optional(i.deviceBrand) ?? '',
          deviceModel: required(i.deviceModel, 'deviceModel'),
          imei,
          serial: optional(i.serial),
          problem: required(i.problem, 'problem'),
          conditionNotes: optional(i.conditionNotes),
          accessories: optional(i.accessories),
          estimatedCost: paisa(wholePaisa(i.estimatedCost, 'estimatedCost')),
          finalCharge: null,
          technicianId: technician(i.technicianId),
          promisedAt: i.promisedAt ?? null,
          status: 'received',
          createdBy: s.user.id,
          createdAt: t,
          updatedAt: t,
          closedAt: null,
        };
        tickets.push(ticket);
        log(ticket.id, null, 'received', null);
        if (advanceMethod !== null) pay(ticket.id, 'advance', advanceMethod, advanceAmount);
        return view(ticket.id);
      }),

    get: (idOrNo) =>
      run(() => {
        d.require('sell');
        return view(idOrNo);
      }),

    list: (f = {}) =>
      run(() => {
        d.require('sell');
        if (f.status !== undefined && !(REPAIR_STATUSES as readonly string[]).includes(f.status))
          invalid('status', 'Unknown repair status');
        const qy = f.q?.trim().toLowerCase() ?? '';
        return tickets
          .filter((t) => f.status === undefined || t.status === f.status)
          .filter((t) => !f.openOnly || !CLOSED.includes(t.status))
          .filter((t) => !f.customerId || t.customerId === f.customerId)
          .filter(
            (t) =>
              qy === '' ||
              [
                t.ticketNo,
                t.customerName,
                t.customerPhone,
                t.deviceBrand,
                t.deviceModel,
                t.imei,
                t.serial,
              ]
                .join(' ')
                .toLowerCase()
                .includes(qy),
          )
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, f.limit ?? 200);
      }),

    update: (id, patch) =>
      run(() => {
        d.require('sell');
        const t = open(id);
        const has = (k: keyof typeof patch): boolean =>
          Object.prototype.hasOwnProperty.call(patch, k);
        replace({
          ...t,
          problem: patch.problem === undefined ? t.problem : required(patch.problem, 'problem'),
          conditionNotes: has('conditionNotes') ? optional(patch.conditionNotes) : t.conditionNotes,
          accessories: has('accessories') ? optional(patch.accessories) : t.accessories,
          estimatedCost:
            patch.estimatedCost === undefined
              ? t.estimatedCost
              : paisa(wholePaisa(patch.estimatedCost, 'estimatedCost')),
          finalCharge: has('finalCharge')
            ? patch.finalCharge === null || patch.finalCharge === undefined
              ? null
              : paisa(wholePaisa(patch.finalCharge, 'finalCharge'))
            : t.finalCharge,
          technicianId: has('technicianId') ? technician(patch.technicianId) : t.technicianId,
          promisedAt: has('promisedAt') ? (patch.promisedAt ?? null) : t.promisedAt,
          updatedAt: d.now(),
        });
        return view(t.id);
      }),

    setStatus: (i) =>
      run(() => {
        d.require('sell');
        const t = find(i.ticketId);
        if (!REPAIR_TRANSITIONS[t.status].includes(i.status))
          invalid('status', `Cannot move a ticket from ${t.status} to ${String(i.status)}`);
        replace({ ...t, status: i.status, updatedAt: d.now() });
        log(t.id, t.status, i.status, optional(i.note));
        return view(t.id);
      }),

    addPart: (i) =>
      run(() => {
        d.require('sell');
        const s = me();
        const t = open(i.ticketId);
        if (!Number.isSafeInteger(i.quantity) || i.quantity < 1 || i.quantity > 1_000)
          invalid('quantity', 'quantity must be an integer between 1 and 1000');
        const v =
          d.variants.find((x) => x.id === i.variantId && x.isActive) ??
          fail('NOT_FOUND', 'Accessory not found', { id: i.variantId });
        const onHand = d.variantQty.get(v.id) ?? 0;
        if (!d.allowNegativeStock() && onHand < i.quantity)
          fail('STOCK_INSUFFICIENT', 'Not enough stock', { onHand, requested: i.quantity });
        d.variantQty.set(v.id, onHand - i.quantity);
        parts.push({
          id: d.newId(),
          ticketId: t.id,
          variantId: v.id,
          label: d.variantLabel(v),
          quantity: i.quantity,
          unitCost: v.costPrice,
          unitPrice: v.salePrice,
          createdBy: s.user.id,
          createdAt: d.now(),
        });
        return view(t.id);
      }),

    deliver: (i) =>
      run(() => {
        d.require('sell');
        const t = find(i.ticketId);
        if (t.status !== 'ready') invalid('status', 'Only a ready ticket can be delivered');
        const finalCharge =
          i.finalCharge === undefined
            ? (t.finalCharge ?? t.estimatedCost)
            : wholePaisa(i.finalCharge, 'finalCharge');
        const pays = i.payments.map((p, idx) => {
          if (!(PAYMENT_METHODS as readonly string[]).includes(p.method))
            invalid(`payments.${String(idx)}.method`, 'Unknown payment method');
          return {
            method: p.method,
            amount: wholePaisa(p.amount, `payments.${String(idx)}.amount`, false),
          };
        });
        const balance = finalCharge - paid(t.id);
        const khata = pays.filter((p) => p.method === 'khata').reduce((a, p) => a + p.amount, 0);
        if (khata > 0 && balance < 0) invalid('payments', 'A refund cannot go to khata');
        if (khata > 0 && t.customerId === null)
          fail('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
        assertPaymentsMatchTotal(
          paisa(Math.abs(balance)),
          pays.map((p) => ({ method: p.method, amount: paisa(p.amount) })),
        );
        const discount = t.estimatedCost - finalCharge;
        if (
          discount > 0 &&
          !d.can('discount_unlimited') &&
          discount * 10_000 > d.maxDiscountBps() * t.estimatedCost
        )
          d.takeApproval(i.approvalToken, 'discount');
        const now = d.now();
        replace({
          ...t,
          status: 'delivered',
          finalCharge: paisa(finalCharge),
          closedAt: now,
          updatedAt: now,
        });
        log(t.id, t.status, 'delivered', optional(i.note));
        for (const p of pays)
          pay(
            t.id,
            balance < 0 ? 'refund' : 'balance',
            p.method,
            balance < 0 ? -p.amount : p.amount,
          );
        if (khata > 0 && t.customerId !== null)
          d.addLedger({
            customerId: t.customerId,
            type: 'adjustment',
            amount: khata,
            note: `Repair ${t.ticketNo}`,
          });
        return view(t.id);
      }),

    cancel: (i) =>
      run(() => {
        d.require('sell');
        const t = find(i.ticketId);
        if (CLOSED.includes(t.status))
          invalid('status', `A ${t.status} ticket cannot be cancelled`);
        const reason = required(i.reason, 'reason');
        const method =
          i.refundMethod === undefined ? 'cash' : cashMethod(i.refundMethod, 'refundMethod');
        const money = paid(t.id);
        if (money > 0 && !d.can('return_void')) d.takeApproval(i.approvalToken, 'void');
        const now = d.now();
        replace({ ...t, status: 'cancelled', closedAt: now, updatedAt: now });
        log(t.id, t.status, 'cancelled', reason);
        if (money > 0) pay(t.id, 'refund', method, -money);
        return view(t.id);
      }),
  };
}

export function createMockWarranty(d: MockDeps): PosWarrantyApi {
  const warranties: Warranty[] = [];

  const returned = (saleId: string, unitId: string): boolean =>
    d.invoices.some(
      (inv) => inv.originalSaleId === saleId && inv.lines.some((l) => l.phoneUnitId === unitId),
    );
  const statusOf = (w: Warranty, isReturned: boolean): WarrantyStatus => {
    const now = d.now();
    if (isReturned) return { warranty: w, state: 'void', daysLeft: 0 };
    if (now >= w.endsAt) return { warranty: w, state: 'expired', daysLeft: 0 };
    return { warranty: w, state: 'active', daysLeft: Math.ceil((w.endsAt - now) / DAY_MS) };
  };
  const customerOf = (id: string | null): Customer | undefined =>
    id === null ? undefined : d.customers.find((c) => c.id === id);

  return {
    register: (i) =>
      run(() => {
        d.require('sell');
        const s = d.session() ?? fail('NOT_AUTHENTICATED', 'Sign in first');
        if (!(WARRANTY_KINDS as readonly string[]).includes(i.kind))
          invalid('kind', 'Unknown warranty kind');
        const sale =
          d.invoices.find((x) => x.id === i.saleId) ?? fail('NOT_FOUND', 'Sale not found');
        if (sale.kind !== 'sale') invalid('saleId', 'Warranty can only be added to a sale invoice');
        if (!sale.lines.some((l) => l.phoneUnitId === i.phoneUnitId))
          invalid('phoneUnitId', 'This phone is not on that sale');
        if (returned(sale.id, i.phoneUnitId)) invalid('phoneUnitId', 'This phone was returned');
        const hasDays = i.days !== undefined && i.days !== null;
        const hasEnd = i.endsAt !== undefined && i.endsAt !== null;
        if (hasDays === hasEnd) invalid('days', 'Give either days or an end date');
        const days = i.days ?? 0;
        if (hasDays && (!Number.isSafeInteger(days) || days < 1 || days > 3_650))
          invalid('days', 'days must be an integer between 1 and 3650');
        const endsAt = hasDays ? sale.createdAt + days * DAY_MS : (i.endsAt ?? 0);
        if (!Number.isSafeInteger(endsAt) || endsAt <= sale.createdAt)
          invalid('endsAt', 'endsAt must be after the sale date');
        if (
          warranties.some(
            (w) => w.saleId === sale.id && w.phoneUnitId === i.phoneUnitId && w.kind === i.kind,
          )
        )
          fail('DUPLICATE', `A ${i.kind} warranty already exists`, { field: 'kind' });
        const w: Warranty = {
          id: d.newId(),
          phoneUnitId: i.phoneUnitId,
          saleId: sale.id,
          kind: i.kind,
          startsAt: sale.createdAt,
          endsAt,
          note: optional(i.note),
          createdBy: s.user.id,
          createdAt: d.now(),
        };
        warranties.push(w);
        return w;
      }),

    lookup: (imeiOrSerial) =>
      run(() => {
        d.require('sell');
        const key = imeiOrSerial.trim();
        if (!key) return invalid('imeiOrSerial', 'Enter an IMEI or serial');
        const unit =
          d.units.find(
            (u) =>
              u.imei1 === key || u.imei2 === key || u.serial?.toLowerCase() === key.toLowerCase(),
          ) ?? fail('NOT_FOUND', 'No phone with this IMEI / serial', { q: key });
        const sale = d.invoices
          .filter((inv) => inv.kind === 'sale' && inv.lines.some((l) => l.phoneUnitId === unit.id))
          .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)[0];
        if (!sale) return { unit: d.unitView(unit), sale: null, warranties: [] };
        const isReturned = returned(sale.id, unit.id);
        return {
          unit: d.unitView(unit),
          sale: {
            saleId: sale.id,
            invoiceNo: sale.invoiceNo,
            soldAt: sale.createdAt,
            customerId: sale.customerId,
            customerName: customerOf(sale.customerId)?.name ?? null,
            returned: isReturned,
          },
          warranties: warranties
            .filter((w) => w.saleId === sale.id && w.phoneUnitId === unit.id)
            .map((w) => statusOf(w, isReturned)),
        };
      }),

    listExpiring: (days) =>
      run(() => {
        d.require('sell');
        if (!Number.isSafeInteger(days) || days < 0 || days > 3_650)
          invalid('days', 'days must be an integer between 0 and 3650');
        const now = d.now();
        return warranties
          .filter(
            (w) =>
              w.endsAt > now &&
              w.endsAt <= now + days * DAY_MS &&
              !returned(w.saleId, w.phoneUnitId),
          )
          .sort((a, b) => a.endsAt - b.endsAt)
          .map((w): ExpiringWarranty => {
            const unit = d.units.find((u) => u.id === w.phoneUnitId);
            const sale = d.invoices.find((inv) => inv.id === w.saleId);
            const customer = customerOf(sale?.customerId ?? null);
            return {
              status: statusOf(w, false),
              unitLabel: unit ? d.unitView(unit).label : '—',
              imei: unit?.imei1 ?? null,
              serial: unit?.serial ?? null,
              invoiceNo: sale?.invoiceNo ?? '—',
              customerName: customer?.name ?? null,
              customerPhone: customer?.phone ?? null,
            };
          });
      }),
  };
}
