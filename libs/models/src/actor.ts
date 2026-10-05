import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { budgetCeilingSetDataSchema, effectResolvedDataSchema, effectUncertainDataSchema,
  effectObservedDataSchema, parseEventByType, providerDispatchedSchema,
  type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { applyBudget, costCents, data, emptyBudget, models, totals, type BudgetState, type ModelCall } from './state.ts';

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
};

// Keep a hold for three minutes so usage reports have time to arrive.
const SETTLE_TIMEOUT_MS = 180_000;

export async function history(store: EventStore, subject: string, silo: string, deadline = Infinity) {
  const rows = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    rows.push(row);
  }
  return rows;
}
export function envelope(silo: string, subject: string, type: string, payload: unknown, id: string = randomUUID(), now = new Date()): EventEnvelope {
  const parsed = parseEventByType({ id, commandId: id, type, subject, silo, data: payload,
    source: 'models', time: now.toISOString(), principal: { kind: 'system', id: 'models' } });
  if (!parsed.success) throw new Error('Invalid model event');
  return parsed.event;
}
export class BudgetRefused extends Error {}
/** Run with budget writers stopped or under the leadership lease; each migration appends once. */
export async function migrateBudgetDefault(store: EventStore, silo: string, defaultPayingGroupId: string) {
  z.string().min(1).parse(defaultPayingGroupId);
  const rows = await history(store, `budget-${silo}`, silo);
  if (!rows.length) return; // Fresh installations are seeded by the actor.
  const state = emptyBudget();
  for (const row of rows) applyBudget(state, row.event, row.sequence);
  if (state.defaultPayingGroupId) return;
  const event = envelope(silo, `budget-${silo}`, 'budget.ceiling_set', { scope: 'global',
    dailyCeilingCents: state.dailyCeilingCents, ceilingCents: state.ceilingCents,
    defaultPayingGroupId, setBy: 'installation' });
  const result = await store.append({ event, expectedSequence: rows.at(-1)!.sequence });
  if (result.status !== 'appended') throw new Error('Budget default migration append failed; retry with writers stopped');
}
export class BudgetActor {
  readonly state = emptyBudget();
  private sequence = 0;
  private queue = Promise.resolve();
  private failed = false;
  private readonly exhausted = new Set<string>();
  readonly store: EventStore;
  readonly silo: string;
  readonly now: () => Date;
  constructor(store: EventStore, silo: string, now = () => new Date()) { this.store = store; this.silo = silo; this.now = now; }
  // Call only after winning the process leadership lease. A new append fences the old leader.
  async start(dailyCeilingCents = 2000, ceilingCents = 20000, defaultPayingGroupId?: string) {
    if (defaultPayingGroupId) await migrateBudgetDefault(this.store, this.silo, defaultPayingGroupId);
    for (const row of await history(this.store, `budget-${this.silo}`, this.silo)) {
      this.sequence = row.sequence; this.apply(row.event);
    }
    if (!this.sequence) await this.append('budget.ceiling_set', { scope: 'global', dailyCeilingCents, ceilingCents, setBy: 'installation', ...(defaultPayingGroupId ? { defaultPayingGroupId } : {}) });
    await this.append('budget.period_started', { periodStart: this.monthStart() });
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.failed) throw new Error('Budget writer unavailable');
      return work();
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private async append(type: string, payload: unknown, id: string = randomUUID()) {
    const event = envelope(this.silo, `budget-${this.silo}`, type, payload, id, this.now());
    const result = await this.store.append({ event, expectedSequence: this.sequence });
    if (result.status !== 'appended') { this.failed = true; throw new Error('Budget writer lost its fence'); }
    this.sequence = result.sequence;
    this.apply(event);
  }
  private apply(event: EventEnvelope) {
    applyBudget(this.state, event, this.sequence);
    // Keep refusals across leadership changes; a ceiling change permits a fresh notice.
    if (event.type === 'budget.ceiling_set') this.exhausted.clear();
    if (event.type === 'budget.exhausted') {
      const d = data(event);
      this.exhausted.add(`${event.time.slice(0, 10)}:${String(d['scope'])}:${z.string().optional().parse(d['scopeId']) ?? ''}`);
    }
  }
  configure(raw: unknown, commandId: string = randomUUID(), expectedSequence?: number, fresh?: () => Promise<void>) {
    return this.serial(async () => {
      const payload = budgetCeilingSetDataSchema.parse(raw);
      const prior = (await history(this.store, `budget-${this.silo}`, this.silo)).find(r => r.event.commandId === commandId);
      if (prior) return { status: JSON.stringify(prior.event.data) === JSON.stringify(payload) ? 'appended' : 'conflict' };
      if (expectedSequence !== undefined && expectedSequence !== this.sequence) return { status: 'conflict' };
      await fresh?.();
      await this.append('budget.ceiling_set', payload, commandId);
      return { status: 'appended' };
    });
  }
  reserve(call: ModelCall, amountCents: number, fresh?: () => Promise<void>) {
    return this.serial(async () => {
      z.int().positive().parse(amountCents);
      if (!models.some(row => row.id === call.model && row.priceTableId === call.priceTableId && !row.retired)) throw new Error('Unknown model tariff');
      if (!call.payingGroupId) throw new Error('Paying group unavailable');
      const applicable = [{ scope: 'global' as const, scopeId: '', ...totals(this.state, this.now()) },
        ...this.state.ceilings.filter(c => (c.scope === 'paying_group' ? call.payingGroupId : call.assistantId) === c.scopeId)
          .map(c => ({ ...c, ...totals(this.state, this.now(), c) }))];
      // Compare cents as integers and include unsettled reservations to prevent concurrent overspend.
      const exceeded = applicable.find(t =>
        (t.scope === 'global' && BigInt(t.todayCents) + BigInt(t.reservedCents) + BigInt(amountCents) > BigInt(t.dailyCeilingCents)) ||
        BigInt(t.monthCents) + BigInt(t.reservedCents) + BigInt(amountCents) > BigInt(t.ceilingCents!));
      if (exceeded) {
        const key = `${this.now().toISOString().slice(0, 10)}:${exceeded.scope}:${exceeded.scopeId}`;
        if (!this.exhausted.has(key)) await this.append('budget.exhausted', { scope: exceeded.scope,
          ...(exceeded.scope === 'global' ? {} : { scopeId: exceeded.scopeId }) });
        const label = exceeded.scope === 'global' ? 'Silo' : exceeded.scope === 'paying_group' ? 'Paying group' : 'Assistant';
        throw new BudgetRefused(`${label} spending cap reached; ask an Owner or Admin or wait for the next UTC budget period`);
      }
      await fresh?.();
      const id = randomUUID();
      await this.append('budget.reserved', { reservationId: id, permitId: id, amountCents,
        payingGroupId: call.payingGroupId, assistantId: call.assistantId, modelCall: call });
      return id;
    });
  }
  requireOpenReservation(reservationId: string, fresh: () => Promise<void>) {
    const state = this.state;
    function matchesReservation(reservation: BudgetState['reservations'][number]) {
      return reservation.id === reservationId;
    }
    async function checkReservation() {
      const reservation = state.reservations.find(matchesReservation);
      if (!reservation || reservation.settledCents !== undefined) {
        throw new Error('Reservation is no longer open');
      }
      // Recheck access after waiting in the queue, within the original time limit.
      await fresh();
    }
    return this.serial(checkReservation);
  }
  releaseUndispatched(id: string) {
    return this.serial(async () => {
      const r = this.state.reservations.find(r => r.id === id);
      if (!r) throw new Error('Unmatched reservation');
      if (r.settledCents !== undefined) throw new Error('Reservation already settled');
      // Call only with proof that the permit was not used for provider dispatch.
      await this.appendNotDispatched(id);
    });
  }
  settle(event: EventEnvelope) {
    return this.serial(async () => {
      if (event.silo !== this.silo) throw new Error('Wrong effect');
      if (event.type === 'effect.resolved') return this.settleResolution(event);
      if (event.type !== 'effect.observed') throw new Error('Wrong effect');
      const d = effectObservedDataSchema.parse(event.data);
      const r = this.state.reservations.find(r => r.id === d.permitId);
      const validCost = d.usage ? r && d.usage.priceTableId === r.call.priceTableId &&
        models.some(row => row.id === d.tool && row.priceTableId === r.call.priceTableId) &&
        d.costCents === costCents(d.tool, d.usage.inputTokens, d.usage.outputTokens, d.usage.cachedInputTokens, d.usage.cacheWriteTokens, r.call.priceTableId) : d.outcome === 'error' && d.costCents === 0;
      if (!r || !validCost || d.computerId !== r.call.computerId || d.tool !== r.call.model || !(await this.permitted(d.permitId, r.call.requestId))) {
        await this.alert(d.permitId); return;
      }
      await this.settleCharge(r, d.costCents);
    });
  }
  private async settleResolution(event: EventEnvelope) {
    const d = effectResolvedDataSchema.parse(event.data);
    const r = this.state.reservations.find(r => r.id === d.reservationId && r.id === d.permitId);
    if (!r || event.principal?.kind !== 'human' || event.principal.id !== d.resolvedBy) throw new Error('Invalid resolution');
    await this.settleCharge(r, d.settledCents, d.outcome === 'released');
  }
  private async settleCharge(r: BudgetState['reservations'][number], cents: number, released = false) {
    const rows = await history(this.store, `effect-${r.id}`, this.silo);
    const amounts = rows.flatMap(({ event }) => {
      if (event.type === 'effect.observed') return [effectObservedDataSchema.parse(event.data).costCents];
      if (event.type === 'effect.resolved') return [effectResolvedDataSchema.parse(event.data).settledCents];
      return [];
    });
    const conflict = Boolean(r.outcomeUnknown) || amounts.some(amount => amount !== cents) ||
      (r.settledCents !== undefined && r.settledCents !== cents);
    const amount = Math.max(r.settledCents ?? 0, cents, ...amounts);
    if (r.settledCents !== amount || Boolean(r.outcomeUnknown) !== conflict) {
      await this.append('budget.settled', { reservationId: r.id, permitId: r.id, settledCents: amount,
        ...(conflict ? { outcome: 'unknown' } : released ? { outcome: 'not_dispatched' } : {}) });
    }
    // Retry the alert even after settlement, so an alert outage cannot lose the notice.
    await this.alert(r.id, { model: r.call.model, reservedCents: r.amountCents, settledCents: amount });
  }

