import { z } from 'zod';
import { approvalCancelReasonSchema } from '@opencrane/events';
const text = z.string().min(1).max(8000);
export const approvalReviewSchema = z.object({ action: text, tool: text, target: z.string().max(8000), data: text, destination: text, account: text, consequence: text }).strict();
const approvalCardSchema = z.object({
  approvalId: z.string(), conversationId: z.string(), turnId: z.string().optional(),
  requesterId: z.string(), expiresAt: z.string(),
  requestedAt: z.iso.datetime().optional(), decidedAt: z.iso.datetime().optional(),
  usedAt: z.iso.datetime().optional(), endedAt: z.iso.datetime().optional(),
  cancelReason: approvalCancelReasonSchema.optional(),
  uses: z.array(z.strictObject({ permitId: z.string(), usedAt: z.iso.datetime() })).optional(),
  state: z.enum(['requested', 'approved', 'denied', 'expired', 'cancelled', 'outcome_unknown']),
  missingFields: z.array(text).optional(),
  canRetry: z.boolean().optional(), canApprove: z.boolean().optional(), canDeny: z.boolean().optional(),
  stepUp: z.boolean(), canDecide: z.boolean(), review: approvalReviewSchema,
}).strict();
export const approvalCardsSchema = z.array(approvalCardSchema);
export type ApprovalCard = z.infer<typeof approvalCardSchema>;
