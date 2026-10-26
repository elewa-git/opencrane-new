import { z } from 'zod';

const id = z.string().min(1);
export const budgetRootAllowanceSetDataSchema = z.object({
  rootId: id, requesterId: id, conversationId: id, turnId: id, threadId: id,
  assistantId: id, computerId: id, generation: z.int().nonnegative(), payingGroupId: id,
  allowanceCents: z.int().min(1).max(1000),
  preparationDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();
const sourceStopSchema = z.object({
  rootId: id, reason: z.enum(['requester_stop', 'turn_ended', 'access_revoked']),
  sourceSubject: id, sourcePosition: z.int().positive(), sourceEventId: id,
}).strict();
export const budgetRootStoppedDataSchema = z.discriminatedUnion('reason', [
  sourceStopSchema,
  z.object({ rootId: id, reason: z.literal('allowance_exhausted'),
    attemptedBoundCents: z.int().positive(), availableCents: z.int().nonnegative() }).strict(),
  z.object({ rootId: id, reason: z.literal('ceiling_stop'), stopId: id }).strict(),
  z.object({ rootId: id, reason: z.literal('budget_reservation_exceeded'),
    reservationId: id }).strict(),
]);

// Keep older holds readable; only new rooted model calls carry retry hashes.
export const budgetCallRetrySchema = z.object({
  dispatchGate: z.literal(1).optional(),
  // Keep the original native access expiry in Unix milliseconds through writer restarts.
  accessExpiresAt: z.int().nonnegative().optional(),
  retryDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});
