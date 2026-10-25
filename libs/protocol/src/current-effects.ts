import { z } from 'zod';

const reference = z.string().min(1);
const position = z.int().nonnegative();
export const currentEffectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  continuation: z.string().min(1).max(4000).optional(),
}).strict();
export const currentEffectsResponseSchema = z.object({
  rows: z.array(z.object({
    permitId: reference, position: z.int().positive(),
    payingGroupId: reference.nullable(), assistantId: reference.nullable(),
    reservedAt: z.iso.datetime({ offset: true }),
    heldCents: z.int().nonnegative(), settledCents: z.int().nonnegative().nullable(),
    state: z.enum(['outcome_unknown', 'resolution_pending', 'released', 'settled']),
    conflict: z.boolean(), budgetPosition: position, effectPosition: position,
  }).strict()).max(50),
  sequence: position, generation: position, next: z.string().min(1).nullable(),
}).strict();
export type CurrentEffectsQuery = z.infer<typeof currentEffectsQuerySchema>;
export type CurrentEffectsResponse = z.infer<typeof currentEffectsResponseSchema>;
