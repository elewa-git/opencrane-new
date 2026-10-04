import { z } from 'zod';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Projection, Query } from '@opencrane/projections';

// Pinned standard USD prices, 2 October 2026, at the existing EUR 95/100 planning FX.
// Integer euro cents per billion tokens retain the $0.125 cache-write rate exactly.
export const priceTableId = 'openai-2026-10-02-all-eur95';
export const shortContextTokens = 272_000;
// Requests and unmeasured reservations use the full supported model context.
const MAX_CONTEXT_TOKENS = 1_050_000;
// Reserve at long-context rates before the tier boundary to leave rendering headroom.
const LONG_CONTEXT_RESERVATION_MARGIN = 0.9;
const perTokens = 1_000_000_000;
function rates(input: number, cached: number | null, writes: number | null, output: number) {
  return { inputCents: input * 95, cachedInputCents: cached === null ? null : cached * 95,
    cacheWriteCents: writes === null ? null : writes * 95, outputCents: output * 95 };
}
// USD thousandths per million tokens; this is the only price data to update.
export const models = [
  { id: 'gpt-6-astra', short: rates(10000, 1000, 12500, 50000), long: rates(20000, 2000, 25000, 75000) },
  { id: 'gpt-6.1-sol', short: rates(2000, 100, 2500, 10000), long: rates(4000, 200, 5000, 15000) },
  { id: 'gpt-6-luna', short: rates(100, 10, 125, 500), long: rates(200, 20, 250, 750) },
  { id: 'gpt-6-sol', short: rates(2000, 200, 2500, 10000), long: rates(4000, 400, 5000, 15000) },
  { id: 'gpt-5.6-sol', short: rates(4000, 400, 5000, 20000), long: rates(8000, 800, 10000, 30000) },
  { id: 'gpt-5.6-terra', short: rates(2000, 200, 2500, 12000), long: rates(4000, 400, 5000, 18000) },
  { id: 'gpt-5.6-luna', short: rates(200, 20, 250, 1200), long: rates(400, 40, 500, 1800) },
  { id: 'gpt-5.5', short: rates(5000, 500, null, 30000), long: rates(10000, 1000, null, 45000) },
  { id: 'gpt-5.5-pro', short: rates(30000, null, null, 180000), long: rates(60000, null, null, 270000) },
  { id: 'gpt-5.4', short: rates(2500, 250, null, 15000), long: rates(5000, 500, null, 22500) },
  { id: 'gpt-5.4-pro', short: rates(30000, null, null, 180000), long: rates(60000, null, null, 270000) },
].map(row => ({ ...row, default: row.id === 'gpt-6.1-sol', retired: false, priceTableId, perTokens })).concat([
  // Keep the original tariff for reservations made before the registry upgrade.
  { id: 'gpt-5-nano', short: rates(50, null, null, 400), long: rates(50, null, null, 400) },
  { id: 'gpt-5-mini', short: rates(250, null, null, 2000), long: rates(250, null, null, 2000) },
].map(row => ({ ...row, default: false, retired: true, priceTableId: 'openai-2026-10-02-eur95', perTokens })));
function priceFor(model: string, inputTokens: number, tariffId?: string) {
  const modelPrice = models.find(row => row.id === model);
  if (!modelPrice) throw new Error('Unknown model');
  if (tariffId !== undefined && tariffId !== modelPrice.priceTableId) throw new Error('Unknown model tariff');
  return inputTokens <= shortContextTokens ? modelPrice.short : modelPrice.long;
}
function roundedCents(numerator: bigint): number {
  const cents = Number((numerator + BigInt(perTokens) - 1n) / BigInt(perTokens));
  if (!Number.isSafeInteger(cents)) throw new Error('Cost overflow');
  return cents;
}
export function costCents(model: string, inputTokens: number, outputTokens: number, cachedInputTokens = 0, cacheWriteTokens = 0, tariffId?: string): number {
  if (![inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens].every(n => Number.isSafeInteger(n) && n >= 0) ||
      cachedInputTokens + cacheWriteTokens > inputTokens) throw new Error('Invalid usage');
  const price = priceFor(model, inputTokens, tariffId);
  if ((cachedInputTokens && price.cachedInputCents === null) || (cacheWriteTokens && price.cacheWriteCents === null)) throw new Error('Unsupported cache usage');
  return roundedCents(BigInt(inputTokens - cachedInputTokens - cacheWriteTokens) * BigInt(price.inputCents) +
    BigInt(cachedInputTokens) * BigInt(price.cachedInputCents ?? 0) + BigInt(cacheWriteTokens) * BigInt(price.cacheWriteCents ?? 0) +
    BigInt(outputTokens) * BigInt(price.outputCents));
}
// Callers without a measured input bound still reserve the full supported context.
export function reservationCents(model: string, outputBound: number, inputBound = MAX_CONTEXT_TOKENS): number {
  if (models.some(row => row.id === model && row.retired)) throw new Error('Retired model');
  if (![inputBound, outputBound].every(n => Number.isSafeInteger(n) && n >= 0) || outputBound === 0) throw new Error('Invalid bound');
  const price = priceFor(model, inputBound > shortContextTokens * LONG_CONTEXT_RESERVATION_MARGIN
    ? shortContextTokens + 1 : inputBound);
  return roundedCents(BigInt(inputBound) * BigInt(Math.max(price.inputCents, price.cacheWriteCents ?? 0)) +
    BigInt(outputBound) * BigInt(price.outputCents));
}
export class ModelRequestRefused extends Error {}
export function requestReservationCents(body: { model: string; max_output_tokens: number; n?: number | undefined; [key: string]: unknown }): number {
  if (body.n !== undefined && body.n !== 1) throw new ModelRequestRefused('Model request refused: n = 1 is required');
  // Bytes bound text tokenisation, but the provider also renders roles, boundaries and tools:
  // https://developers.openai.com/api/docs/guides/token-counting
  // Allow 2,048 tokens per request and 64 per JSON object: messages, content/input items,
  // function outputs and tool definitions. Count the wrapper and nested schema objects too.
  // This is generous planning headroom, not a provider guarantee; settlement alerts on overruns.
  let items = 0;
  const serialised = JSON.stringify(body, (_key, value: unknown) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) items++;
    return value;
  });
  const inputBound = Buffer.byteLength(serialised, 'utf8') + 2048 + 64 * items;
  if (inputBound + body.max_output_tokens * (body.n ?? 1) > MAX_CONTEXT_TOKENS) {
    throw new ModelRequestRefused('Model request refused: input and output bounds exceed the 1,050,000-token context');
  }
  return reservationCents(body.model, body.max_output_tokens * (body.n ?? 1), inputBound);
}
export function data(event: EventEnvelope): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(event.data);
}
const callSchema = z.object({ requestId: z.string().optional(), model: z.string(), priceTableId: z.string().min(1), computerId: z.string(),
  assistantId: z.string(), requesterId: z.string(), conversationId: z.string(), turnId: z.string(), threadId: z.string(), payingGroupId: z.string().optional(), contextDigest: z.string() }).strict();
