import { z } from 'zod';
const text = z.string().min(1).max(8000);
export const approvalReviewSchema = z.object({ action: text, tool: text, target: text, data: text, destination: text, account: text, consequence: text }).strict();
const approvalCardSchema = z.object({
  approvalId: z.string(), conversationId: z.string(), requesterId: z.string(), expiresAt: z.string(),
  state: z.enum(['requested', 'approved', 'denied', 'expired', 'cancelled', 'outcome_unknown']),
  stepUp: z.boolean(), canDecide: z.boolean(), review: approvalReviewSchema,
}).strict();
export const approvalCardsSchema = z.array(approvalCardSchema);
export type ApprovalCard = z.infer<typeof approvalCardSchema>;
