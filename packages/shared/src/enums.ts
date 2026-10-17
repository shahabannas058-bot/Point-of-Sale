import { z } from 'zod';

export const PRODUCT_KINDS = ['phone', 'accessory'] as const;
export const ProductKindSchema = z.enum(PRODUCT_KINDS);
export type ProductKind = z.infer<typeof ProductKindSchema>;

export const PTA_STATUSES = ['approved', 'non_pta', 'jv'] as const;
export const PtaStatusSchema = z.enum(PTA_STATUSES);
export type PtaStatus = z.infer<typeof PtaStatusSchema>;

export const PHONE_CONDITIONS = ['new', 'used', 'open_box'] as const;
export const PhoneConditionSchema = z.enum(PHONE_CONDITIONS);
export type PhoneCondition = z.infer<typeof PhoneConditionSchema>;

export const STOCK_MOVEMENT_TYPES = [
  'sale',
  'purchase',
  'return',
  'adjustment',
  'transfer',
] as const;
export const StockMovementTypeSchema = z.enum(STOCK_MOVEMENT_TYPES);
export type StockMovementType = z.infer<typeof StockMovementTypeSchema>;

export const STOCK_REF_TYPES = ['sale', 'purchase', 'transfer'] as const;
export const StockRefTypeSchema = z.enum(STOCK_REF_TYPES);
export type StockRefType = z.infer<typeof StockRefTypeSchema>;

export const PAYMENT_METHODS = [
  'cash',
  'khata',
  'jazzcash',
  'easypaisa',
  'bank_transfer',
  'card',
] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const SALE_KINDS = ['sale', 'return', 'void'] as const;
export const SaleKindSchema = z.enum(SALE_KINDS);
export type SaleKind = z.infer<typeof SaleKindSchema>;

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
export const LedgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export type LedgerEntryType = z.infer<typeof LedgerEntryTypeSchema>;
export const CUSTOMER_LEDGER_TYPES = [
  'sale_credit',
  'payment_received',
  'return_credit',
  'opening_balance',
  'adjustment',
] as const;
export const SUPPLIER_LEDGER_TYPES = [
  'purchase_credit',
  'payment_made',
  'purchase_return',
  'opening_balance',
  'adjustment',
] as const;
export const LEDGER_POSITIVE_TYPES = ['sale_credit', 'purchase_credit'] as const;
export const LEDGER_NEGATIVE_TYPES = [
  'payment_received',
  'return_credit',
  'payment_made',
  'purchase_return',
] as const;

export const ROLES = ['owner', 'manager', 'cashier'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const OUTBOX_OPS = ['insert', 'update'] as const;
export const OutboxOpSchema = z.enum(OUTBOX_OPS);
export type OutboxOp = z.infer<typeof OutboxOpSchema>;

export const OUTBOX_ENTITY_TYPES = [
  'branch',
  'user',
  'product',
  'phone_unit',
  'accessory_variant',
  'customer',
  'supplier',
  'purchase',
  'stock_movement',
  'sale',
  'ledger_entry',
  'repair_ticket',
  'repair_status',
  'repair_part',
  'repair_payment',
  'warranty',
] as const;
export const OutboxEntityTypeSchema = z.enum(OUTBOX_ENTITY_TYPES);
export type OutboxEntityType = z.infer<typeof OutboxEntityTypeSchema>;
