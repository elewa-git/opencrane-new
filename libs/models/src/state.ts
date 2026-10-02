import { z } from 'zod';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Projection, Query } from '@opencrane/projections';

// Pinned 2 October 2026, standard OpenAI text prices, planning FX 95/100 EUR/USD.
// Per 100 million tokens keeps even the nano price an integer number of cents.
export const priceTableId = 'openai-2026-10-02-eur95';
export const models = [
  { id: 'gpt-5-nano', default: true, inputCents: 475, outputCents: 3800, perTokens: 100_000_000 },
  { id: 'gpt-5-mini', default: false, inputCents: 2375, outputCents: 19000, perTokens: 100_000_000 },
] as const;
export function costCents(model: string, inputTokens: number, outputTokens: number): number {
  const price = models.find(row => row.id === model);
  if (!price || ![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid usage');
  const numerator = BigInt(inputTokens) * BigInt(price.inputCents) + BigInt(outputTokens) * BigInt(price.outputCents);
  const cents = Number((numerator + BigInt(price.perTokens) - 1n) / BigInt(price.perTokens));
  if (!Number.isSafeInteger(cents)) throw new Error('Cost overflow');
  return cents;
}
export function data(event: EventEnvelope): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(event.data);
}
const callSchema = z.object({ model: z.string(), priceTableId: z.literal(priceTableId), computerId: z.string(),
  assistantId: z.string(), requesterId: z.string(), conversationId: z.string(), turnId: z.string(), threadId: z.string(), contextDigest: z.string() }).strict();
export type ModelCall = z.infer<typeof callSchema>;
const reservationSchema = z.object({ id: z.string(), amountCents: z.int().nonnegative(), time: z.string(),
  call: callSchema, settledCents: z.int().nonnegative().optional() });
const stateSchema = z.object({ dailyCeilingCents: z.int().nonnegative(), ceilingCents: z.int().nonnegative(),
  reservations: z.array(reservationSchema) });
export type BudgetState = z.infer<typeof stateSchema>;
export const emptyBudget = (): BudgetState => ({ dailyCeilingCents: 0, ceilingCents: 0, reservations: [] });
export function applyBudget(state: BudgetState, event: EventEnvelope): void {
  if (!event.type.startsWith('budget.')) return;
  const d = data(event);
  if (event.type === 'budget.ceiling_set') {
    if (d['scope'] !== 'global' || d['dailyCeilingCents'] === undefined) throw new Error('Unsupported budget ceiling');
    state.dailyCeilingCents = z.int().nonnegative().parse(d['dailyCeilingCents']);
    state.ceilingCents = z.int().nonnegative().parse(d['ceilingCents']);
  } else if (event.type === 'budget.reserved') {
    state.reservations.push({ id: z.string().parse(d['reservationId']), time: event.time,
      amountCents: z.int().nonnegative().parse(d['amountCents']), call: callSchema.parse(d['modelCall']) });
  } else if (event.type === 'budget.settled') {
    const reservation = state.reservations.find(r => r.id === d['reservationId']);
    if (!reservation) throw new Error('Unknown reservation');
    reservation.settledCents = z.int().nonnegative().parse(d['settledCents']);
  }
}
export function totals(state: BudgetState, now = new Date()) {
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
  let todayCents = 0, monthCents = 0, reservedCents = 0;
  for (const r of state.reservations) {
    if (r.settledCents === undefined) reservedCents += r.amountCents;
    else {
      if (r.time.startsWith(day)) todayCents += r.settledCents;
      if (r.time.startsWith(month)) monthCents += r.settledCents;
    }
  }
  return { todayCents, monthCents, reservedCents, dailyCeilingCents: state.dailyCeilingCents, ceilingCents: state.ceilingCents };
}
export async function readBudget(db: Query, silo: string): Promise<BudgetState> {
  const result = await db.query<{ state: unknown }>('SELECT state FROM model_budgets WHERE silo = $1', [silo]);
  if (!result.rows[0]) throw new Error('Budget not initialised');
  return stateSchema.parse(result.rows[0].state);
}
// ponytail: one JSON row holds Phase 2 history; split reservations into rows when volume demands it.
export const budgets: Projection = {
  name: 'model-budgets',
  async create(db) { await db.query('CREATE TABLE IF NOT EXISTS model_budgets (silo TEXT PRIMARY KEY, state JSONB NOT NULL)'); },
  async drop(db) { await db.query('DROP TABLE IF EXISTS model_budgets'); },
  async apply(db, event) {
    if (!event.type.startsWith('budget.')) return;
    if (!parseEventByType(event).success) throw new Error('Invalid budget event');
    const rows = await db.query<{ state: unknown }>('SELECT state FROM model_budgets WHERE silo = $1', [event.silo]);
    const state = rows.rows[0] ? stateSchema.parse(rows.rows[0].state) : emptyBudget();
    applyBudget(state, event);
    await db.query('INSERT INTO model_budgets VALUES ($1, $2) ON CONFLICT (silo) DO UPDATE SET state = $2', [event.silo, JSON.stringify(state)]);
  },
};
