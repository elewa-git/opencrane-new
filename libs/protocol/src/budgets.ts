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
