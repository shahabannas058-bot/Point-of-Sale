import type { PaymentMethod } from './enums';
import type { Paisa } from './primitives';

// ---------- repair job tickets ----------
export const REPAIR_STATUSES = [
  'received',
  'diagnosing',
  'in_repair',
  'ready',
  'delivered',
  'cancelled',
] as const;
export type RepairStatus = (typeof REPAIR_STATUSES)[number];

/** Moves allowed through repairs.setStatus. Delivery (from 'ready') and cancellation have their own methods. */
export const REPAIR_TRANSITIONS: Readonly<Record<RepairStatus, readonly RepairStatus[]>> = {
  received: ['diagnosing', 'in_repair', 'ready'],
  diagnosing: ['in_repair', 'ready'],
  in_repair: ['diagnosing', 'ready'],
  ready: ['in_repair'],
  delivered: [],
  cancelled: [],
};

export const REPAIR_PAYMENT_KINDS = ['advance', 'balance', 'refund'] as const;
export type RepairPaymentKind = (typeof REPAIR_PAYMENT_KINDS)[number];

export interface RepairTicket {
  id: string;
  /** Per-shop sequence, e.g. "R-000001". */
  ticketNo: string;
  branchId: string;
  customerId: string | null;
  /** Snapshot at intake (registered customer or walk-in). */
  customerName: string;
  customerPhone: string | null;
  deviceBrand: string;
  deviceModel: string;
  imei: string | null;
  serial: string | null;
  problem: string;
  conditionNotes: string | null;
  accessories: string | null;
  estimatedCost: Paisa;
  finalCharge: Paisa | null;
  technicianId: string | null;
  promisedAt: number | null;
  status: RepairStatus;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Set when the ticket is delivered or cancelled. */
  closedAt: number | null;
}

/** One row of the append-only status history. */
export interface RepairStatusChange {
  id: string;
  ticketId: string;
  fromStatus: RepairStatus | null;
  toStatus: RepairStatus;
  note: string | null;
  changedBy: string;
  changedByName: string;
  changedAt: number;
}

export interface RepairPart {
  id: string;
  ticketId: string;
  variantId: string;
  label: string;
  quantity: number;
  unitCost: Paisa;
  unitPrice: Paisa;
  createdBy: string;
  createdAt: number;
}

export interface RepairPayment {
  id: string;
  ticketId: string;
  kind: RepairPaymentKind;
  method: PaymentMethod;
  /** Negative for refunds. */
  amount: Paisa;
  reference: string | null;
  createdBy: string;
  createdAt: number;
}

export interface RepairTicketView {
  ticket: RepairTicket;
  technicianName: string | null;
  /** Oldest first. */
  history: RepairStatusChange[];
  parts: RepairPart[];
  payments: RepairPayment[];
  /** Sum of all payments (advance + balance - refunds). */
  paidTotal: Paisa;
  /** (finalCharge ?? estimatedCost) - paidTotal; 0 once delivered or cancelled. */
  balanceDue: Paisa;
}

// ---------- warranty by IMEI ----------
export const WARRANTY_KINDS = ['shop', 'company'] as const;
export type WarrantyKind = (typeof WARRANTY_KINDS)[number];

export interface Warranty {
  id: string;
  phoneUnitId: string;
  saleId: string;
  kind: WarrantyKind;
  startsAt: number;
  endsAt: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

/** 'void' = the sale was returned / voided, so the warranty no longer applies. */
export type WarrantyState = 'active' | 'expired' | 'void';

export interface WarrantyStatus {
  warranty: Warranty;
  state: WarrantyState;
  /** Whole days left (ceil), 0 when expired or void. */
  daysLeft: number;
}

export interface WarrantySaleInfo {
  saleId: string;
  invoiceNo: string;
  soldAt: number;
  customerId: string | null;
  customerName: string | null;
  /** True when a return / void was made against this sale. */
  returned: boolean;
}
