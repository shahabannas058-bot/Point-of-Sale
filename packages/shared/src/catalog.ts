import { z } from 'zod';
import {
  EpochMsSchema,
  NonNegativePaisaSchema,
  ProductIdSchema,
  ItemIdSchema,
  makeIssue,
} from './primitives';
import { UnitLabelSchema, UnitScaleSchema, unitScaleFor } from './units';

export const ProductSchema = z.object({
  id: ProductIdSchema,
  brand: z.string().min(1).max(60),
  name: z.string().min(1).max(120),
  category: z.string().max(60).nullable(),
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Product = z.infer<typeof ProductSchema>;

export const ItemSchema = z
  .object({
    id: ItemIdSchema,
    productId: ProductIdSchema,
    sku: z.string().min(1).max(64),
    barcode: z.string().min(1).max(64).nullable(),
    model: z.string().max(80).nullable(),
    colour: z.string().max(40).nullable(),
    /** Per priced unit (per piece, or per kg / litre when unitScale is 1000). */
    costPrice: NonNegativePaisaSchema,
    salePrice: NonNegativePaisaSchema,
    /** In base units (pieces, or grams / millilitres when unitScale is 1000). */
    reorderLevel: z.number().int().nonnegative(),
    unitScale: UnitScaleSchema.default(1),
    unitLabel: UnitLabelSchema.default('pcs'),
    isActive: z.boolean(),
    createdAt: EpochMsSchema,
    updatedAt: EpochMsSchema,
  })
  .superRefine((v, ctx) => {
    if (unitScaleFor(v.unitLabel) !== v.unitScale)
      makeIssue(ctx)(['unitScale'], 'unitScale must match unitLabel (pcs = 1, kg / L = 1000)');
  });
export type Item = z.infer<typeof ItemSchema>;
