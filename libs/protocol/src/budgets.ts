import { z } from 'zod';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const cents = z.int().nonnegative();
const fields = { commandId: id, expectedSequence: z.int().nonnegative(), ceilingCents: cents };
export const budgetCommandSchema = z.discriminatedUnion('scope', [
  z.object({ ...fields, scope: z.literal('global'), dailyCeilingCents: cents.optional(), defaultPayingGroupId: id.optional() }).strict(),
  z.object({ ...fields, scope: z.literal('paying_group'), scopeId: id }).strict(),
  z.object({ ...fields, scope: z.literal('assistant'), scopeId: id }).strict(),
]);
const totals = { todayCents: cents, monthCents: cents, reservedCents: cents, ceilingCents: cents };
export const budgetSummarySchema = z.object({
  sequence: z.int().nonnegative(), defaultPayingGroupId: id.nullable(), periodStart: z.string().nullable(),
  ...totals, dailyCeilingCents: cents,
  ceilings: z.array(z.object({ scope: z.enum(['paying_group', 'assistant']), scopeId: id, ...totals })),
});
export type BudgetSummary = z.infer<typeof budgetSummarySchema>;

export const budgetChoicesQuerySchema = z.object({
  kind: z.enum(['paying_group', 'assistant']),
  after: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strict();
const budgetChoiceCap = z.discriminatedUnion('status', [
  z.object({ status: z.literal('set'), ceilingCents: cents }).strict(),
  z.object({ status: z.literal('not_configured') }).strict(),
  z.object({ status: z.literal('unavailable') }).strict(),
]);
export const budgetChoicesResponseSchema = z.object({
  status: z.enum(['current', 'applying']),
  rows: z.array(z.object({
    id, displayName: z.string().min(1).max(200),
    sequence: z.int().positive(), cap: budgetChoiceCap,
  }).strict()).max(50),
  next: id.nullable(),
}).strict();

const stopReason = z.object({
  scope: z.enum(['global', 'paying_group', 'assistant']),
  period: z.enum(['daily', 'monthly']),
  cause: z.enum(['bound_refused', 'zero_ceiling', 'ceiling_lowered', 'legacy_exhaustion']),
  resetAt: z.iso.datetime({ offset: true }),
  remedy: z.enum(['ask_admin', 'ask_admin_or_wait']),
  limitCents: cents.optional(),
}).strict();
const stoppedWork = z.object({
  turnId: id, execution: z.enum(['not_started', 'stopping', 'ended']),
}).strict();
const stoppedCall = z.discriminatedUnion('status', [
  z.object({ reference: id, status: z.enum(['held', 'possibly_sent']),
    heldCents: cents.optional() }).strict(),
  z.object({ reference: id, status: z.literal('charged'),
    chargedCents: cents.optional() }).strict(),
  z.object({ reference: id, status: z.literal('released') }).strict(),
]);
const position = z.int().nonnegative();
export const budgetStopStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_stopped') }).strict(),
  z.object({ status: z.literal('stopped'), stopId: id,
    reasons: z.array(stopReason).min(1), work: z.array(stoppedWork), calls: z.array(stoppedCall),
    positions: z.object({ stop: position, turn: position.nullable(), conversation: position,
      computer: position, budget: position }).strict(),
  }).strict(),
]);
export type BudgetStopStatus = z.infer<typeof budgetStopStatusSchema>;
