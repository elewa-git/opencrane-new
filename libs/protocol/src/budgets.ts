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
const position = z.int().nonnegative();
export const budgetStopStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_stopped') }).strict(),
  z.object({ status: z.literal('stopped'), stopId: id,
    reasons: z.array(stopReason).min(1), work: z.array(stoppedWork),
    positions: z.object({ stop: position, turn: position.nullable(), conversation: position,
      computer: position, budget: position }).strict(),
  }).strict(),
]);
export type BudgetStopStatus = z.infer<typeof budgetStopStatusSchema>;
