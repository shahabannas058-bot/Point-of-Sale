import { z } from 'zod';
import {
  CUSTOMER_LEDGER_TYPES,
  LEDGER_NEGATIVE_TYPES,
  LEDGER_POSITIVE_TYPES,
  LedgerEntryTypeSchema,
  PaymentMethodSchema,
  SUPPLIER_LEDGER_TYPES,
} from './enums';
import {
  CustomerIdSchema,
  EpochMsSchema,
  LedgerEntryIdSchema,
  PaisaSchema,
  PurchaseIdSchema,
  SaleIdSchema,
  SupplierIdSchema,
  UserIdSchema,
  makeIssue,
} from './primitives';

const has = (list: readonly string[], v: string): boolean => list.includes(v);

/**
 * Khata ledger. balance = SUM(amount) per party.
 * Customer: positive = customer owes the shop. Supplier: positive = shop owes the supplier.
 */
export const LedgerEntrySchema = z
  .object({
    id: LedgerEntryIdSchema,
    customerId: CustomerIdSchema.nullable(),
    supplierId: SupplierIdSchema.nullable(),
    type: LedgerEntryTypeSchema,
    amount: PaisaSchema,
    method: PaymentMethodSchema.exclude(['khata']).nullable(),
    saleId: SaleIdSchema.nullable(),
    purchaseId: PurchaseIdSchema.nullable(),
    note: z.string().max(500).nullable(),
    createdBy: UserIdSchema,
    createdAt: EpochMsSchema,
  })
  .superRefine((e, ctx) => {
    const issue = makeIssue(ctx);
    if (e.amount === 0) issue(['amount'], 'Amount cannot be zero');
    if ((e.customerId === null) === (e.supplierId === null))
      issue(['customerId'], 'Exactly one of customerId / supplierId is required');
    if (e.customerId !== null && !has(CUSTOMER_LEDGER_TYPES, e.type))
      issue(['type'], 'Entry type is not valid for a customer');
    if (e.supplierId !== null && !has(SUPPLIER_LEDGER_TYPES, e.type))
      issue(['type'], 'Entry type is not valid for a supplier');
    if (has(LEDGER_POSITIVE_TYPES, e.type) && e.amount <= 0)
      issue(['amount'], 'This entry type must be positive');
    if (has(LEDGER_NEGATIVE_TYPES, e.type) && e.amount >= 0)
      issue(['amount'], 'This entry type must be negative');
  });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
