import type { Paisa, PaymentMethod } from '@pos/shared';
import { DomainError } from './errors';

/** half-up = ties away from zero (so -29992.5 -> -29993). half-even = banker's rounding. */
export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil';

export function paisa(n: number): Paisa {
  if (!Number.isSafeInteger(n))
    throw new DomainError('MONEY_INVALID', `Not a safe integer paisa amount: ${String(n)}`);
  return (n === 0 ? 0 : n) as Paisa; // normalises -0
}

export const ZERO: Paisa = paisa(0);
export const addPaisa = (a: Paisa, b: Paisa): Paisa => paisa(a + b);
export const subPaisa = (a: Paisa, b: Paisa): Paisa => paisa(a - b);
export const negPaisa = (a: Paisa): Paisa => paisa(0 - a);
export const sumPaisa = (values: readonly Paisa[]): Paisa => values.reduce<Paisa>(addPaisa, ZERO);
export function mulPaisa(a: Paisa, quantity: number): Paisa {
  if (!Number.isSafeInteger(quantity))
    throw new DomainError('MONEY_INVALID', `Quantity must be an integer: ${String(quantity)}`);
  return paisa(a * quantity);
}

function divRound(num: bigint, den: bigint, mode: RoundingMode): bigint {
  if (den === 0n) throw new DomainError('MONEY_INVALID', 'Division by zero');
  const n = den < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  let q = n / d; // truncates toward zero
  const r = n % d; // sign follows n
  if (r === 0n) return q;
  const negative = n < 0n;
  const twice = (r < 0n ? -r : r) * 2n;
  switch (mode) {
    case 'floor':
      return negative ? q - 1n : q;
    case 'ceil':
      return negative ? q : q + 1n;
    case 'half-up':
      if (twice >= d) q += negative ? -1n : 1n;
      return q;
    case 'half-even':
      if (twice > d || (twice === d && q % 2n !== 0n)) q += negative ? -1n : 1n;
      return q;
  }
}

function mulDivRound(a: number, b: number, c: number, mode: RoundingMode): Paisa {
  return paisa(Number(divRound(BigInt(a) * BigInt(b), BigInt(c), mode)));
}

function assertBps(bps: number, max: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > max)
    throw new DomainError(
      'DISCOUNT_INVALID',
      `Basis points must be an integer in 0..${max}, got ${String(bps)}`,
    );
}

/** amount * bps / 10_000, exact integer arithmetic (BigInt), rounded once. 1 bp = 0.01%. */
export function percentOf(amount: Paisa, bps: number, mode: RoundingMode = 'half-up'): Paisa {
  assertBps(bps, 1_000_000);
  return mulDivRound(amount, bps, 10_000, mode);
}

/** The discount is rounded; net = amount - discount, so discount + net always equals amount exactly. */
export function applyPercentDiscount(
  amount: Paisa,
  bps: number,
  mode: RoundingMode = 'half-up',
): { discount: Paisa; net: Paisa } {
  assertBps(bps, 10_000);
  const discount = percentOf(amount, bps, mode);
  return { discount, net: subPaisa(amount, discount) };
}

/** UI percent (max 2 decimals) -> basis points. 7.5 -> 750, 0.07 -> 7. */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent))
    throw new DomainError('DISCOUNT_INVALID', 'Percent must be finite');
  return Math.round(percent * 100);
}

/**
 * Largest-remainder allocation. Result sums EXACTLY to total; ties go to the lowest index.
 * Works for negative totals (allocated on the magnitude, then negated).
 */
export function allocate(total: Paisa, weights: readonly number[]): Paisa[] {
  if (weights.length === 0)
    throw new DomainError('MONEY_INVALID', 'allocate: weights must not be empty');
  let sumW = 0n;
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0)
      throw new DomainError('MONEY_INVALID', `allocate: invalid weight ${String(w)}`);
    sumW += BigInt(w);
  }
  if (sumW === 0n) throw new DomainError('MONEY_INVALID', 'allocate: weights sum to zero');
  const negative = total < 0;
  const absTotal = BigInt(Math.abs(total));
  const shares = weights.map((w) => (absTotal * BigInt(w)) / sumW);
  const order = weights
    .map((w, index) => ({ index, rem: (absTotal * BigInt(w)) % sumW }))
    .sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  let leftover = Number(absTotal - shares.reduce((acc, s) => acc + s, 0n));
  for (const { index } of order) {
    if (leftover === 0) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    leftover -= 1;
  }
  return shares.map((s) => paisa(negative ? -Number(s) : Number(s)));
}

