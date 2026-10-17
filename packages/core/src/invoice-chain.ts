import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { ServiceError, type Invoice } from '@pos/shared';

export const GENESIS_HASH = '0'.repeat(64);
export const HASH_VERSION = 1;
const DOMAIN = 'pos.invoice.v1';

type Canonical = null | string | boolean | number | Canonical[] | { [k: string]: Canonical };

/** Deterministic JSON: keys sorted by UTF-16 code unit, no whitespace, integers only. */
export function canonicalize(value: Canonical): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new ServiceError('INTERNAL', `Canonical numbers must be integers: ${String(value)}`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k] ?? null)}`).join(',')}}`;
}

export type UnsealedInvoice = Omit<Invoice, 'prevHash' | 'hash'>;

/** The canonical JSON that gets hashed. Lines sorted by lineNo, payments by id. prevHash/hash are not part of it. */
export function invoiceHashPayload(inv: UnsealedInvoice): string {
  const lines = [...inv.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      productId: l.productId,
      phoneUnitId: l.phoneUnitId,
      variantId: l.variantId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      costPrice: l.costPrice,
      discountAmount: l.discountAmount,
      lineTotal: l.lineTotal,
      createdAt: l.createdAt,
    }));
  const payments = [...inv.payments]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({
      id: p.id,
      method: p.method,
      amount: p.amount,
      reference: p.reference,
      createdAt: p.createdAt,
    }));
  return canonicalize({
    v: inv.hashVersion,
    id: inv.id,
    deviceId: inv.deviceId,
    seq: inv.seq,
    invoiceNo: inv.invoiceNo,
    kind: inv.kind,
    originalSaleId: inv.originalSaleId,
    branchId: inv.branchId,
    customerId: inv.customerId,
    cashierId: inv.cashierId,
    subtotal: inv.subtotal,
    discountTotal: inv.discountTotal,
    total: inv.total,
    note: inv.note,
    createdAt: inv.createdAt,
    lines,
    payments,
  });
}

export function computeInvoiceHash(prevHash: string, inv: UnsealedInvoice): string {
  return bytesToHex(sha256(utf8ToBytes(`${DOMAIN}\n${prevHash}\n${invoiceHashPayload(inv)}`)));
}

export function sealInvoice(prevHash: string, unsealed: UnsealedInvoice): Invoice {
  return { ...unsealed, prevHash, hash: computeInvoiceHash(prevHash, unsealed) };
}

const PREFIX = /^[A-Z0-9]{1,4}$/;

/** "A" + 7 -> "A-000007". */
export function formatInvoiceNo(prefix: string, seq: number): string {
  if (!PREFIX.test(prefix) || !Number.isSafeInteger(seq) || seq < 1)
    throw new ServiceError('INTERNAL', 'Unexpected internal error');
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

export type ChainVerification =
  | { ok: true; count: number; headSeq: number; headHash: string }
  | { ok: false; reason: string; index: number };

/** Walks one device's invoices in seq order: seq must step by 1, prevHash must link, every hash must recompute. */
export function verifyChain(invoices: readonly Invoice[]): ChainVerification {
  const sorted = [...invoices].sort((a, b) => a.seq - b.seq);
  let prev = GENESIS_HASH;
  for (let i = 0; i < sorted.length; i++) {
    const inv = sorted[i] as Invoice;
    if (inv.seq !== i + 1)
      return { ok: false, reason: `missing invoice before seq ${String(inv.seq)}`, index: i };
    if (inv.prevHash !== prev)
      return { ok: false, reason: 'previous hash does not link', index: i };
    if (computeInvoiceHash(prev, inv) !== inv.hash)
      return { ok: false, reason: 'invoice content was changed', index: i };
    prev = inv.hash;
  }
  const head = sorted.at(-1);
  return {
    ok: true,
    count: sorted.length,
    headSeq: head?.seq ?? 0,
    headHash: head?.hash ?? GENESIS_HASH,
  };
}