export type ModelCall = z.infer<typeof callSchema>;
const reservationSchema = z.object({ id: z.string(), amountCents: z.int().nonnegative(), time: z.string(),
  call: callSchema, settledCents: z.int().nonnegative().optional(), outcomeUnknown: z.boolean().optional() });
const ceilingsSchema = z.array(z.object({ scope: z.enum(['paying_group', 'assistant']), scopeId: z.string(), ceilingCents: z.int().nonnegative() }));
const stateSchema = z.object({ dailyCeilingCents: z.int().nonnegative(), ceilingCents: z.int().nonnegative(),
  periodStart: z.string().optional(), defaultPayingGroupId: z.string().optional(), ceilings: ceilingsSchema.default([]), sequence: z.int().nonnegative().default(0),
  reservations: z.array(reservationSchema) });
export type BudgetState = z.infer<typeof stateSchema>;
export const emptyBudget = (): BudgetState => ({ dailyCeilingCents: 0, ceilingCents: 0, ceilings: [], sequence: 0, reservations: [] });
export function applyBudget(state: BudgetState, event: EventEnvelope, sequence = state.sequence): void {
  if (!event.type.startsWith('budget.')) return;
  state.sequence = sequence;
  const d = data(event);
  if (event.type === 'budget.ceiling_set') applyCeiling(state, d);
  else if (event.type === 'budget.period_started') state.periodStart = z.string().parse(d['periodStart']);
  else if (event.type === 'budget.reserved') {
    // Older calls did not repeat the group in modelCall; the envelope already bound it.
    state.reservations.push({ id: z.string().parse(d['reservationId']), time: event.time,
      amountCents: z.int().nonnegative().parse(d['amountCents']),
      call: callSchema.parse({ ...data({ ...event, data: d['modelCall'] }), payingGroupId: d['payingGroupId'] }) });
  } else if (event.type === 'budget.settled') {
    const reservation = state.reservations.find(r => r.id === d['reservationId']);
    if (!reservation) throw new Error('Unknown reservation');
    reservation.settledCents = Math.max(reservation.settledCents ?? 0, z.int().nonnegative().parse(d['settledCents']));
    reservation.outcomeUnknown = d['outcome'] === 'unknown';
  }
}
function applyCeiling(state: BudgetState, d: Record<string, unknown>) {
  const ceilingCents = z.int().nonnegative().parse(d['ceilingCents']);
  if (d['scope'] === 'global') {
    state.ceilingCents = ceilingCents;
    if (d['dailyCeilingCents'] !== undefined) state.dailyCeilingCents = z.int().nonnegative().parse(d['dailyCeilingCents']);
    if (d['defaultPayingGroupId'] !== undefined) state.defaultPayingGroupId = z.string().parse(d['defaultPayingGroupId']);
    return;
  }
  const scope = z.enum(['paying_group', 'assistant']).parse(d['scope']), scopeId = z.string().parse(d['scopeId']);
  state.ceilings = state.ceilings.filter(c => c.scope !== scope || c.scopeId !== scopeId);
  state.ceilings.push({ scope, scopeId, ceilingCents });
}
export function totals(state: BudgetState, now = new Date(), scope?: { scope: 'paying_group' | 'assistant'; scopeId: string }) {
  const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
  let today = 0n, monthly = 0n, reserved = 0n;
  for (const r of state.reservations) {
    if (scope && (scope.scope === 'paying_group' ? r.call.payingGroupId : r.call.assistantId) !== scope.scopeId) continue;
    // Unknown outcomes stay reserved until reconciliation proves the final charge.
    if (r.settledCents === undefined || r.outcomeUnknown) reserved += BigInt(r.amountCents);
    if (r.settledCents !== undefined) {
      if (r.time.startsWith(day)) today += BigInt(r.settledCents);
      if (r.time.startsWith(month)) monthly += BigInt(r.settledCents);
    }
  }
  const todayCents = safeTotal(today), monthCents = safeTotal(monthly), reservedCents = safeTotal(reserved);
  return { todayCents, monthCents, reservedCents, dailyCeilingCents: state.dailyCeilingCents,
    ceilingCents: scope ? state.ceilings.find(c => c.scope === scope.scope && c.scopeId === scope.scopeId)?.ceilingCents : state.ceilingCents };
}
function safeTotal(value: bigint) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Budget total overflow');
  return result;
}
export function budgetSummary(state: BudgetState, now = new Date()) {
  return { ...totals(state, now), sequence: state.sequence, defaultPayingGroupId: state.defaultPayingGroupId ?? null,
    periodStart: state.periodStart ?? null, ceilings: state.ceilings.map(c => ({ ...c, ...totals(state, now, c) })) };
}
export async function readBudget(db: Query, silo: string): Promise<BudgetState> {
  const result = await db.query<{ state: unknown }>('SELECT state FROM model_budgets WHERE silo = $1', [silo]);
  if (!result.rows[0]) throw new Error('Budget not initialised');
  return stateSchema.parse(result.rows[0].state);
}
// ponytail: one JSON row holds Phase 2 history; split reservations into rows when volume demands it.
function budgetProjection(name: string, table: string): Projection { return {
  name,
  async create(db) { await db.query(`CREATE TABLE IF NOT EXISTS ${table} (silo TEXT PRIMARY KEY, state JSONB NOT NULL)`); },
  async drop(db) { await db.query(`DROP TABLE IF EXISTS ${table}`); },
  async apply(db, event, position) {
    if (!event.type.startsWith('budget.')) return;
    if (!parseEventByType(event).success) throw new Error('Invalid budget event');
    const rows = await db.query<{ state: unknown }>(`SELECT state FROM ${table} WHERE silo = $1`, [event.silo]);
    const state = rows.rows[0] ? stateSchema.parse(rows.rows[0].state) : emptyBudget();
    applyBudget(state, event, position);
    await db.query(`INSERT INTO ${table} VALUES ($1, $2) ON CONFLICT (silo) DO UPDATE SET state = $2`, [event.silo, JSON.stringify(state)]);
  },
}; }
export const budgets = budgetProjection('model-budgets', 'model_budgets');
export const replayBudgets = budgetProjection('model-budgets-replay', 'model_budgets_replay');
