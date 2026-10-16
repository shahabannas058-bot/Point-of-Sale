import { z } from 'zod';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const UuidV7Schema = z.string().regex(UUID_V7, 'Expected a lowercase UUID v7');
export type UuidV7 = z.infer<typeof UuidV7Schema>;

const brandedId = <B extends string>() => UuidV7Schema.brand<B>();

export const BranchIdSchema = brandedId<'BranchId'>();
export type BranchId = z.infer<typeof BranchIdSchema>;
export const DeviceIdSchema = brandedId<'DeviceId'>();
export type DeviceId = z.infer<typeof DeviceIdSchema>;
export const UserIdSchema = brandedId<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;
export const ProductIdSchema = brandedId<'ProductId'>();
export type ProductId = z.infer<typeof ProductIdSchema>;
export const PhoneUnitIdSchema = brandedId<'PhoneUnitId'>();
export type PhoneUnitId = z.infer<typeof PhoneUnitIdSchema>;
export const VariantIdSchema = brandedId<'VariantId'>();
export type VariantId = z.infer<typeof VariantIdSchema>;
export const CustomerIdSchema = brandedId<'CustomerId'>();
export type CustomerId = z.infer<typeof CustomerIdSchema>;
export const SupplierIdSchema = brandedId<'SupplierId'>();
export type SupplierId = z.infer<typeof SupplierIdSchema>;
export const PurchaseIdSchema = brandedId<'PurchaseId'>();
export type PurchaseId = z.infer<typeof PurchaseIdSchema>;
export const StockMovementIdSchema = brandedId<'StockMovementId'>();
export type StockMovementId = z.infer<typeof StockMovementIdSchema>;
export const SaleIdSchema = brandedId<'SaleId'>();
export type SaleId = z.infer<typeof SaleIdSchema>;
export const SaleLineIdSchema = brandedId<'SaleLineId'>();
export type SaleLineId = z.infer<typeof SaleLineIdSchema>;
export const PaymentIdSchema = brandedId<'PaymentId'>();
export type PaymentId = z.infer<typeof PaymentIdSchema>;
export const LedgerEntryIdSchema = brandedId<'LedgerEntryId'>();
export type LedgerEntryId = z.infer<typeof LedgerEntryIdSchema>;
export const OutboxIdSchema = brandedId<'OutboxId'>();
export type OutboxId = z.infer<typeof OutboxIdSchema>;

/** Signed integer paisa (PKR minor units). Negative values appear in returns, refunds and ledger credits. */
export const PaisaSchema = z.number().int().safe().brand<'Paisa'>();
export type Paisa = z.infer<typeof PaisaSchema>;
/** Prices and costs. Same brand as Paisa, so values flow freely into money math. */
export const NonNegativePaisaSchema = z.number().int().safe().nonnegative().brand<'Paisa'>();

/** Unix epoch milliseconds, UTC. */
export const EpochMsSchema = z.number().int().safe().nonnegative().brand<'EpochMs'>();
export type EpochMs = z.infer<typeof EpochMsSchema>;

/** Signed whole units (stock movements). */
export const QuantitySchema = z.number().int().safe();

export const GENESIS_HASH = '0'.repeat(64);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected lowercase SHA-256 hex');

export const ImeiSchema = z.string().regex(/^\d{15}$/, 'IMEI must be 15 digits');
export const CnicSchema = z.string().regex(/^\d{13}$/, 'CNIC must be 13 digits, no dashes');
export const PhoneNumberSchema = z.string().regex(/^\+?[0-9]{7,15}$/, 'Invalid phone number');

/** Helper for superRefine blocks. */
export const makeIssue =
  (ctx: z.RefinementCtx) =>
  (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
