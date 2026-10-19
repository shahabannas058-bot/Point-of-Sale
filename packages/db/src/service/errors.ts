import { DomainError, paisa } from '@pos/core';
import {
  CnicSchema,
  PhoneNumberSchema,
  ServiceError,
  describeError,
  log,
  type Paisa,
  type ServiceErrorCode,
} from '@pos/shared';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Codes whose user-facing text hides what really happened; the original error goes to the log instead. */
const LOGGED_CODES: ReadonlySet<ServiceErrorCode> = new Set(['INTERNAL', 'DB_CONSTRAINT']);

/** Records the thrown value (message, stack, cause chain; details redacted) behind an opaque mapping. */
function logMapped(code: ServiceErrorCode, mapped: ServiceError, e: unknown): ServiceError {
  if (LOGGED_CODES.has(code))
    log.error('service.mapError', { code, message: mapped.message, error: describeError(e) });
  return mapped;
}

interface ZodIssueLike {
  path: readonly PropertyKey[]; // Zod 4 widened path to PropertyKey[]
  message: string;
}
const pathText = (path: readonly PropertyKey[]): string => path.map((p) => String(p)).join('.');

/** Duck-typed so this package needs no direct zod dependency and works with Zod 3 and 4. */
function isZodError(e: unknown): e is Error & { issues: ZodIssueLike[] } {
  return (
    e instanceof Error && e.name === 'ZodError' && Array.isArray((e as { issues?: unknown }).issues)
  );
}

/**
 * Translates anything thrown below the service (core DomainError, Zod, SQLite trigger/constraint text)
 * into the contract's ServiceError. Order of the rules matters: see blueprint section 3.
 * Trigger messages are matched by text because both better-sqlite3 and sql.js surface RAISE(ABORT) verbatim.
 */
export function mapError(e: unknown): ServiceError {
  if (e instanceof ServiceError) return e;

  if (e instanceof DomainError) {
    switch (e.code) {
      case 'MONEY_INVALID':
      case 'DISCOUNT_INVALID':
      case 'PAYMENT_MISMATCH':
      case 'STOCK_INSUFFICIENT':
      case 'LEDGER_CORRUPT':
        return new ServiceError(e.code, e.message);
      case 'STOCK_INVALID':
        return new ServiceError('VALIDATION', e.message);
      case 'CANONICAL_INVALID':
      case 'INVOICE_NO_INVALID':
        return logMapped('INTERNAL', new ServiceError('INTERNAL', 'Unexpected internal error'), e);
    }
  }

  if (isZodError(e)) {
    const first = e.issues[0];
    return new ServiceError('VALIDATION', first?.message ?? 'Validation failed', {
      field: first === undefined ? '' : pathText(first.path),
      issues: e.issues.map((i) => ({ path: pathText(i.path), message: i.message })),
    });
  }

  // Everything below comes from the database driver. The raw text is kept ONLY in a non-enumerable
  // `cause` and, for the opaque codes, in the log; callers get a generic message and minimal details.
  const msg = errorMessage(e);
  const make = (
    c: ServiceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ): ServiceError => {
    const err = new ServiceError(c, message, details);
    Object.defineProperty(err, 'cause', { value: e, enumerable: false, configurable: true });
    return logMapped(c, err, e);
  };

  if (msg.includes('phone unit on-hand must stay within 0..1'))
    return make('UNIT_NOT_IN_STOCK', 'This phone is not in stock');
  if (msg.includes('seq must be previous seq + 1') || msg.includes('prev_hash must equal'))
    return make('CHAIN_CONFLICT', 'The invoice chain moved; please retry');
  if (
    msg.includes('khata requires a sale with a customer') ||
    msg.includes('khata requires a ticket with a customer')
  )
    return make('KHATA_NEEDS_CUSTOMER', 'Khata needs a customer');
  if (msg.includes('original_sale_id must reference'))
    return make('RETURN_NOT_ALLOWED', 'Only a sale invoice can be returned');
  if (
    msg.includes('is immutable') ||
    msg.includes('is append-only') ||
    msg.includes('only attempts, last_error')
  )
    return make('IMMUTABLE_RECORD', 'This record cannot be changed');
  const unique = /UNIQUE constraint failed: (\w+)\.(\w+)/.exec(msg);
  if (unique)
    return make('DUPLICATE', 'A record with the same value already exists', {
      table: unique[1] ?? '',
      field: unique[2] ?? '',
    });
  if (msg.includes('FOREIGN KEY constraint failed'))
    return make('NOT_FOUND', 'A referenced record was not found');
  if (msg.includes('unit_scale must match') || msg.includes('unit cannot change once stock exists'))
    return make('DB_CONSTRAINT', 'The unit of this item cannot be used or changed this way');
  if (msg.includes('CHECK constraint failed') || msg.includes('NOT NULL constraint failed'))
    return make('DB_CONSTRAINT', 'The data was rejected by a database rule');
  return make('INTERNAL', 'Unexpected internal error');
}

