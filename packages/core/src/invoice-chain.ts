import { GENESIS_HASH, type Invoice, type UnsealedInvoice } from '@pos/shared';
import { DomainError } from './errors';
import { sha256Hex } from './hash';

export { GENESIS_HASH };
/** Version stamped on NEW invoices. v1 (no unitScale in the hash) stays verifiable forever. */
export const HASH_VERSION = 2;
export const SUPPORTED_HASH_VERSIONS: readonly number[] = [1, 2];
const DOMAIN = 'pos.invoice.v1';

export type CanonicalValue =
  string | number | boolean | null | CanonicalValue[] | { [key: string]: CanonicalValue };

/** Deterministic JSON: keys sorted (UTF-16 order), no whitespace, safe integers only (no floats/NaN/undefined). */
export function canonicalize(value: CanonicalValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value))
        throw new DomainError('CANONICAL_INVALID', `Non-integer number: ${String(value)}`);
      return String(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
      const obj = value;
      const parts = Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k] as CanonicalValue)}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new DomainError('CANONICAL_INVALID', `Unsupported value type: ${typeof value}`);
  }
}

/** Everything immutable about an invoice. Lines sorted by lineNo, payments by id, so array order never matters. */
export function invoiceHashPayload(inv: UnsealedInvoice): CanonicalValue {
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
      // v1 invoices were hashed without it; adding it for v1 would break every stored hash
      ...(inv.hashVersion >= 2 ? { unitScale: l.unitScale } : {}),
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
  return {
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
  };
}

export function computeInvoiceHash(prevHash: string, inv: UnsealedInvoice): string {
  return sha256Hex(`${DOMAIN}\n${prevHash}\n${canonicalize(invoiceHashPayload(inv))}`);
}

export function sealInvoice(prevHash: string, inv: UnsealedInvoice): Invoice {
  return { ...inv, prevHash, hash: computeInvoiceHash(prevHash, inv) };
}

/** 'A', 12 -> 'A-000012'. Prefix is per device (app_meta.invoice_prefix) so two tills never print the same number. */
export function formatInvoiceNo(prefix: string, seq: number): string {
  if (!/^[A-Z0-9]{1,4}$/.test(prefix))
    throw new DomainError('INVOICE_NO_INVALID', `Bad invoice prefix: ${prefix}`);
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new DomainError('INVOICE_NO_INVALID', `Bad seq: ${String(seq)}`);
  return `${prefix}-${String(seq).padStart(6, '0')}`;
}

export type ChainFailureReason =
  | 'mixed_devices'
  | 'unsupported_hash_version'
  | 'seq_gap'
  | 'prev_hash_mismatch'
  | 'hash_mismatch'
  | 'head_mismatch';

export type ChainVerification =
  | { ok: true; count: number; headHash: string; headSeq: number }
  | {
      ok: false;
      reason: ChainFailureReason;
      index: number;
      invoiceId: string | null;
      expected: string;
      actual: string;
    };

export interface VerifyChainOptions {
  /** Verify a slice: first invoice's expected seq (default 1) and prev hash (default GENESIS_HASH). */
  startSeq?: number;
  startPrevHash?: string;
  /** Head hash known from elsewhere (e.g. the server). Detects tail truncation and full re-hashing. */
  expectedHeadHash?: string;
}

/**
 * Verifies ONE device's invoices, passed in claimed order (seq ascending).
 * Detects: edited content, deleted (head, middle), reordered or duplicated invoices.
 * Tail deletion / full re-hash are only detectable via expectedHeadHash.
 */
export function verifyChain(
  invoices: readonly Invoice[],
  opts: VerifyChainOptions = {},
): ChainVerification {
  let prev = opts.startPrevHash ?? GENESIS_HASH;
  let expectedSeq = opts.startSeq ?? 1;
  const deviceId = invoices[0]?.deviceId;
  for (const [index, inv] of invoices.entries()) {
    const fail = (
      reason: ChainFailureReason,
      expected: string,
      actual: string,
    ): ChainVerification => ({
      ok: false,
      reason,
      index,
      invoiceId: inv.id,
      expected,
      actual,
    });
    if (inv.deviceId !== deviceId) return fail('mixed_devices', String(deviceId), inv.deviceId);
    if (!SUPPORTED_HASH_VERSIONS.includes(inv.hashVersion))
      return fail('unsupported_hash_version', String(HASH_VERSION), String(inv.hashVersion));
    if (inv.seq !== expectedSeq) return fail('seq_gap', String(expectedSeq), String(inv.seq));
    if (inv.prevHash !== prev) return fail('prev_hash_mismatch', prev, inv.prevHash);
    const recomputed = computeInvoiceHash(inv.prevHash, inv);
    if (recomputed !== inv.hash) return fail('hash_mismatch', recomputed, inv.hash);
    prev = inv.hash;
    expectedSeq += 1;
  }
  if (opts.expectedHeadHash !== undefined && prev !== opts.expectedHeadHash)
    return {
      ok: false,
      reason: 'head_mismatch',
      index: invoices.length - 1,
      invoiceId: invoices.at(-1)?.id ?? null,
      expected: opts.expectedHeadHash,
      actual: prev,
    };
  return { ok: true, count: invoices.length, headHash: prev, headSeq: expectedSeq - 1 };
}
