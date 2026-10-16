import { z } from 'zod';
import { StockMovementTypeSchema, StockRefTypeSchema } from './enums';
import {
  BranchIdSchema,
  EpochMsSchema,
  NonNegativePaisaSchema,
  PaisaSchema,
  PhoneUnitIdSchema,
  PurchaseIdSchema,
  QuantitySchema,
  StockMovementIdSchema,
  SupplierIdSchema,
  UserIdSchema,
  UuidV7Schema,
  VariantIdSchema,
  makeIssue,
} from './primitives';

export const StockMovementSchema = z
  .object({
    id: StockMovementIdSchema,
    branchId: BranchIdSchema,
    type: StockMovementTypeSchema,
    phoneUnitId: PhoneUnitIdSchema.nullable(),
    variantId: VariantIdSchema.nullable(),
    /** Signed. sale < 0, purchase > 0; return/adjustment/transfer either sign. Phone units are always +1 / -1. */
    quantity: QuantitySchema,
    unitCost: NonNegativePaisaSchema.nullable(),
    refType: StockRefTypeSchema.nullable(),
    refId: UuidV7Schema.nullable(),
    reason: z.string().min(1).max(300).nullable(),
    createdBy: UserIdSchema,
    createdAt: EpochMsSchema,
  })
  .superRefine((m, ctx) => {
    const issue = makeIssue(ctx);
    if (m.quantity === 0) issue(['quantity'], 'Quantity cannot be zero');
    if ((m.phoneUnitId === null) === (m.variantId === null))
      issue(['variantId'], 'Exactly one of phoneUnitId / variantId is required');
    if (m.phoneUnitId !== null && Math.abs(m.quantity) !== 1)
      issue(['quantity'], 'Phone units move one at a time (+1 / -1)');
    if (m.type === 'sale' && m.quantity > 0)
      issue(['quantity'], 'A sale movement must be negative');
    if (m.type === 'purchase' && m.quantity < 0)
      issue(['quantity'], 'A purchase movement must be positive');
    if (m.type === 'adjustment' && m.reason === null)
      issue(['reason'], 'An adjustment needs a reason');
    if (m.type === 'transfer' && m.refType !== 'transfer')
      issue(['refType'], "A transfer movement must have refType 'transfer'");
    if ((m.refType === null) !== (m.refId === null))
      issue(['refId'], 'refType and refId must both be set or both null');
  });
export type StockMovement = z.infer<typeof StockMovementSchema>;

export const PurchaseSchema = z
  .object({
    id: PurchaseIdSchema,
    supplierId: SupplierIdSchema,
    branchId: BranchIdSchema,
    kind: z.enum(['purchase', 'return']),
    referenceNo: z.string().max(60).nullable(),
    total: PaisaSchema,
    note: z.string().max(500).nullable(),
    createdBy: UserIdSchema,
    createdAt: EpochMsSchema,
  })
  .superRefine((p, ctx) => {
    const issue = makeIssue(ctx);
    if (p.kind === 'purchase' && p.total < 0)
      issue(['total'], 'Purchase total must not be negative');
    if (p.kind === 'return' && p.total > 0)
      issue(['total'], 'Purchase return total must not be positive');
  });
export type Purchase = z.infer<typeof PurchaseSchema>;