/** Wraps one async operation so only ServiceError ever escapes. */
export async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw mapError(e);
  }
}

/** Wraps every function property of an API object (sync or async) with mapError. */
export function guardApi<T extends object>(api: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api) as [string, unknown][]) {
    if (typeof value !== 'function') {
      out[key] = value;
      continue;
    }
    const fn = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]): unknown => {
      try {
        const result = fn(...args);
        return result instanceof Promise
          ? result.catch((e: unknown) => {
              throw mapError(e);
            })
          : result;
      } catch (e) {
        throw mapError(e);
      }
    };
  }
  return out as T;
}

// ---------- input validation helpers (throw ServiceError) ----------
export const invalid = (field: string, message: string): ServiceError =>
  new ServiceError('VALIDATION', message, { field });

export function reqText(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== 'string') throw invalid(field, `${field} is required`);
  const t = v.trim();
  if (t.length < min || t.length > max)
    throw invalid(field, `${field} must be ${min}-${max} characters`);
  return t;
}

/** undefined / null / blank -> null. */
export function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw invalid(field, `${field} must be text`);
  const t = v.trim();
  if (t === '') return null;
  if (t.length > max) throw invalid(field, `${field} must be at most ${max} characters`);
  return t;
}

export function intIn(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
    throw invalid(field, `${field} must be an integer between ${min} and ${max}`);
  return v;
}

export function optIntIn(v: unknown, field: string, min: number, max: number): number | null {
  return v === undefined || v === null ? null : intIn(v, field, min, max);
}

/** Integer paisa. Non-integers -> MONEY_INVALID; negatives (or zero when not allowed) -> VALIDATION. */
export function money(
  v: unknown,
  field: string,
  opts: { allowZero?: boolean; allowNegative?: boolean } = {},
): Paisa {
  if (typeof v !== 'number' || !Number.isSafeInteger(v))
    throw new ServiceError('MONEY_INVALID', `${field} must be a whole number of paisa`, { field });
  if (v < 0 && opts.allowNegative !== true) throw invalid(field, `${field} must not be negative`);
  if (v === 0 && opts.allowZero === false)
    throw invalid(field, `${field} must be greater than zero`);
  return paisa(v);
}

/** Phone numbers are stored without spaces/dashes: +923001234567 or 03001234567. */
export function optPhone(v: unknown, field: string): string | null {
  const t = optText(v, field, 24);
  if (t === null) return null;
  const compact = t.replace(/[\s-]/g, '');
  if (!PhoneNumberSchema.safeParse(compact).success) throw invalid(field, 'Invalid phone number');
  return compact;
}

/** CNIC: 13 digits, dashes allowed in input and stripped. */
export function optCnic(v: unknown, field: string): string | null {
  const t = optText(v, field, 15);
  if (t === null) return null;
  const compact = t.replace(/-/g, '');
  if (!CnicSchema.safeParse(compact).success) throw invalid(field, 'CNIC must be 13 digits');
  return compact;
}
