import { z } from 'zod';

export const approvalCancelReasonSchema = z.enum([
  'turn_ended', 'turn_stopped', 'new_message', 'new_turn', 'conversation_closed',
  'unpublished', 'connection_changed', 'policy_changed', 'grant_revoked',
  'schema_changed', 'profile_changed',
]);
export const approvalCancelledDataSchema = z.strictObject({
  approvalId: z.string().min(1), cancelReason: approvalCancelReasonSchema.optional(),
});
