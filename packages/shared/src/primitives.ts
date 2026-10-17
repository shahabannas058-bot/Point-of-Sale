/** Integer PKR minor units (1 rupee = 100 paisa). Never a float. */
export type Paisa = number & { readonly __brand: 'Paisa' };

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** UUID v7 as produced on the device (RFC 9562). */
export type Id = string;

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isUuidV7 = (v: unknown): v is Id => typeof v === 'string' && UUID_V7.test(v);

export const ROLES = ['owner', 'manager', 'cashier'] as const;
export type Role = (typeof ROLES)[number];

export const PAYMENT_METHODS = [
  'cash',
  'khata',
  'jazzcash',
  'easypaisa',
  'bank_transfer',
  'card',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PTA_STATUSES = ['approved', 'non_pta', 'jv'] as const;
export type PtaStatus = (typeof PTA_STATUSES)[number];

export const PHONE_CONDITIONS = ['new', 'used', 'open_box'] as const;
export type PhoneCondition = (typeof PHONE_CONDITIONS)[number];

export const SALE_KINDS = ['sale', 'return', 'void'] as const;
export type SaleKind = (typeof SALE_KINDS)[number];

export const PRODUCT_KINDS = ['phone', 'accessory'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const LEDGER_ENTRY_TYPES = [
  'sale_credit',
  'payment_received',
  'return_credit',
  'purchase_credit',
  'payment_made',
  'purchase_return',
  'opening_balance',
  'adjustment',
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export const STOCK_MOVEMENT_TYPES = [
  'opening',
  'purchase',
  'sale',
  'return',
  'void',
  'adjustment',
  'purchase_return',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export const APPROVAL_REASONS = ['discount', 'credit_limit', 'return', 'void'] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];
