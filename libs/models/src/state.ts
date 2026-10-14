import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { parseEventByType, budgetExhaustedDataSchema, budgetStopReasonSchema,
  budgetCallDispatchAdmittedDataSchema, budgetRootAllowanceSetDataSchema,
  budgetRootStoppedDataSchema,
  optionalProviderTurnBindingSchema, type EventEnvelope } from '@opencrane/events';
import type { Projection, Query } from '@opencrane/projections';

// Pinned standard USD prices, 2 October 2026, at the existing EUR 95/100 planning FX.
// Integer euro cents per billion tokens retain the $0.125 cache-write rate exactly.
export const priceTableId = 'openai-2026-10-02-all-eur95';
export const shortContextTokens = 272_000;
// This is the context ceiling: larger requests are refused, and unmeasured
// reservations reserve the full ceiling.
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
export function data(event: Pick<EventEnvelope, 'data'>): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(event.data);
}
const callSchema = optionalProviderTurnBindingSchema.safeExtend({
  requestId: z.string().optional(), model: z.string(), priceTableId: z.string().min(1),
  computerId: z.string(), assistantId: z.string(), requesterId: z.string(),
  generation: z.int().nonnegative().optional(),
  conversationId: z.string(), turnId: z.string(), threadId: z.string(),
  payingGroupId: z.string().optional(), contextDigest: z.string(),
});
export type ModelCall = z.infer<typeof callSchema>;
const reservationSchema = z.object({ id: z.string(), amountCents: z.int().nonnegative(), time: z.string(),
  rootId: z.string().optional(), call: callSchema, dispatchGate: z.literal(1).optional(),
  expired: z.literal(true).optional(),
  settledCents: z.int().nonnegative().optional(), outcomeUnknown: z.boolean().optional() });
const ceilingsSchema = z.array(z.object({ scope: z.enum(['paying_group', 'assistant']), scopeId: z.string(), ceilingCents: z.int().nonnegative() }));
const stopSchema = z.object({ id: z.string(), position: z.int().nonnegative(),
  reasons: z.array(budgetStopReasonSchema) });
const stoppedWorkSchema = z.object({ conversationId: z.string(), turnId: z.string(),
  stopId: z.string() });
const rootSchema = budgetRootAllowanceSetDataSchema.extend({
  position: z.int().nonnegative(), stop: budgetRootStoppedDataSchema.optional(),
});
const stateSchema = z.object({ dailyCeilingCents: z.int().nonnegative(), ceilingCents: z.int().nonnegative(),
  periodStart: z.string().optional(), defaultPayingGroupId: z.string().optional(), ceilings: ceilingsSchema.default([]), sequence: z.int().nonnegative().default(0),
  roots: z.array(rootSchema).default([]), reservations: z.array(reservationSchema), limits: z.array(budgetStopReasonSchema).default([]),
  dispatches: z.array(budgetCallDispatchAdmittedDataSchema).default([]),
  stops: z.array(stopSchema).default([]), stoppedWork: z.array(stoppedWorkSchema).default([]) });
