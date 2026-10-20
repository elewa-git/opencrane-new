import { z } from 'zod';
import { chatIdSchema, childRequestedDataSchema, childStartFailedDataSchema } from '@opencrane/events';

export const childReviewInputSchema = z.strictObject({
  requestId: chatIdSchema, sourceMessageId: chatIdSchema, assistantId: chatIdSchema,
  participantIds: z.array(chatIdSchema).min(1).max(97),
  allowanceBoundCents: childRequestedDataSchema.shape.allowanceBoundCents.default(1000),
});
export const childStartInputSchema = z.strictObject({
  requestId: chatIdSchema, sourceMessageId: chatIdSchema, review: z.string().max(128_000),
});
export const childRequestStatusSchema = z.union([
  z.strictObject({ state: z.literal('unknown') }),
  z.strictObject({ state: z.literal('failed'), requestId: chatIdSchema,
    stage: childStartFailedDataSchema.shape.stage, reason: childStartFailedDataSchema.shape.reason,
    attempt: childStartFailedDataSchema.shape.attempt, failureEventId: chatIdSchema }),
  z.strictObject({ state: z.literal('queued'), requestId: chatIdSchema,
    childConversationId: chatIdSchema.optional() }),
]);