export function splitEvenly(total: Paisa, parts: number): Paisa[] {
  if (!Number.isInteger(parts) || parts < 1)
    throw new DomainError('MONEY_INVALID', `parts must be an integer >= 1, got ${String(parts)}`);
  return allocate(total, new Array<number>(parts).fill(1));
}

export interface PaymentPart {
  method: PaymentMethod;
  amount: Paisa;
}

/** Payments (cash / khata / split) must sum EXACTLY to the invoice total, with consistent sign and no zero parts. */
export function assertPaymentsMatchTotal(total: Paisa, payments: readonly PaymentPart[]): void {
  if (total === 0 && payments.length > 0)
    throw new DomainError('PAYMENT_MISMATCH', 'A zero-total invoice must have no payments');
  let paid: Paisa = ZERO;
  for (const p of payments) {
    if (p.amount === 0) throw new DomainError('PAYMENT_MISMATCH', 'Payment amount cannot be zero');
    if (Math.sign(p.amount) !== Math.sign(total))
      throw new DomainError('PAYMENT_MISMATCH', 'Payment sign must match the invoice total');
    paid = addPaisa(paid, p.amount);
  }
  if (paid !== total)
    throw new DomainError(
      'PAYMENT_MISMATCH',
      `Payments sum to ${paid} paisa but total is ${total} paisa (difference ${total - paid})`,
    );
}

export interface PricedLine {
  quantity: number;
  unitPrice: Paisa;
  discountAmount: Paisa;
}
export interface SaleTotals {
  lineTotals: Paisa[];
  subtotal: Paisa;
  total: Paisa;
}

/** A discount may not exceed the gross it applies to, in the gross's direction (sales: 0..gross, returns: gross..0). */
function assertDiscountWithin(discount: Paisa, gross: Paisa, label: string): void {
  const ok = gross >= 0 ? discount >= 0 && discount <= gross : discount <= 0 && discount >= gross;
  if (!ok)
    throw new DomainError(
      'DISCOUNT_INVALID',
      `${label} discount ${discount} is outside 0..${gross}`,
    );
}

export function lineTotal(line: PricedLine): Paisa {
  if (!Number.isSafeInteger(line.quantity) || line.quantity === 0)
    throw new DomainError('MONEY_INVALID', `Invalid quantity ${String(line.quantity)}`);
  const gross = mulPaisa(line.unitPrice, line.quantity);
  assertDiscountWithin(line.discountAmount, gross, 'Line');
  return subPaisa(gross, line.discountAmount);
}

export function saleTotals(lines: readonly PricedLine[], invoiceDiscount: Paisa): SaleTotals {
  const first = lines[0];
  if (first === undefined)
    throw new DomainError('MONEY_INVALID', 'An invoice needs at least one line');
  if (lines.some((l) => Math.sign(l.quantity) !== Math.sign(first.quantity)))
    throw new DomainError('MONEY_INVALID', 'All lines of an invoice must have the same sign');
  const lineTotals = lines.map(lineTotal);
  const subtotal = sumPaisa(lineTotals);
  assertDiscountWithin(invoiceDiscount, subtotal, 'Invoice');
  return { lineTotals, subtotal, total: subPaisa(subtotal, invoiceDiscount) };
}

/** 199950 -> "1,999.50". Plain 3-digit grouping; locale/lakh formatting belongs to the UI layer. */
export function formatPaisa(p: Paisa): string {
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${p < 0 ? '-' : ''}${rupees}.${String(abs % 100).padStart(2, '0')}`;
}

/** "1,999.50" -> 199950. String parsing only; never multiplies a float by 100. */
export function rupeesToPaisa(input: string): Paisa {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim().replace(/,/g, ''));
  if (!m) throw new DomainError('MONEY_INVALID', `Cannot parse rupee amount: "${input}"`);
  const [, sign, whole = '0', frac = ''] = m;
  const value = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return paisa(sign === '-' ? -value : value);
}
