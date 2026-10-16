import { z } from 'zod';
import { ProductKindSchema, PhoneConditionSchema, PtaStatusSchema } from './enums';
import {
  EpochMsSchema,
  ImeiSchema,
  NonNegativePaisaSchema,
  PhoneUnitIdSchema,
  ProductIdSchema,
  SupplierIdSchema,
  VariantIdSchema,
  makeIssue,
} from './primitives';

export const ProductSchema = z.object({
  id: ProductIdSchema,
  kind: ProductKindSchema,
  brand: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  category: z.string().max(60).nullable(),
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Product = z.infer<typeof ProductSchema>;

export const PhoneUnitSchema = z
  .object({
    id: PhoneUnitIdSchema,
    productId: ProductIdSchema,
    imei1: ImeiSchema.nullable(),
    imei2: ImeiSchema.nullable(),
    serial: z.string().min(1).max(64).nullable(),
    colour: z.string().max(40).nullable(),
    storageGb: z.number().int().positive().nullable(),
    ramGb: z.number().int().positive().nullable(),
    batteryHealthPct: z.number().int().min(0).max(100).nullable(),
    ptaStatus: PtaStatusSchema,
    condition: PhoneConditionSchema,
    costPrice: NonNegativePaisaSchema,
    salePrice: NonNegativePaisaSchema,
    supplierId: SupplierIdSchema.nullable(),
    note: z.string().max(500).nullable(),
    createdAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
  })
  .superRefine((u, ctx) => {
    const issue = makeIssue(ctx);
    if (u.imei1 === null && u.serial === null) issue(['imei1'], 'Provide imei1 or serial');
    if (u.imei2 !== null && u.imei1 === null) issue(['imei2'], 'imei2 requires imei1');
    if (u.imei1 !== null && u.imei1 === u.imei2) issue(['imei2'], 'imei2 must differ from imei1');
  });
export type PhoneUnit = z.infer<typeof PhoneUnitSchema>;

export const AccessoryVariantSchema = z.object({
  id: VariantIdSchema,
  productId: ProductIdSchema,
  sku: z.string().min(1).max(64),
  barcode: z.string().min(1).max(64).nullable(),
  model: z.string().max(80).nullable(),
  colour: z.string().max(40).nullable(),
  costPrice: NonNegativePaisaSchema,
  salePrice: NonNegativePaisaSchema,
  reorderLevel: z.number().int().nonnegative(),
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type AccessoryVariant = z.infer<typeof AccessoryVariantSchema>;
