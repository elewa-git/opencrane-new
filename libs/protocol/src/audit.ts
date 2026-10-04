import { z } from 'zod';

export const auditReasons = {
  model_allowed: 'Model call permitted', policy_allow: 'Tool policy permits this call', policy_block: 'Tool policy blocks this call',
  approval_required: 'Requester approval needed', budget_exhausted: 'Spending cap reached',
  approval_requested: 'Requester approval needed', approval_approved: 'Approval not consumed', approval_used: 'Single-use approval consumed',
  approval_denied: 'Requester declined approval', approval_expired: 'Approval expired', approval_cancelled: 'Approval cancelled',
  approval_outcome_unknown: 'Approval already consumed; outcome unknown',
  request_refused: 'Request refused', authority_unavailable: 'Authority unavailable', settle_timeout: 'Observation missing',
  unknown_cost: 'Tool cost unavailable', unknown_tariff: 'Price unavailable', computer_lost: 'Computer unavailable', effect_without_permit: 'Effect has no matching permission',
  jwt_failed: 'Gateway authentication refused', dispatch_denied: 'Gateway refused dispatch',
} as const;

const id = z.string().regex(/^[\w:.-]{1,300}$/u);
export const auditRecordSchema = z.object({
  eventId: id, type: id, position: z.number().int().positive(),
  source: z.enum(['decision', 'gateway', 'computer', 'authoritative']),
  status: z.enum(['allow', 'ask', 'deny', 'success', 'error', 'unknown', 'not_dispatched', 'recorded']),
  reason: z.enum([...Object.values(auditReasons), 'Recorded reason withheld']).optional(), amountCents: z.number().int().nonnegative().safe().optional(),
}).strict();
export const auditRowSchema = z.object({
  id, requestId: id.optional(), permitId: id.optional(), conversationId: id.optional(), turnId: id.optional(),
  requesterId: id.optional(), contextDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  decision: z.enum(['allow', 'ask', 'deny', 'not_recorded']),
  outcome: z.enum(['success', 'error', 'unknown', 'not_dispatched', 'recorded']),
  reservedCents: z.number().int().nonnegative().safe().optional(), settledCents: z.number().int().nonnegative().safe().optional(),
  records: z.array(auditRecordSchema),
}).strict();
export const auditResponseSchema = z.object({ rows: z.array(auditRowSchema), nextBefore: z.number().int().positive().optional() }).strict();
export const auditFilterSchema = z.object({
  before: z.coerce.number().int().positive().safe().optional(),
  requestId: id.optional(), turnId: id.optional(),
  decision: z.enum(['allow', 'ask', 'deny']).optional(),
}).strict();
export type AuditRow = z.infer<typeof auditRowSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditFilter = z.infer<typeof auditFilterSchema>;
