import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { budgetCeilingSetDataSchema, budgetCallDispatchAdmittedDataSchema,
  effectResolvedDataSchema, effectUncertainDataSchema,
  effectObservedDataSchema, parseEventByType, providerDispatchedSchema,
  type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { applyBudget, costCents, data, emptyBudget, models, budgetStopId, budgetStopMessage,
  exceededReasons, requireDispatchReservation, type BudgetState, type ModelCall } from './state.ts';

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
};

// Keep a hold for three minutes so usage reports have time to arrive.
const SETTLE_TIMEOUT_MS = 180_000;

export async function history(store: Pick<EventStore, 'readStream'>,
  subject: string, silo: string, deadline = Infinity) {
  const rows = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Wrong silo');
    rows.push(row);
  }
  if (subject.startsWith('conversation-')) {
    const conversationId = subject.slice('conversation-'.length);
    for await (const row of store.readStream(`participation-${conversationId}`, 1, deadline)) {
      if (row.event.silo !== silo) throw new Error('Wrong silo');
      if (row.event.type === 'conversation.closed') rows.push(row);
    }
    rows.sort(compareEventPosition);
  }
  return rows;
}
function compareEventPosition(first: StoredEvent, second: StoredEvent) {
  return first.sequence - second.sequence;
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
  private reservationsStopped = false;
  private readonly timedOut = new Set<string>();
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
  private async append(type: string, payload: unknown, id: string = randomUUID(),
    confirmAccess?: () => Promise<void>) {
    this.requireReservationWrites(type);
    const event = envelope(this.silo, `budget-${this.silo}`, type, payload, id, this.now());
    // Reuse replayed history; configure checks its caller's command id before this append.
    const command = { event, expectedSequence: this.sequence, historyChecked: true as const };
    let result = await this.store.append(command);
    if (result.status === 'conflict' && await this.advancePastSwitchOn()) {
      this.requireReservationWrites(type);
      // Keep the caller's original access deadline when a spending-limit write retries.
      await confirmAccess?.();
      // Retry this saved hold's progress once, using the position after switch-on.
      command.expectedSequence = this.sequence;
      result = await this.store.append(command);
    }
    if (result.status !== 'appended') {
      this.failed = true;
      throw new Error('Budget writer lost its fence');
    }
    this.sequence = result.sequence;
    this.apply(event);
  }
  private requireReservationWrites(type: string) {
    if (type === 'budget.reserved' && this.reservationsStopped) {
      throw new Error('Provider setup changed');
    }
  }
  private async advancePastSwitchOn() {
    const subject = `budget-${this.silo}`;
    let position = this.sequence;
    for await (const row of this.store.readStream(subject, this.sequence + 1)) {
      // Refuse another budget writer's changes. Only switch-on leaves money untouched.
      if (row.event.silo !== this.silo || row.event.subject !== subject ||
          row.event.type !== 'provider.managed_calls_enabled') {
        return false;
      }
      position = row.sequence;
    }
    if (position === this.sequence) {
      return false;
    }
    this.sequence = position;
    this.reservationsStopped = true;
    return true;
  }
  private apply(event: EventEnvelope) {
    if (event.type === 'provider.managed_calls_enabled') {
      this.reservationsStopped = true;
    }
    applyBudget(this.state, event, this.sequence);
  }

  configure(raw: unknown, commandId: string = randomUUID(), expectedSequence?: number, fresh?: () => Promise<void>) {
    return this.serial(async () => {
      const payload = budgetCeilingSetDataSchema.parse(raw);
      const prior = (await history(this.store, `budget-${this.silo}`, this.silo)).find(r => r.event.commandId === commandId);
      if (prior) return { status: JSON.stringify(prior.event.data) === JSON.stringify(payload) ? 'appended' : 'conflict' };
      // Compare the client's revision with budget events; switch-on only moves the writer.
      if (expectedSequence !== undefined && expectedSequence !== this.state.sequence) {
        return { status: 'conflict' };
      }
      await fresh?.();
      await this.append('budget.ceiling_set', payload, commandId, fresh);
      return { status: 'appended' };
    });
  }
  reserve(call: ModelCall, amountCents: number, fresh?: () => Promise<void>) {
    return this.serial(async () => {
      z.int().positive().parse(amountCents);
      if (!models.some(row => row.id === call.model && row.priceTableId === call.priceTableId && !row.retired)) throw new Error('Unknown model tariff');
      if (!call.payingGroupId) throw new Error('Paying group unavailable');
      const stopId = budgetStopId(this.state, call, this.now());
      if (stopId !== undefined) {
        await this.recordRefusedWork(call, stopId, fresh);
        this.requireBudget(call);
      }
      const reasons = exceededReasons(this.state, call, this.now(), amountCents);
      if (reasons.length) {
        const work = { conversationId: call.conversationId, turnId: call.turnId };
        const exhaustion = { reasons, work };
        await fresh?.();
        await this.append('budget.exhausted', exhaustion);
        this.requireBudget(call);
      }
      await fresh?.();
      const id = randomUUID();
      await this.append('budget.reserved', { reservationId: id, permitId: id, amountCents,
        payingGroupId: call.payingGroupId, assistantId: call.assistantId, modelCall: call,
        dispatchGate: 1 });
      return id;
    });
  }
  private async recordRefusedWork(call: ModelCall, stopId: string, fresh?: () => Promise<void>) {
    function matchesWork(work: BudgetState['stoppedWork'][number]) {
      return work.conversationId === call.conversationId && work.turnId === call.turnId;
    }
    if (this.state.stoppedWork.some(matchesWork)) {
      return;
    }
    const work = { conversationId: call.conversationId, turnId: call.turnId };
    const refusal = { stopId, work };
    // Save the refused turn before replying so a later limit change cannot reopen it.
    await fresh?.();
    await this.append('budget.exhausted', refusal);
  }
  private requireBudget(call: ModelCall) {
    const stopId = budgetStopId(this.state, call, this.now());
    if (stopId !== undefined) {
      const message = budgetStopMessage(this.state, call, stopId);
      throw new BudgetRefused(message);
    }
  }
  admitDispatch(raw: unknown, fresh: () => Promise<void>) {
    const input = budgetCallDispatchAdmittedDataSchema.parse(raw);
    const admit = async () => {
      function matchesDispatch(saved: BudgetState['dispatches'][number]) {
        return saved.callId === input.callId ||
          (input.reservationId !== undefined && saved.reservationId === input.reservationId);
      }
      if (this.state.dispatches.some(matchesDispatch)) {
        throw new Error('Call already admitted; no further send permission');
      }
      requireDispatchReservation(this.state, input);
      this.requireBudget(input.modelCall);
      const reasons = exceededReasons(this.state, input.modelCall, this.now(), 0);
      if (reasons.length) {
        const work = { conversationId: input.modelCall.conversationId,
          turnId: input.modelCall.turnId };
        await fresh();
        await this.append('budget.exhausted', { reasons, work });
        this.requireBudget(input.modelCall);
      }
      // Recheck access after waiting in the queue, within the original time limit.
      try {
        await fresh();
      } catch (error) {
        if (input.reservationId !== undefined) {
          await this.appendNotDispatched(input.reservationId);
        }
        throw error;
      }
      // Treat even a lost reply as a possible send. Never return this permission twice.
      const dispatchId = randomUUID();
      await this.append('budget.call_dispatch_admitted', input, dispatchId, fresh);
    };
    return this.serial(admit);
  }
  releaseUndispatched(id: string) {
    return this.serial(async () => {
      const r = this.state.reservations.find(r => r.id === id);
      if (!r) throw new Error('Unmatched reservation');
      if (r.settledCents === 0 && !r.outcomeUnknown && !this.wasAdmitted(id)) return;
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
    if (!usage && outcome === 'success' && reservation.settledCents === 0 &&
        !reservation.outcomeUnknown) {
      // Hold the full amount again because the allowed call may have been sent.
      // Retry this write even when its uncertainty record already exists.
      const payload = {
        reservationId: id, permitId: id, settledCents: 0, outcome: 'unknown',
      };
      await this.append('budget.settled', payload);
    }
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
    if (redundantTimeout(type, reason, rows)) {
      this.timedOut.add(id);
      return;
    }
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
      if (type === 'effect.uncertain') this.timedOut.add(id);
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
    // Skip later expiry reads only after the uncertainty record has been saved.
    if (type === 'effect.uncertain') this.timedOut.add(id);
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
      if (!this.timedOut.has(reservation.id) && reservation.settledCents === undefined &&
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
    // Keep older holds: those senders did not use the recorded one-use gate.
    if (reservation.dispatchGate === undefined) {
      await this.recordEffectEvidence(reservation, undefined, 'success', 'settle_timeout');
      return;
    }
    const dispatched = await this.providerDispatched(reservation);
    const hasEvidence = await this.hasCallEvidence(reservation.id);
    if (!this.wasAdmitted(reservation.id) && !dispatched && !hasEvidence) {
      // Release only when no send permission or other call evidence exists.
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
    function matchesReservation(saved: BudgetState['reservations'][number]) {
      return saved.id === reservationId;
    }
    const reservation = this.state.reservations.find(matchesReservation);
    if (!reservation || this.wasAdmitted(reservationId) ||
        await this.providerDispatched(reservation) || await this.hasCallEvidence(reservationId)) {
      throw new Error('Call may have been dispatched');
    }
    const payload = {
      reservationId, permitId: reservationId, settledCents: 0, outcome: 'not_dispatched',
    };
    await this.append('budget.settled', payload);
  }
  private wasAdmitted(reservationId: string) {
    function matchesDispatch(saved: BudgetState['dispatches'][number]) {
      return saved.reservationId === reservationId;
    }
    return this.state.dispatches.some(matchesDispatch);
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
    if (!/^computer-[\w-]+$/u.test(subject)) {
      throw new Error('Wrong computer stream');
    }
    async function applyLoss(this: BudgetActor) {
      const rows = await history(this.store, subject, this.silo);
      function matchesLoss(row: typeof rows[number]) {
        return row.event.id === eventId;
      }
      const loss = rows.find(matchesLoss);
      if (loss?.event.type !== 'computer.lost') {
        throw new Error('Computer loss not recorded');
      }
      function isLifecycle(row: typeof rows[number]) {
        return ['computer.claimed', 'computer.ready', 'computer.suspended',
          'computer.resumed', 'computer.lost', 'computer.retired'].includes(row.event.type);
      }
      const lifecycle = rows.filter(isLifecycle);
      if (lifecycle.at(-1)?.event.id !== eventId) {
        return;
      }
      const computerId = z.string().parse(data(loss.event)['computerId']);
      // Compare saved event positions. Computer ids survive a new claim and clocks can differ.
      const budgetRows = await history(this.store, `budget-${this.silo}`, this.silo);
      const openedBeforeLoss = new Set<string>();
      for (const row of budgetRows) {
        if (row.sequence < loss.sequence && row.event.type === 'budget.reserved') {
          openedBeforeLoss.add(z.string().parse(data(row.event)['reservationId']));
        }
      }
      for (const reservation of this.state.reservations) {
        if (reservation.call.computerId === computerId &&
            reservation.settledCents === undefined && openedBeforeLoss.has(reservation.id)) {
          await this.recordEffect(reservation.id, undefined, 'success', 'computer_lost');
        }
      }
    }
    const apply = applyLoss.bind(this);
    return this.serial(apply);
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
