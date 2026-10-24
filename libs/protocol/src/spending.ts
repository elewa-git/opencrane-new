import { z } from 'zod';

const reference = z.string().min(1);
const filter = reference.regex(/^[^.*>\s]+$/u);
const position = z.int().nonnegative();
export const spendingCallsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  continuation: z.string().min(1).max(4000).optional(),
  payingGroupId: filter.optional(),
  assistantId: filter.optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).optional(),
}).strict();
export const spendingCallsResponseSchema = z.object({
  rows: z.array(z.object({
    reservationId: reference, permitId: reference, position,
    payingGroupId: reference.nullable(), assistantId: reference.nullable(),
    reservedAt: z.iso.datetime({ offset: true }), day: z.iso.date(),
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    heldCents: z.int().nonnegative(), settledCents: z.int().nonnegative().nullable(),
    evidence: z.enum(['held', 'settled', 'unknown', 'not_dispatched']),
  }).strict()).max(50),
  sequence: position, generation: position, next: z.string().nullable(),
}).strict();
export type SpendingCallsQuery = z.infer<typeof spendingCallsQuerySchema>;
export type SpendingCallsResponse = z.infer<typeof spendingCallsResponseSchema>;
