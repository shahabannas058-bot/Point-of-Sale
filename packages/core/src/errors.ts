export type DomainErrorCode =
  | 'MONEY_INVALID'
  | 'DISCOUNT_INVALID'
  | 'PAYMENT_MISMATCH'
  | 'STOCK_INVALID'
  | 'STOCK_INSUFFICIENT'
  | 'LEDGER_CORRUPT'
  | 'CANONICAL_INVALID'
  | 'INVOICE_NO_INVALID';

export class DomainError extends Error {
  override name = 'DomainError';
  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