  uncertain(id: string, reason: z.infer<typeof effectUncertainDataSchema>['reason']) {
    return this.serial(() => this.recordEffect(id, undefined, 'success', reason));
  }
  effect(id: string, usage?: ModelUsage, outcome: 'success' | 'error' = 'success') {
    return this.serial(() => this.recordEffect(id, usage, outcome));
  }
  private async recordEffect(id: string, usage?: ModelUsage,
    outcome: 'success' | 'error' = 'success', reason = 'settle_timeout') {
    function matchesReservation(reservation: BudgetState['reservations'][number]) {
      return reservation.id === id;
    }
    const reservation = this.state.reservations.find(matchesReservation);
    if (!reservation || !(await this.permitted(id, reservation.call.requestId))) {
      await this.alert(id);
      return;
    }
    await this.recordEffectEvidence(reservation, usage, outcome, reason);
  }
  private async recordEffectEvidence(reservation: BudgetState['reservations'][number],
    usage: ModelUsage | undefined, outcome: 'success' | 'error', reason: string) {
    function matchesTariff(model: (typeof models)[number]) {
      return model.id === reservation.call.model &&
        model.priceTableId === reservation.call.priceTableId;
    }
    const knownTariff = models.some(matchesTariff);
    const id = reservation.id;
    const observed = observedPayload(reservation, usage, outcome);
    const type = observed ? 'effect.observed' : 'effect.uncertain';
    const rows = await history(this.store, `effect-${id}`, this.silo);
    if (redundantTimeout(type, reason, rows)) return;
    const uncertainty = {
      permitId: id, computerId: reservation.call.computerId,
      reason: knownTariff && !usage ? reason : 'unknown_tariff',
    };
    const payload = observed ? effectObservedDataSchema.parse(observed) :
      effectUncertainDataSchema.parse(uncertainty);
    const payloadText = JSON.stringify(payload);
    function matchesPayload(row: (typeof rows)[number]) {
      return row.event.type === type && JSON.stringify(row.event.data) === payloadText;
    }
    function matchesType(row: (typeof rows)[number]) {
      return row.event.type === type;
    }
    if (rows.some(matchesPayload)) {
      return;
    }
    let suffix = '';
    if (rows.some(matchesType)) {
      const hash = createHash('sha256');
      hash.update(payloadText);
      suffix = `:${hash.digest('hex')}`;
    }
    const eventId = `${id}:${type}${suffix}`;
    const event = envelope(this.silo, `effect-${id}`, type, payload, eventId);
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0 };
    const result = await this.store.append(command);
    if (result.status !== 'appended') {
      throw new Error('Effect append failed');
    }
  }
  private async permitted(permitId: string, requestId?: string) {
    if (!requestId) return true; // Reservations before P3-19 did not carry the request id.
    return (await history(this.store, `decision-${requestId}`, this.silo)).some(row => {
      const d = data(row.event);
      return row.event.type === 'decision.recorded' && d['outcome'] === 'allow' && d['permitId'] === permitId;
    });
  }
  private async alert(permitId: string, overrun?: { model: string; reservedCents: number; settledCents: number }) {
    if (overrun && overrun.settledCents <= overrun.reservedCents) return;
    const subject = `security-${permitId}`, id = `${permitId}:${overrun ? 'overrun' : 'unmatched'}`;
    const rows = await history(this.store, subject, this.silo);
    if (rows.some(row => row.event.id === id)) return;
    const event = { ...envelope(this.silo, subject, 'security.alert_raised', {
      alertId: id, severity: 'high', reason: overrun ? 'budget_reservation_exceeded' : 'effect_without_permit',
      ...(overrun ? { overrun } : {}),
    }, id), correlation: { permit: permitId } };
    const result = await this.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
    if (result.status !== 'appended') throw new Error('Security alert unavailable');
  }
  private monthStart() { return `${this.now().toISOString().slice(0, 7)}-01T00:00:00.000Z`; }
  period() {
    return this.serial(async () => {
      if (this.state.periodStart !== this.monthStart()) await this.append('budget.period_started', { periodStart: this.monthStart() });
    });
  }
  async expire() {
    for (const reservation of this.state.reservations) {
      if (reservation.settledCents === undefined &&
          this.now().getTime() - Date.parse(reservation.time) > SETTLE_TIMEOUT_MS) {
        const expireReservation = this.expireReservation.bind(this, reservation);
        await this.serial(expireReservation);
      }
    }
  }
  private async expireReservation(reservation: BudgetState['reservations'][number]) {
    if (reservation.settledCents !== undefined) {
      return;
    }
    const allowed = await this.permitted(reservation.id, reservation.call.requestId);
    if (allowed) {
      await this.recordEffectEvidence(reservation, undefined, 'success', 'settle_timeout');
      return;
    }
    const dispatched = await this.providerDispatched(reservation);
    const hasEvidence = await this.hasCallEvidence(reservation.id);
    if (!dispatched && !hasEvidence) {
      // Release only when no allow decision or evidence of a call exists.
      // Keep the hold if a read fails, then try again at the next expiry check.
      await this.appendNotDispatched(reservation.id);
      return;
    }
    if (dispatched) {
      await this.alert(reservation.id);
    }
    await this.recordEffectEvidence(reservation, undefined, 'success', 'settle_timeout');
  }
  private async appendNotDispatched(reservationId: string) {
    const payload = {
      reservationId, permitId: reservationId, settledCents: 0, outcome: 'not_dispatched',
    };
    await this.append('budget.settled', payload);
  }
  private async hasCallEvidence(reservationId: string) {
    const effects = await history(this.store, `effect-${reservationId}`, this.silo);
    const security = await history(this.store, `security-${reservationId}`, this.silo);
    return effects.length > 0 || security.length > 0;
  }
  private async providerDispatched(reservation: BudgetState['reservations'][number]) {
    if (reservation.call.assistantId !== 'provider-verification') {
      return false;
    }
    // Use the provider stream stored as computerId for provider checks.
    const rows = await history(this.store, reservation.call.computerId, this.silo);
    function matchesDispatch(row: (typeof rows)[number]) {
      if (row.event.type !== 'provider.verification_dispatched') {
        return false;
      }
      const dispatch = providerDispatchedSchema.parse(row.event.data);
      return dispatch.reservationId === reservation.id;
    }
    return rows.some(matchesDispatch);
  }
  async computerLostRecorded(subject: string, eventId: string) {
    if (!/^computer-[\w-]+$/u.test(subject)) throw new Error('Wrong computer stream');
    const event = (await history(this.store, subject, this.silo)).find(r => r.event.id === eventId)?.event;
    if (event?.type !== 'computer.lost') throw new Error('Computer loss not recorded');
    const computerId = z.string().parse(data(event)['computerId']);
    return this.serial(async () => {
      for (const r of this.state.reservations.filter(r => r.call.computerId === computerId && r.settledCents === undefined)) {
        await this.recordEffect(r.id, undefined, 'success', 'computer_lost');
      }
    });
  }
  async settleRecorded(id: string, eventId: string) {
    const row = (await history(this.store, `effect-${id}`, this.silo)).find(row => row.event.id === eventId);
    if (!row) throw new Error('Effect not recorded');
    await this.settle(row.event);
  }
}
export function settlementHandler(decisionUrl: string) {
  return registerHandler('settle-budget', async event => {
    const d = data(event);
    const lost = event.type === 'computer.lost';
    const response = await fetch(`${decisionUrl}/${lost ? 'computer-lost' : 'settle'}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lost ? { subject: event.subject, eventId: event.id } : { permitId: d['permitId'], eventId: event.id }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Budget settlement unavailable');
  });
}

function observedPayload(r: BudgetState['reservations'][number], usage: { inputTokens: number; outputTokens: number;
  cachedInputTokens?: number | undefined; cacheWriteTokens?: number | undefined } | undefined, outcome: 'success' | 'error') {
  if (!models.some(row => row.id === r.call.model && row.priceTableId === r.call.priceTableId)) return undefined;
  if (!usage && outcome !== 'error') return undefined;
  try {
    return { permitId: r.id, computerId: r.call.computerId, tool: r.call.model, destination: 'openai', outcome,
      costCents: usage ? costCents(r.call.model, usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteTokens, r.call.priceTableId) : 0,
      ...(usage ? { usage: { ...usage, priceTableId: r.call.priceTableId } } : {}) };
  } catch { return undefined; }
}

function redundantTimeout(type: string, reason: string, rows: Awaited<ReturnType<typeof history>>) {
  return type === 'effect.uncertain' && reason === 'settle_timeout' && rows.some(row => row.event.type === type);
}
