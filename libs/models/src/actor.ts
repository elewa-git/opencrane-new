import { prepareCeilingChange } from './ceiling-command.ts';
import { CeilingReceiptRecovery } from './ceiling-receipt-recovery.ts';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { budgetCallDispatchAdmittedDataSchema,
  effectResolvedDataSchema, effectUncertainDataSchema,
  effectObservedDataSchema, providerDispatchedSchema,
  type EventEnvelope } from '@opencrane/events';
import { costCents, data, emptyBudget, models, budgetStopId,
  exceededReasons, observedPayload, checkedManagedReservation,
  type BudgetState, type ModelCall, type ModelUsage } from './state.ts';

import { history } from './event-history.ts';
import { hasCallEvidence, retryReservation, type CallRetry, wasAdmitted, checkDispatchBinding,
  checkRootDispatch, checkRootGrant, checkRootReservation, setRootAllowance,
  stopRootAtCeiling, stopRootOnOverrun } from './root-budget.ts';
import { readRootStopEvidence, saveRootStop, type RootStopReason } from './root-stop-evidence.ts';
import { checkBudget as checkBudgetRefusal, recordRefusedWork, requireBudget } from './budget-refusal.ts';
import { envelope, migrateBudgetDefault } from './budget-migration.ts';
export { BudgetRefused } from './budget-refusal.ts';
export { envelope, migrateBudgetDefault } from './budget-migration.ts';
export { history } from './event-history.ts';

// Keep a hold for three minutes so usage reports have time to arrive.
const SETTLE_TIMEOUT_MS = 180_000;

