import { z } from 'zod';
import { OutboxEntityTypeSchema, OutboxOpSchema } from './enums';
import { EpochMsSchema, OutboxIdSchema, UuidV7Schema } from './primitives';

export const OutboxEntrySchema = z.object({
  id: OutboxIdSchema,
  entityType: OutboxEntityTypeSchema,
  entityId: UuidV7Schema,
  op: OutboxOpSchema,
  payload: z.string().min(2), // JSON text of the camelCase contract entity ('sale' => full Invoice)
  createdAt: EpochMsSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  sentAt: EpochMsSchema.nullable(),
});
export type OutboxEntry = z.infer<typeof OutboxEntrySchema>;
