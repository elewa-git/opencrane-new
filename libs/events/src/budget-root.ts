import { z } from 'zod';

const id = z.string().min(1);
export const budgetRootAllowanceSetDataSchema = z.object({
  rootId: id, requesterId: id, conversationId: id, turnId: id, threadId: id,
  assistantId: id, computerId: id, generation: z.int().nonnegative(), payingGroupId: id,
  allowanceCents: z.int().min(1).max(1000),
}).strict();
export const budgetRootStoppedDataSchema = z.discriminatedUnion('reason', [
  z.object({ rootId: id, reason: z.literal('allowance_exhausted'),
    attemptedBoundCents: z.int().positive(), availableCents: z.int().nonnegative() }).strict(),
  z.object({ rootId: id, reason: z.literal('ceiling_stop'), stopId: id }).strict(),
]);
