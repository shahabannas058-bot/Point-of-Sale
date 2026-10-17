export const SERVICE_ERROR_CODES = [
  'NOT_SETUP',
  'ALREADY_SETUP',
  'NOT_AUTHENTICATED',
  'INVALID_CREDENTIALS',
  'LOGIN_LOCKED',
  'FORBIDDEN',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'LICENCE_BLOCKED',
  'VALIDATION',
  'NOT_FOUND',
  'DUPLICATE',
  'EMPTY_CART',
  'STOCK_INSUFFICIENT',
  'UNIT_NOT_IN_STOCK',
  'PAYMENT_MISMATCH',
  'KHATA_NEEDS_CUSTOMER',
  'DISCOUNT_INVALID',
  'MONEY_INVALID',
  'ALREADY_RETURNED',
  'RETURN_NOT_ALLOWED',
  'CHAIN_CONFLICT',
  'IMMUTABLE_RECORD',
  'LEDGER_CORRUPT',
  'DB_CONSTRAINT',
  'INTERNAL',
] as const;
export type ServiceErrorCode = (typeof SERVICE_ERROR_CODES)[number];

/** The only error type the service layer throws. The UI maps `code` to its `err.<CODE>` translation. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ServiceErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.details = details;
  }
}

/** Duck-typed so errors that crossed a bridge (or a second bundle copy) still count. */
export function isServiceError(e: unknown): e is ServiceError {
  if (e instanceof ServiceError) return true;
  if (typeof e !== 'object' || e === null) return false;
  const c = (e as { code?: unknown }).code;
  return (
    typeof c === 'string' &&
    (SERVICE_ERROR_CODES as readonly string[]).includes(c) &&
    typeof (e as { details?: unknown }).details === 'object'
  );
}