export type BudgetState = z.infer<typeof stateSchema>;
export function requireDispatchReservation(state: BudgetState,
  input: z.infer<typeof budgetCallDispatchAdmittedDataSchema>) {
  if (input.reservationId === undefined) {
    // Keep non-metered sends in the same queue so saved spending stops still refuse them.
    const kind = input.modelCall.model;
    if (kind !== 'provider-reachability' && kind !== 'computer-egress' && kind !== 'mcp-zero-cost') {
      throw new Error('Paid calls need a reservation');
    }
    return;
  }
  function matchesReservation(saved: BudgetState['reservations'][number]) {
    return saved.id === input.reservationId;
  }
  const reservation = state.reservations.find(matchesReservation);
  if (!reservation || reservation.settledCents !== undefined || reservation.expired) {
    throw new Error('Reservation is no longer open');
  }
  if (!isDeepStrictEqual(reservation.call, input.modelCall) ||
      (reservation.call.requestId !== undefined && reservation.call.requestId !== input.callId)) {
    throw new Error('Reservation binding changed');
  }
}
export const emptyBudget = (): BudgetState => ({ dailyCeilingCents: 0, ceilingCents: 0, ceilings: [], sequence: 0, roots: [], reservations: [], dispatches: [], limits: [], stops: [], stoppedWork: [] });
export function applyBudget(state: BudgetState, event: EventEnvelope, sequence = state.sequence): void {
  if (!event.type.startsWith('budget.')) return;
  state.sequence = sequence;
  const d = data(event);
  applyRoot(state, event, sequence);
  if (event.type === 'budget.ceiling_set') {
    applyStopConfiguration(state, event);
    applyCeiling(state, d);
  } else if (event.type === 'budget.exhausted') applyExhaustion(state, event);
  else if (event.type === 'budget.period_started') state.periodStart = z.string().parse(d['periodStart']);
  else if (event.type === 'budget.reserved') {
    // Older calls did not repeat the group in modelCall; the envelope already bound it.
    state.reservations.push({ id: z.string().parse(d['reservationId']), time: event.time,
      amountCents: z.int().nonnegative().parse(d['amountCents']),
      dispatchGate: z.literal(1).optional().parse(d['dispatchGate']),
      rootId: z.string().optional().parse(d['rootId']),
      call: callSchema.parse({ ...data({ ...event, data: d['modelCall'] }), payingGroupId: d['payingGroupId'] }) });
  } else if (event.type === 'budget.reservation_expired') {
    function matchesReservation(reservation: BudgetState['reservations'][number]) {
      return reservation.id === d['reservationId'];
    }
    const reservation = state.reservations.find(matchesReservation);
    if (!reservation) {
      throw new Error('Unknown reservation');
    }
    // Keep the hold and later settlement separate from permission to send this call.
    reservation.expired = true;
  } else if (event.type === 'budget.call_dispatch_admitted') {
    state.dispatches.push(budgetCallDispatchAdmittedDataSchema.parse(event.data));
  } else if (event.type === 'budget.settled') {
    const reservation = state.reservations.find(r => r.id === d['reservationId']);
    if (!reservation) throw new Error('Unknown reservation');
    reservation.settledCents = Math.max(reservation.settledCents ?? 0, z.int().nonnegative().parse(d['settledCents']));
    reservation.outcomeUnknown = d['outcome'] === 'unknown';
  }
}
function applyRoot(state: BudgetState, event: EventEnvelope, sequence: number) {
  if (event.type === 'budget.root_allowance_set') {
    const allowance = budgetRootAllowanceSetDataSchema.parse(event.data);
    const root = { ...allowance, position: sequence };
    state.roots.push(root);
  } else if (event.type === 'budget.root_stopped') {
    const stop = budgetRootStoppedDataSchema.parse(event.data);
    function matches(root: BudgetState['roots'][number]) {
      return root.rootId === stop.rootId;
    }
    const root = state.roots.find(matches);
    if (!root) throw new Error('Unknown root');
    root.stop ??= stop;
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
    // Unsettled calls stay reserved. Conflicting evidence keeps the full hold permanently.
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
  function ceilingSummary(ceiling: BudgetState['ceilings'][number]) {
    return { ...ceiling, ...totals(state, now, ceiling) };
  }
  const ceilings = state.ceilings.map(ceilingSummary);
  return { ...totals(state, now), stops: state.stops, stoppedWork: state.stoppedWork,
    sequence: state.sequence, defaultPayingGroupId: state.defaultPayingGroupId ?? null,
    periodStart: state.periodStart ?? null, ceilings };
}
type StopReason = z.infer<typeof budgetStopReasonSchema>;
function matchesScope(reason: StopReason, call: Pick<ModelCall, 'payingGroupId' | 'assistantId'>) {
  if (reason.scope === 'global') {
    return true;
  }
  if (reason.scope === 'paying_group') {
    return reason.scopeId === call.payingGroupId;
  }
  return reason.scopeId === call.assistantId;
}
function capMessage(reason: StopReason): string {
  if (reason.scope === 'global') {
    return `Silo spending cap reached (${reason.kind})`;
  }
  if (reason.scope === 'paying_group') {
    return 'Paying group spending cap reached';
  }
  return 'Assistant spending cap reached';
}
export function budgetStopMessage(state: BudgetState, call: ModelCall, stopId: string): string {
  function matchesStop(stop: BudgetState['stops'][number]) {
    return stop.id === stopId;
  }
  const stop = state.stops.find(matchesStop);
  if (!stop) {
    throw new Error('Unknown budget stop');
  }
  const messages: string[] = [];
  // Keep the saved cause after recovery, but omit caps belonging to other work.
  for (const reason of stop.reasons) {
    if (matchesScope(reason, call)) {
      messages.push(capMessage(reason));
    }
  }
  return messages.join('; ') +
    '; ask an Owner or Admin or wait for the next UTC budget period';
}
function sameLimit(left: StopReason, right: StopReason) {
  if (left.scope !== right.scope || left.kind !== right.kind) {
    return false;
  }
  if (left.scope === 'global' || right.scope === 'global') {
    return true;
  }
  return left.scopeId === right.scopeId;
}
function periodDates(kind: StopReason['kind'], now: Date) {
  const reset = new Date(now);
  let periodStart: string;
  if (kind === 'daily') {
    periodStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    reset.setUTCDate(reset.getUTCDate() + 1);
  } else {
    periodStart = `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
    reset.setUTCDate(1);
    reset.setUTCMonth(reset.getUTCMonth() + 1);
  }
  reset.setUTCHours(0, 0, 0, 0);
  return { periodStart, resetAt: reset.toISOString() };
}
function reasonTotals(state: BudgetState, limit: StopReason, now: Date,
  attemptedBoundCents = 0): StopReason {
  const scope = limit.scope === 'global' ? undefined : limit;
  const usage = totals(state, now, scope);
  const settledCents = limit.kind === 'daily' ? usage.todayCents : usage.monthCents;
  return { ...limit, ...periodDates(limit.kind, now), settledCents,
    reservedCents: usage.reservedCents, attemptedBoundCents };
}
function stopWork(state: BudgetState, work: Pick<ModelCall, 'conversationId' | 'turnId'>,
  stopId: string) {
  function matchesWork(saved: BudgetState['stoppedWork'][number]) {
    return saved.conversationId === work.conversationId && saved.turnId === work.turnId;
  }
  if (!state.stoppedWork.some(matchesWork)) {
    state.stoppedWork.push({ conversationId: work.conversationId, turnId: work.turnId, stopId });
  }
}
function recordStop(state: BudgetState, event: EventEnvelope, reasons: StopReason[]) {
  state.stops.push({ id: event.id, position: state.sequence, reasons });
  for (const reservation of state.reservations) {
    for (const reason of reasons) {
      if (matchesScope(reason, reservation.call)) {
        stopWork(state, reservation.call, event.id);
        break;
      }
    }
  }
}
function applyStopConfiguration(state: BudgetState, event: EventEnvelope) {
  const payload = data(event);
  const now = new Date(event.time);
  const reasons: StopReason[] = [];
  const kinds = payload['scope'] === 'global' ? ['monthly', 'daily'] as const : ['monthly'] as const;
  for (const kind of kinds) {
    let value = payload[kind === 'daily' ? 'dailyCeilingCents' : 'ceilingCents'];
    if (value === undefined) {
      function isDaily(limit: StopReason) {
        return limit.scope === 'global' && limit.kind === 'daily';
      }
      if (state.limits.some(isDaily)) {
        continue;
      }
      // Keep the original zero daily limit when older initial settings omit it.
      value = state.dailyCeilingCents;
    }
    const candidateData = { scope: payload['scope'],
      ...(payload['scopeId'] === undefined ? {} : { scopeId: payload['scopeId'] }),
      kind, reason: 'bound_refused', ...periodDates(kind, now), ceilingCents: value,
      settledCents: 0, reservedCents: 0, attemptedBoundCents: 0, configurationId: event.id };
    const candidate = budgetStopReasonSchema.parse(candidateData);
    function isLimit(limit: StopReason) {
      return sameLimit(limit, candidate);
    }
    const prior = state.limits.find(isLimit);
    // Keep an unchanged ceiling's reference so another edit cannot act as Resume.
    if (prior?.ceilingCents === candidate.ceilingCents) {
      continue;
    }
    function otherLimit(limit: StopReason) {
      return !isLimit(limit);
    }
    state.limits = state.limits.filter(otherLimit);
    state.limits.push(candidate);
    const reason = reasonTotals(state, candidate, now);
    const capacity = BigInt(reason.settledCents) + BigInt(reason.reservedCents);
    // Treat a first scoped ceiling as a reduction from having no limit.
    const lowered = prior === undefined || candidate.ceilingCents < prior.ceilingCents;
    if (candidate.ceilingCents === 0 || (lowered && capacity >= BigInt(candidate.ceilingCents))) {
      reason.reason = candidate.ceilingCents === 0 ? 'zero_ceiling' : 'ceiling_lowered';
      reasons.push(reason);
    }
  }
  if (reasons.length) {
    recordStop(state, event, reasons);
  }
}
function applyExhaustion(state: BudgetState, event: EventEnvelope) {
  const payload = budgetExhaustedDataSchema.parse(event.data);
  if ('stopId' in payload) {
    const stopId = payload.stopId;
    function matchesStop(stop: BudgetState['stops'][number]) {
      return stop.id === stopId;
    }
    if (!state.stops.some(matchesStop)) {
      throw new Error('Unknown budget stop');
    }
    stopWork(state, payload.work, stopId);
    return;
  }
  let reasons: StopReason[];
  if ('reasons' in payload) {
    reasons = payload.reasons;
  } else {
    reasons = [];
    for (const limit of state.limits) {
      if (limit.scope !== payload.scope) {
        continue;
      }
      if (limit.scope !== 'global' && 'scopeId' in payload && limit.scopeId !== payload.scopeId) {
        continue;
      }
      const reason = reasonTotals(state, limit, new Date(event.time));
      reason.reason = 'legacy_exhaustion';
      reasons.push(reason);
    }
  }
  recordStop(state, event, reasons);
  if ('work' in payload && payload.work) {
    stopWork(state, payload.work, event.id);
  }
}
type BudgetWork = Pick<ModelCall, 'conversationId' | 'turnId' | 'assistantId' | 'payingGroupId'>;
export function budgetStopId(state: BudgetState, call: BudgetWork, now: Date,
  admittedAt?: number): string | undefined {
  for (const work of state.stoppedWork) {
    if (work.conversationId === call.conversationId && work.turnId === call.turnId) {
      return work.stopId;
    }
  }
  // Keep zero ceilings binding after their first period resets.
  for (const limit of state.limits) {
    if (matchesScope(limit, call) && limit.ceilingCents === 0) {
      return limit.configurationId;
    }
  }
  return scopeStopId(state, call, now, admittedAt);
}
function scopeStopId(state: BudgetState, call: BudgetWork, now: Date, admittedAt?: number) {
  for (const stop of state.stops) {
    for (const reason of stop.reasons) {
      if (!matchesScope(reason, call)) continue;
      // Keep a saved turn stopped even after its limit recovers, without a money hold.
      if (admittedAt !== undefined && stop.position > admittedAt) return stop.id;
      if (now.toISOString() >= reason.resetAt) {
        continue;
      }
      for (const limit of state.limits) {
        if (sameLimit(limit, reason) && limit.configurationId === reason.configurationId) {
          return stop.id;
        }
      }
    }
  }
  return undefined;
}
export function exceededReasons(state: BudgetState, call: BudgetWork, now: Date,
  attemptedBoundCents: number): StopReason[] {
  const reasons: StopReason[] = [];
  for (const limit of state.limits) {
    if (!matchesScope(limit, call)) {
      continue;
    }
    const reason = reasonTotals(state, limit, now, attemptedBoundCents);
    const capacity = BigInt(reason.settledCents) + BigInt(reason.reservedCents);
    if (capacity + BigInt(attemptedBoundCents) > BigInt(reason.ceilingCents)) {
      reasons.push(reason);
    }
  }
  return reasons;
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


export function observedPayload(reservation: BudgetState['reservations'][number],
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number | undefined;
    cacheWriteTokens?: number | undefined } | undefined, outcome: 'success' | 'error') {
  function matchesTariff(model: typeof models[number]) {
    return model.id === reservation.call.model && model.priceTableId === reservation.call.priceTableId;
  }
  if (!models.some(matchesTariff)) return undefined;
  if (!usage && outcome !== 'error') return undefined;
  try {
    let amountCents = 0;
    if (usage) {
      amountCents = costCents(reservation.call.model, usage.inputTokens, usage.outputTokens,
        usage.cachedInputTokens, usage.cacheWriteTokens, reservation.call.priceTableId);
    }
    return { permitId: reservation.id, computerId: reservation.call.computerId,
      tool: reservation.call.model, destination: 'openai', outcome, costCents: amountCents,
      ...(usage ? { usage: { ...usage, priceTableId: reservation.call.priceTableId } } : {}) };
  } catch {
    return undefined;
  }
}
