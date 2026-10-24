import { z } from 'zod';

const reference = z.string().min(1);
const position = z.int().nonnegative();
export const spendingEffectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  permitId: reference.regex(/^[^.*>\s]+$/u).optional(),
  continuation: z.string().min(1).max(4000).optional(),
}).strict();
export const spendingEffectsResponseSchema = z.object({
  rows: z.array(z.object({
    eventId: reference, permitId: reference, position: z.int().positive(),
    time: z.iso.datetime({ offset: true }),
    type: z.enum(['effect.observed', 'effect.uncertain', 'effect.resolved']),
    outcome: z.enum(['success', 'error', 'settled', 'released']).nullable(),
    costCents: z.int().nonnegative().nullable(),
    settledCents: z.int().nonnegative().nullable(),
    resolvedBy: reference.nullable(), changeRef: reference.nullable(),
  }).strict()).max(50),
  sequence: position, generation: position, next: z.string().min(1).nullable(),
}).strict();
export type SpendingEffectsQuery = z.infer<typeof spendingEffectsQuerySchema>;
export type SpendingEffectsResponse = z.infer<typeof spendingEffectsResponseSchema>;
