import { z } from 'zod';
import { RoleSchema } from './enums';
import {
  BranchIdSchema,
  CnicSchema,
  CustomerIdSchema,
  EpochMsSchema,
  NonNegativePaisaSchema,
  PhoneNumberSchema,
  SupplierIdSchema,
  UserIdSchema,
} from './primitives';

export const BranchSchema = z.object({
  id: BranchIdSchema,
  name: z.string().min(1).max(100),
  createdAt: EpochMsSchema,
});
export type Branch = z.infer<typeof BranchSchema>;

/** Public user shape. pin_hash exists only in the DB and Rust side; it never crosses the contract. */
export const UserSchema = z.object({
  id: UserIdSchema,
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9._-]+$/),
  displayName: z.string().min(1).max(100),
  role: RoleSchema,
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type User = z.infer<typeof UserSchema>;

export const CustomerSchema = z.object({
  id: CustomerIdSchema,
  name: z.string().min(1).max(100),
  phone: PhoneNumberSchema.nullable(),
  cnic: CnicSchema.nullable(),
  address: z.string().max(300).nullable(),
  creditLimit: NonNegativePaisaSchema.nullable(), // null = no limit
  notes: z.string().max(500).nullable(),
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Customer = z.infer<typeof CustomerSchema>;

export const SupplierSchema = z.object({
  id: SupplierIdSchema,
  name: z.string().min(1).max(100),
  phone: PhoneNumberSchema.nullable(),
  address: z.string().max(300).nullable(),
  notes: z.string().max(500).nullable(),
  isActive: z.boolean(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Supplier = z.infer<typeof SupplierSchema>;