export class BudgetActor {
  readonly state = emptyBudget();
  private sequence = 0;
  private readonly ceilingReceipts = new CeilingReceiptRecovery();
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
    const event = envelope(this.silo, `budget-${this.silo}`, type, payload, id, this.now());
    this.requireReservationWrites(event, confirmAccess);
    // Reuse replayed history; configure checks its caller's command id before this append.
    const command = { event, expectedSequence: this.sequence, historyChecked: true as const };
    let result = await this.store.append(command);
    if (result.status === 'conflict' && await this.advancePastSwitchOn()) {
      this.requireReservationWrites(event, confirmAccess);
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
  private requireReservationWrites(event: EventEnvelope, confirmAccess?: () => Promise<void>) {
    if (event.type !== 'budget.reserved' || !this.reservationsStopped) return;
    // Require validated call facts and the check used again after a switch-on race.
    if (!confirmAccess || !checkedManagedReservation(event)) {
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
    this.ceilingReceipts.apply(event, this.sequence, this.state);
  }

  configure(raw: unknown, commandId: string = randomUUID(), expectedSequence?: number,
    fresh?: () => Promise<void>) {
    const save = async () => {
      const prepared = await prepareCeilingChange(this, raw, commandId, expectedSequence, fresh);
      if (prepared.status !== 'ready') return prepared;
      await this.append('budget.ceiling_set', prepared.payload, commandId, fresh);
      return this.ceilingReceipts.receipt(this.state);
    };
    return this.serial(save);
  }
  setRootAllowance(raw: unknown, firstCallBoundCents: number) {
    const save = () => setRootAllowance(this.state, this.silo, this.now(), raw,
      firstCallBoundCents, this.append.bind(this));
    return this.serial(save);
  }
  async stopRoot(rootId: string, reason: RootStopReason, subject: string, position: number) {
    const source = await readRootStopEvidence(this.store, subject, position);
    const append = this.append.bind(this);
    const save = saveRootStop.bind(undefined, this.state, this.silo, rootId, reason, source, append);
    return this.serial(save);
  }
  reserve(call: ModelCall, amountCents: number, fresh?: () => Promise<void>, admittedAt?: number,
    rootId?: string, retry?: CallRetry,
    rootTurn?: Pick<ModelCall, 'turnId' | 'threadId'>) {
    return this.serial(async () => {
      const saved = await retryReservation(this.state, call, amountCents, rootId, retry,
        this.hasDispatchEvidence.bind(this), fresh);
      if (saved !== undefined) {
        await checkRootGrant(this.state, call, rootId, this.now(), fresh,
          this.append.bind(this), admittedAt, rootTurn);
        return saved;
      }
      z.int().positive().parse(amountCents);
      if (!models.some(row => row.id === call.model && row.priceTableId === call.priceTableId && !row.retired)) throw new Error('Unknown model tariff');
      if (!call.payingGroupId) throw new Error('Paying group unavailable');
      const root = await checkRootReservation(this.state, call, rootId, amountCents,
        this.append.bind(this), rootTurn, fresh);
      if (root) admittedAt = root.position;
      const stopId = budgetStopId(this.state, call, this.now(), admittedAt);
      if (stopId !== undefined) {
        await recordRefusedWork(this.state, call, stopId, fresh, this.append.bind(this));
        await stopRootAtCeiling(this.state, root, stopId, this.append.bind(this));
        requireBudget(this.state, call, this.now(), admittedAt);
      }
      const reasons = exceededReasons(this.state, call, this.now(), amountCents);
      if (reasons.length) {
        const work = { conversationId: call.conversationId, turnId: call.turnId };
        const exhaustion = { reasons, work };
        await fresh?.();
        await this.append('budget.exhausted', exhaustion);
        const stopId = budgetStopId(this.state, call, this.now(), admittedAt)!;
        await stopRootAtCeiling(this.state, root, stopId, this.append.bind(this));
        requireBudget(this.state, call, this.now());
      }
      await fresh?.();
      const id = randomUUID();
      await this.append('budget.reserved', { reservationId: id, permitId: id, amountCents,
        payingGroupId: call.payingGroupId, assistantId: call.assistantId, modelCall: call,
        dispatchGate: 1, ...retry, ...(rootId === undefined ? {} : { rootId }) }, undefined, fresh);
      return id;
    });
  }
  checkBudget(call: ModelCall, fresh: () => Promise<void>, admittedAt: number, rootId?: string) {
    const check = () => checkBudgetRefusal(this.state, call, fresh, admittedAt,
      rootId, this.now, this.append.bind(this));
    return this.serial(check);
  }
  admitDispatch(raw: unknown, fresh: () => Promise<void>, admittedAt?: number,
    rootTurn?: Pick<ModelCall, 'turnId' | 'threadId'>) {
    const parsed = budgetCallDispatchAdmittedDataSchema.parse(raw);
    const admit = async () => {
      const input = checkDispatchBinding(this.state, parsed);
      admittedAt = await checkRootDispatch(this.state, input, this.now(), fresh,
        this.append.bind(this), this.appendNotDispatched.bind(this), admittedAt, rootTurn);
      requireBudget(this.state, input.modelCall, this.now(), admittedAt);
      const reasons = exceededReasons(this.state, input.modelCall, this.now(), 0);
      if (reasons.length) {
        const work = { conversationId: input.modelCall.conversationId,
          turnId: input.modelCall.turnId };
        await fresh();
        await this.append('budget.exhausted', { reasons, work });
        requireBudget(this.state, input.modelCall, this.now(), admittedAt);
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
      if (r.settledCents === 0 && !r.outcomeUnknown && !wasAdmitted(this.state, id)) return;
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
    function provesNoDispatch(evidence: typeof d.evidence[number]) {
      return evidence.kind === 'dispatch_record';
    }
    const released = d.outcome === 'released' && d.evidence.every(provesNoDispatch);
    await this.settleCharge(r, d.settledCents, released);
  }
  private async settleCharge(r: BudgetState['reservations'][number], cents: number, released = false) {
    const rows = await history(this.store, `effect-${r.id}`, this.silo);
    const amounts = rows.flatMap(({ event }) => {
      if (event.type === 'effect.observed') return [effectObservedDataSchema.parse(event.data).costCents];
      if (event.type === 'effect.resolved') return [effectResolvedDataSchema.parse(event.data).settledCents];
      return [];
    });
    // Clear temporary uncertainty only with non-dispatch proof; keep conflicting amounts held.
    const unresolved = Boolean(r.outcomeUnknown) && !released;
    const conflict = unresolved || amounts.some(amount => amount !== cents) ||
      (r.settledCents !== undefined && r.settledCents !== cents);
    const amount = Math.max(r.settledCents ?? 0, cents, ...amounts);
    // Save the stop first so a failed settlement write cannot reopen the root after restart.
    await stopRootOnOverrun(this.state, r, amount, this.append.bind(this));
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
      await this.closeExpiredReservation(reservation);
      await this.recordEffectEvidence(reservation, undefined, 'success', 'settle_timeout');
      return;
    }
    const dispatched = await this.providerDispatched(reservation);
    const hasEvidence = await hasCallEvidence(this.store, this.silo, reservation.id);
    if (!wasAdmitted(this.state, reservation.id) && !dispatched && !hasEvidence) {
      // Release only when no send permission or other call evidence exists.
      // Keep the hold if a read fails, then try again at the next expiry check.
      await this.appendNotDispatched(reservation.id);
      return;
    }
    if (dispatched) {
      await this.alert(reservation.id);
    }
    await this.closeExpiredReservation(reservation);
    await this.recordEffectEvidence(reservation, undefined, 'success', 'settle_timeout');
  }
  private async closeExpiredReservation(reservation: BudgetState['reservations'][number]) {
    if (reservation.expired) {
      return;
    }
    // Save refusal before uncertainty so replay and an earlier clock cannot reopen the call.
    await this.append('budget.reservation_expired', { reservationId: reservation.id });
  }
  private async appendNotDispatched(reservationId: string) {
    function matchesReservation(saved: BudgetState['reservations'][number]) {
      return saved.id === reservationId;
    }
    const reservation = this.state.reservations.find(matchesReservation);
    if (!reservation || await this.hasDispatchEvidence(reservation)) {
      throw new Error('Call may have been dispatched');
    }
    const payload = {
      reservationId, permitId: reservationId, settledCents: 0, outcome: 'not_dispatched',
    };
    await this.append('budget.settled', payload);
  }
  private async hasDispatchEvidence(reservation: BudgetState['reservations'][number]) {
    return wasAdmitted(this.state, reservation.id) || await this.providerDispatched(reservation) ||
      await hasCallEvidence(this.store, this.silo, reservation.id);
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

function redundantTimeout(type: string, reason: string, rows: Awaited<ReturnType<typeof history>>) {
  return type === 'effect.uncertain' && reason === 'settle_timeout' && rows.some(row => row.event.type === type);
}
