import { z } from 'zod';
import { PaymentMethodSchema, SaleKindSchema } from './enums';
import {
  BranchIdSchema,
  CustomerIdSchema,
  DeviceIdSchema,
  EpochMsSchema,
  NonNegativePaisaSchema,
  PaisaSchema,
  PaymentIdSchema,
  PhoneUnitIdSchema,
  ProductIdSchema,
  SaleIdSchema,
  SaleLineIdSchema,
  Sha256HexSchema,
  UserIdSchema,
  VariantIdSchema,
  makeIssue,
} from './primitives';

export const PaymentSchema = z.object({
  id: PaymentIdSchema,
  saleId: SaleIdSchema,
  method: PaymentMethodSchema,
  /** Positive for sales, negative for refunds on return/void invoices. */
  amount: PaisaSchema.refine((n) => n !== 0, 'Payment amount cannot be zero'),
  reference: z.string().min(1).max(100).nullable(),
  createdAt: EpochMsSchema,
});
export type Payment = z.infer<typeof PaymentSchema>;

export const SaleLineSchema = z
  .object({
    id: SaleLineIdSchema,
    saleId: SaleIdSchema,
    lineNo: z.number().int().positive(),
    productId: ProductIdSchema,
    phoneUnitId: PhoneUnitIdSchema.nullable(),
    variantId: VariantIdSchema.nullable(),
    description: z.string().min(1).max(200), // name snapshot at time of sale
    quantity: z
      .number()
      .int()
      .safe()
      .refine((n) => n !== 0, 'Quantity cannot be zero'),
    unitPrice: NonNegativePaisaSchema,
    costPrice: NonNegativePaisaSchema, // snapshot for profit reports
    discountAmount: PaisaSchema, // same sign as quantity * unitPrice
    lineTotal: PaisaSchema,
    createdAt: EpochMsSchema,
  })
  .superRefine((l, ctx) => {
    const issue = makeIssue(ctx);
    if ((l.phoneUnitId === null) === (l.variantId === null))
      issue(['variantId'], 'Exactly one of phoneUnitId / variantId is required');
    if (l.phoneUnitId !== null && Math.abs(l.quantity) !== 1)
      issue(['quantity'], 'Phone units are sold one at a time');
    if (l.lineTotal !== l.quantity * l.unitPrice - l.discountAmount)
      issue(['lineTotal'], 'lineTotal must equal quantity * unitPrice - discountAmount');
  });
export type SaleLine = z.infer<typeof SaleLineSchema>;

export const SaleBaseSchema = z.object({
  id: SaleIdSchema,
  deviceId: DeviceIdSchema,
  seq: z.number().int().safe().positive(), // gapless per device
  invoiceNo: z.string().min(1).max(32),
  kind: SaleKindSchema,
  originalSaleId: SaleIdSchema.nullable(),
  branchId: BranchIdSchema,
  customerId: CustomerIdSchema.nullable(), // null = walk-in
  cashierId: UserIdSchema,
  subtotal: PaisaSchema,
  discountTotal: PaisaSchema,
  total: PaisaSchema,
  note: z.string().max(500).nullable(),
  createdAt: EpochMsSchema,
  hashVersion: z.literal(1),
  prevHash: Sha256HexSchema,
  hash: Sha256HexSchema,
});

type SaleHeader = z.infer<typeof SaleBaseSchema>;

function checkSaleHeader(s: SaleHeader, ctx: z.RefinementCtx): void {
  const issue = makeIssue(ctx);
  if (s.total !== s.subtotal - s.discountTotal)
    issue(['total'], 'total must equal subtotal - discountTotal');
  if (s.kind === 'sale') {
    if (s.originalSaleId !== null)
      issue(['originalSaleId'], 'A sale cannot reference an original sale');
    if (s.subtotal < 0 || s.discountTotal < 0 || s.total < 0)
      issue(['total'], 'Sale amounts must not be negative');
  } else {
    if (s.originalSaleId === null)
      issue(['originalSaleId'], 'Returns and voids must reference the original sale');
    if (s.subtotal > 0 || s.discountTotal > 0 || s.total > 0)
      issue(['total'], 'Return/void amounts must not be positive');
  }
}

export const SaleSchema = SaleBaseSchema.superRefine(checkSaleHeader);
export type Sale = z.infer<typeof SaleSchema>;

/** A sale header with its lines and payments: the unit that is hashed, synced and printed. */
export const InvoiceSchema = SaleBaseSchema.extend({
  lines: z.array(SaleLineSchema).min(1),
  payments: z.array(PaymentSchema),
}).superRefine((inv, ctx) => {
  checkSaleHeader(inv, ctx);
  const issue = makeIssue(ctx);
  const sign = inv.kind === 'sale' ? 1 : -1;

  let linesSum = 0;
  inv.lines.forEach((l, i) => {
    linesSum += l.lineTotal;
    if (l.saleId !== inv.id) issue(['lines', i, 'saleId'], 'Line belongs to another sale');
    if (Math.sign(l.quantity) !== sign)
      issue(
        ['lines', i, 'quantity'],
        sign === 1 ? 'Sale quantities must be positive' : 'Return/void quantities must be negative',
      );
  });
  if (linesSum !== inv.subtotal) issue(['subtotal'], 'subtotal must equal the sum of line totals');

  let paid = 0;
  inv.payments.forEach((p, i) => {
    paid += p.amount;
    if (p.saleId !== inv.id) issue(['payments', i, 'saleId'], 'Payment belongs to another sale');
    if (Math.sign(p.amount) !== sign)
      issue(['payments', i, 'amount'], 'Payment sign must match the invoice kind');
    if (p.method === 'khata' && inv.customerId === null)
      issue(['payments', i, 'method'], 'Khata payment requires a customer');
  });
  if (paid !== inv.total) issue(['payments'], 'Payments must sum exactly to the invoice total');
});
export type Invoice = z.infer<typeof InvoiceSchema>;
export type UnsealedInvoice = Omit<Invoice, 'prevHash' | 'hash'>;
