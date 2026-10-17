import { ServiceError, type Paisa, type PaymentMethod } from '@pos/shared';

const moneyInvalid = (message: string, details: Record<string, unknown> = {}): ServiceError =>
  new ServiceError('MONEY_INVALID', message, details);

/** Brands a safe integer as paisa. Anything else (float, NaN, > 2^53) is MONEY_INVALID. */
export function paisa(n: number): Paisa {
  if (!Number.isSafeInteger(n)) throw moneyInvalid(`Not a safe integer paisa amount: ${String(n)}`);
  return n as Paisa;
}

export const ZERO = 0 as Paisa;

export const addPaisa = (a: number, b: number): Paisa => paisa(a + b);
export const subPaisa = (a: number, b: number): Paisa => paisa(a - b);

export function mulPaisa(a: number, quantity: number): Paisa {
  if (!Number.isSafeInteger(quantity))
    throw moneyInvalid(`Quantity must be an integer: ${String(quantity)}`);
  return paisa(a * quantity);
}

export const sumPaisa = (values: readonly number[]): Paisa =>
  values.reduce<Paisa>((acc, v) => addPaisa(acc, v), ZERO);

/** A discount may not exceed the gross it applies to, in the gross's direction (sales 0..gross, returns gross..0). */
function assertDiscountWithin(discount: number, gross: number, label: string): void {
  const ok = gross >= 0 ? discount >= 0 && discount <= gross : discount <= 0 && discount >= gross;
  if (!ok)
    throw new ServiceError(
      'DISCOUNT_INVALID',
      `${label} discount ${String(discount)} is outside 0..${String(gross)}`,
    );
}

export interface PricedLine {
  quantity: number;
  unitPrice: Paisa;
  discountAmount: Paisa;
}

export function lineTotal(line: PricedLine): Paisa {
  if (line.quantity === 0 || !Number.isSafeInteger(line.quantity))
    throw moneyInvalid(`Invalid quantity ${String(line.quantity)}`);
  const gross = mulPaisa(line.unitPrice, line.quantity);
  assertDiscountWithin(line.discountAmount, gross, 'Line');
  return subPaisa(gross, line.discountAmount);
}

export interface SaleTotals {
  lineTotals: Paisa[];
  subtotal: Paisa;
  total: Paisa;
}

export function saleTotals(lines: readonly PricedLine[], invoiceDiscount: Paisa): SaleTotals {
  const first = lines[0];
  if (!first) throw moneyInvalid('An invoice needs at least one line');
  const sign = Math.sign(first.quantity);
  if (lines.some((l) => Math.sign(l.quantity) !== sign))
    throw moneyInvalid('All lines of an invoice must have the same sign');
  const lineTotals = lines.map(lineTotal);
  const subtotal = sumPaisa(lineTotals);
  assertDiscountWithin(invoiceDiscount, subtotal, 'Invoice');
  return { lineTotals, subtotal, total: subPaisa(subtotal, invoiceDiscount) };
}

/** Payments (cash / khata / split) must sum EXACTLY to the invoice total, same sign, no zero parts. */
export function assertPaymentsMatchTotal(
  total: Paisa,
  payments: readonly { method: PaymentMethod; amount: Paisa }[],
): void {
  const mismatch = (m: string): ServiceError => new ServiceError('PAYMENT_MISMATCH', m);
  if (total === 0 && payments.length > 0)
    throw mismatch('A zero-total invoice must have no payments');
  let paid = 0;
  for (const p of payments) {
    if (p.amount === 0) throw mismatch('Payment amount cannot be zero');
    if (Math.sign(p.amount) !== Math.sign(total))
      throw mismatch('Payment sign must match the invoice total');
    paid = addPaisa(paid, p.amount);
  }
  if (paid !== total)
    throw mismatch(
      `Payments sum to ${String(paid)} paisa but total is ${String(total)} paisa (difference ${String(total - paid)})`,
    );
}

/** Exact comparison discount/gross > maxBps/10000 (1 paisa over the limit counts). */
export const exceedsDiscountLimit = (discount: number, gross: number, maxBps: number): boolean =>
  BigInt(discount) * 10_000n > BigInt(maxBps) * BigInt(gross);

/** Effective discount in basis points, floored. 0 when gross is 0. */
export const discountBps = (discount: number, gross: number): number =>
  gross > 0 ? Number((BigInt(discount) * 10_000n) / BigInt(gross)) : 0;

/**
 * Splits `total` across parts proportionally to |weights| (largest remainder), so the parts always add up
 * exactly to `total` and carry its sign. Used to suggest refunds in the same mix as the original payments.
 */
export function allocate(total: Paisa, weights: readonly number[]): Paisa[] {
  if (weights.length === 0) return [];
  const abs = weights.map((w) => BigInt(Math.abs(w)));
  const sumW = abs.reduce((a, b) => a + b, 0n);
  const sign = total < 0 ? -1n : 1n;
  const target = BigInt(Math.abs(total));
  if (sumW === 0n) return weights.map((_, i) => paisa(i === 0 ? total : 0));
  const base = abs.map((w) => (target * w) / sumW);
  let rest = target - base.reduce((a, b) => a + b, 0n);
  const order = abs
    .map((w, i) => ({ i, rem: (target * w) % sumW }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const { i } of order) {
    if (rest === 0n) break;
    base[i] = (base[i] ?? 0n) + 1n;
    rest -= 1n;
  }
  return base.map((b) => paisa(Number(b * sign)));
}

/** "12.5" (%) -> 1250 bps. Rounded to a whole basis point. */
export function percentToBps(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100)
    throw new ServiceError('DISCOUNT_INVALID', `Percent must be 0..100: ${String(percent)}`);
  return Math.round(percent * 100);
}

/** Percent discount of a gross amount, rounded half-up to the paisa. */
export function applyPercentDiscount(gross: Paisa, bps: number): { discount: Paisa; net: Paisa } {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000)
    throw new ServiceError('DISCOUNT_INVALID', `Basis points must be 0..10000: ${String(bps)}`);
  const g = BigInt(gross);
  const sign = g < 0n ? -1n : 1n;
  const discount = paisa(Number(((g * sign * BigInt(bps) + 5_000n) / 10_000n) * sign));
  return { discount, net: subPaisa(gross, discount) };
}

const RUPEES = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

/** "1500.5" / "1500" / 1500.5 -> paisa, using string maths only (no float rounding). */
export function rupeesToPaisa(input: string | number): Paisa {
  const s = typeof input === 'number' ? String(input) : input.trim();
  const m = RUPEES.exec(s);
  if (!m) throw moneyInvalid(`Not a rupee amount: ${s}`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  return paisa(whole * 100 + frac);
}
