import { ServiceError, isServiceError } from '@pos/shared';

export const fail = (
  code: ServiceError['code'],
  message: string,
  details: Record<string, unknown> = {},
): never => {
  throw new ServiceError(code, message, details);
};

export const invalid = (field: string, message: string): never =>
  fail('VALIDATION', message, { field });

const UNIQUE = /UNIQUE constraint failed: ([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/;

/**
 * Turns a driver error into a ServiceError. Rules match on the SQLite message text (RAISE(ABORT, '...') and
 * constraint names), in the same order as ErrorMap.cs, so both sides report the same code.
 */
export function mapError(e: unknown): ServiceError {
  if (isServiceError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const has = (needle: string): boolean => msg.includes(needle);

  if (has('phone unit on-hand must stay within 0..1'))
    return new ServiceError('UNIT_NOT_IN_STOCK', 'This phone is not in stock');
  if (has('seq must be previous seq + 1') || has('prev_hash must equal'))
    return new ServiceError('CHAIN_CONFLICT', 'The invoice chain moved; please retry');
  if (has('khata requires a sale with a customer'))
    return new ServiceError('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
  if (has('original_sale_id must reference'))
    return new ServiceError('RETURN_NOT_ALLOWED', 'Only a sale invoice can be returned');
  if (has('is immutable') || has('is append-only') || has('only attempts, last_error'))
    return new ServiceError('IMMUTABLE_RECORD', 'This record cannot be changed');

  const unique = UNIQUE.exec(msg);
  if (unique)
    return new ServiceError('DUPLICATE', 'A record with the same value already exists', {
      table: unique[1],
      field: unique[2],
    });

  if (has('FOREIGN KEY constraint failed'))
    return new ServiceError('NOT_FOUND', 'A referenced record was not found');
  if (has('CHECK constraint failed') || has('NOT NULL constraint failed'))
    return new ServiceError('DB_CONSTRAINT', 'The data was rejected by a database rule');

  return new ServiceError('INTERNAL', 'Unexpected internal error');
}

// ---------------- input validation (twins of Validate.cs) ----------------

export function intIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    return invalid(field, `${field} must be an integer between ${String(min)} and ${String(max)}`);
  return v;
}

export const optIntIn = (v: unknown, field: string, min: number, max: number): number | null =>
  v === undefined || v === null ? null : intIn(v, field, min, max);

export function money(
  v: unknown,
  field: string,
  opts: { allowZero?: boolean; allowNegative?: boolean } = {},
): number {
  const { allowZero = true, allowNegative = false } = opts;
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    return fail('MONEY_INVALID', `${field} must be a whole number of paisa`, { field });
  if (v < 0 && !allowNegative) return invalid(field, `${field} must not be negative`);
  if (v === 0 && !allowZero) return invalid(field, `${field} must be greater than zero`);
  return v;
}

export const optMoney = (v: unknown, field: string): number | null =>
  v === undefined || v === null ? null : money(v, field);

export function discountMoney(v: unknown, field: string): number {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v < 0)
    return fail('DISCOUNT_INVALID', `${field} must not be negative`, { field });
  return money(v, field);
}

/** Trimmed text or null; longer than `max` is VALIDATION. */
export function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return invalid(field, `${field} must be text`);
  const s = v.trim();
  if (s.length > max) return invalid(field, `${field} must be at most ${String(max)} characters`);
  return s === '' ? null : s;
}

export function text(v: unknown, field: string, max: number): string {
  const s = optText(v, field, max);
  return s ?? invalid(field, `${field} is required`);
}

/** Luhn check for 15-digit IMEIs. */
export function isValidImei(s: string): boolean {
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
}
