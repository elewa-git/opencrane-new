import { EventStore } from '@opencrane/event-store';
import { EgressRelayRegistry, type EgressCloseRecord } from '../src/egress-relay.ts';
import { JetStreamApiError, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { countReads, expectNoWholeReads, lostReplyStore, natsFixture, TimeoutError } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { createLogger } from '@opencrane/observability';
import { pgDb, ProjectionRunner } from '@opencrane/projections';
import { BudgetActor, budgets, budgetSummary, envelope, history, priceTableId,
  readBudget, totals } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
let clock: Date;

function now() {
  return clock;
}

async function initialise() {
  nats = await natsFixture();
  clock = new Date('2026-10-05T12:00:00Z');
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(100, 100, 'group');
}

async function close() {
  await nats.close();
}

beforeEach(initialise);
afterEach(close);

async function reserve(provider = false, requestId?: string, legacy = false) {
  const call = {
    requestId, model: 'gpt-6-luna', priceTableId,
    computerId: provider ? 'provider-primary' : 'computer',
    assistantId: provider ? 'provider-verification' : 'assistant',
    requesterId: 'alice', conversationId: provider ? 'provider-primary' : 'conversation',
    turnId: 'attempt', threadId: 'attempt', payingGroupId: 'group',
    contextDigest: '0'.repeat(64),
  };
  if (!legacy) {
    return actor.reserve(call, 1);
  }
  const reservationId = 'legacy-reservation';
  const payload = { reservationId, permitId: reservationId, amountCents: 1,
    payingGroupId: 'group', assistantId: call.assistantId, modelCall: call };
  const event = envelope('test', 'budget-test', 'budget.reserved', payload,
    'legacy-reserved', clock);
  await nats.store.append({ event, expectedSequence: await nats.store.head('budget-test') });
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  return reservationId;
}

async function expire() {
  clock = new Date(clock.getTime() + 180_001);
  await actor.expire();
  await actor.expire();
}

async function releasesWithoutAdmission(provider: boolean) {
  const reservationId = await reserve(provider, 'request');
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
  const budget = await history(nats.store, 'budget-test', 'test');
  function isSettlement(row: (typeof budget)[number]) {
    return row.event.type === 'budget.settled';
  }
  const settlements = budget.filter(isSettlement);
  expect(settlements).toHaveLength(1);
  expect(settlements[0]?.event.data).toEqual({
    reservationId, permitId: reservationId, settledCents: 0, outcome: 'not_dispatched',
  });
  expect(await history(nats.store, `effect-${reservationId}`, 'test')).toEqual([]);
  expect(await history(nats.store, `security-${reservationId}`, 'test')).toEqual([]);
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  await recovered.expire();
  expect(totals(recovered.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}

it.each([false, true])('releases an expired hold without admission (provider: %s)',
  releasesWithoutAdmission);

async function keepsAllowedHold(provider: boolean) {
  const reservationId = await reserve(provider, 'request', true);
  const payload = {
    requestId: 'request', route: 'model', outcome: 'allow', reason: 'model_allowed',
    contextDigest: '0'.repeat(64), permitId: reservationId,
  };
  const event = envelope('test', 'decision-request', 'decision.recorded', payload);
  const command = { event, expectedSequence: 0 };
  await nats.store.append(command);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects).toHaveLength(1);
  expect(effects[0]?.event).toMatchObject({
    type: 'effect.uncertain', data: { permitId: reservationId, reason: 'settle_timeout' },
  });
  expect(await history(nats.store, `security-${reservationId}`, 'test')).toEqual([]);
}

it.each([false, true])('keeps an allowed hold uncertain at expiry (provider: %s)',
  keepsAllowedHold);

async function keepsDispatchedHold() {
  const reservationId = await reserve(true, 'request');
  const payload = {
    providerId: 'primary', revision: 2, changedBy: 'alice', attemptId: 'attempt',
    kind: 'model', model: 'gpt-6-luna', reservedCents: 1, reservationId,
  };
  const event = envelope('test', 'provider-primary', 'provider.verification_dispatched', payload);
  const command = { event, expectedSequence: 0 };
  await nats.store.append(command);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects[0]?.event).toMatchObject({ type: 'effect.uncertain' });
  const alerts = await history(nats.store, `security-${reservationId}`, 'test');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.event).toMatchObject({
    type: 'security.alert_raised',
    data: { severity: 'high', reason: 'effect_without_permit' },
  });
}

it('keeps a dispatched provider hold uncertain even without an allow decision', keepsDispatchedHold);

async function keepsLegacyHold(requestId: string | undefined) {
  const reservationId = await reserve(false, requestId, true);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects[0]?.event.type).toBe('effect.uncertain');
}

it.each([undefined, 'request'])('keeps an old hold uncertain (request id: %s)', keepsLegacyHold);

async function keepsHoldAfterUsageWithoutDecision() {
  const budget = {
    scope: 'global', dailyCeilingCents: 1000, ceilingCents: 1000, setBy: 'alice',
  };
  await actor.configure(budget);
  const call = {
    requestId: 'usage-request', model: 'gpt-6-luna', priceTableId,
    computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
    conversationId: 'conversation', turnId: 'attempt', threadId: 'attempt',
    payingGroupId: 'group', contextDigest: '0'.repeat(64),
  };
  const reservationId = await actor.reserve(call, 500);
  const usage = { inputTokens: 100_000, outputTokens: 2000 };
  await actor.effect(reservationId, usage);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 500, monthCents: 0 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects).toHaveLength(1);
  expect(effects[0]?.event).toMatchObject({
    type: 'effect.uncertain', data: { reason: 'settle_timeout' },
  });
  const alerts = await history(nats.store, `security-${reservationId}`, 'test');
  expect(alerts).toHaveLength(1);
  expect(alerts[0]?.event.data).toMatchObject({ reason: 'effect_without_permit' });
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  await recovered.expire();
  expect(totals(recovered.state, clock)).toMatchObject({ reservedCents: 500 });
}

it('keeps money held when usage was reported without an allow decision',
  keepsHoldAfterUsageWithoutDecision);

async function keepsHoldWithRecordedEffect() {
  const reservationId = await reserve(false, 'request');
  const payload = { permitId: reservationId, computerId: 'computer',
    reason: 'transport_failure' };
  const event = envelope('test', `effect-${reservationId}`, 'effect.uncertain', payload);
  const command = { event, expectedSequence: 0 };
  expect((await nats.store.append(command)).status).toBe('appended');
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects).toHaveLength(1);
  expect(effects[0]?.event.data).toMatchObject({ reason: 'transport_failure' });
}

it('keeps money held when an effect was recorded without an allow decision',
  keepsHoldWithRecordedEffect);

async function restoresReleasedHoldAfterTransportFailure() {
  const reservationId = await reserve(false, 'request');
  await expire();
  const payload = {
    requestId: 'request', route: 'model', outcome: 'allow', reason: 'model_allowed',
    contextDigest: '0'.repeat(64), permitId: reservationId,
  };
  const event = envelope('test', 'decision-request', 'decision.recorded', payload);
  const command = { event, expectedSequence: 0 };
  expect((await nats.store.append(command)).status).toBe('appended');
  await actor.uncertain(reservationId, 'transport_failure');
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  expect(actor.state.reservations[0]).toMatchObject({
    settledCents: 0, outcomeUnknown: true,
  });
  const beforeRetry = await nats.store.head();
  await actor.uncertain(reservationId, 'transport_failure');
  await actor.expire();
  expect(await nats.store.head()).toBe(beforeRetry);
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  expect(totals(recovered.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects).toHaveLength(1);
  expect(effects[0]?.event.data).toMatchObject({ reason: 'transport_failure' });
  expect(await history(nats.store, `security-${reservationId}`, 'test')).toEqual([]);
}

it('restores a released hold when an allowed call later reports a transport failure',
  restoresReleasedHoldAfterTransportFailure);

async function refusesUncertaintyWithoutAllow() {
  const reservationId = await reserve(false, 'request');
  await expire();
  await actor.uncertain(reservationId, 'transport_failure');
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
  expect(await history(nats.store, `effect-${reservationId}`, 'test')).toEqual([]);
  const alerts = await history(nats.store, `security-${reservationId}`, 'test');
  expect(alerts[0]?.event.data).toMatchObject({ reason: 'effect_without_permit' });
}

it('keeps a released hold at zero when uncertainty has no allow decision',
  refusesUncertaintyWithoutAllow);

async function reservesWithoutRereadingOldBudgetEvents() {
  const events = [];
  for (let index = 0; index < 498; index++) {
    const payload = { periodStart: '2026-10-01T00:00:00.000Z' };
    events.push(envelope('test', 'budget-test', 'budget.period_started', payload));
  }
  await nats.seed(events);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const reads = countReads(nats.store);
  await reserve();
  reads.clear();
  await reserve();
  expectNoWholeReads(reads.calls);
  let budgetRows = 0;
  for (const call of reads.calls) {
    if (call.subject === 'budget-test') {
      budgetRows += call.rows;
    }
  }
  expect(budgetRows).toBeLessThanOrEqual(2);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 2, monthCents: 0 });
}
it('reserves on 500 budget events without rereading the old spending history',
  reservesWithoutRereadingOldBudgetEvents);

async function keepsConfigureRepeatFromWritingAgain() {
  const payload = {
    scope: 'global', dailyCeilingCents: 200, ceilingCents: 200, setBy: 'alice',
  };
  const saved = envelope('test', 'budget-test', 'budget.ceiling_set', payload, 'configure-once');
  // Give the saved attempt another event id so NATS deduplication cannot hide a repeat.
  saved.id = 'earlier-configure-attempt';
  await nats.seed([saved]);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  await reserve();
  const before = await nats.store.head();
  expect(await actor.configure(payload, 'configure-once')).toMatchObject({ status: 'appended' });
  expect(await nats.store.head()).toBe(before);
  const changed = { ...payload, ceilingCents: 300 };
  expect(await actor.configure(changed, 'configure-once')).toEqual({ status: 'conflict' });
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.ceilingCents).toBe(200);
}
it('recognises an old configure command after later budget writes',
  keepsConfigureRepeatFromWritingAgain);

async function stopsAfterAnotherLeaderWrites() {
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  const before = await nats.store.head();
  const reads = countReads(nats.store);
  await expect(reserve()).rejects.toThrow('Budget writer lost its fence');
  for (const call of reads.calls) {
    expect(call).toMatchObject({ subject: 'budget-test', fromSequence: 3 });
    expect(call.rows).toBeLessThanOrEqual(1);
  }
  await expect(reserve()).rejects.toThrow('Budget writer unavailable');
  expect(await nats.store.head()).toBe(before);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}
it('stops the old actor after another leader writes without holding money',
  stopsAfterAnotherLeaderWrites);

async function saveSwitchOn() {
  const payload = {
    providerId: 'primary', revision: 1, changedBy: 'alice', expectedProviderSequence: 0,
  };
  const marker = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
  const expectedSequence = await nats.store.head('budget-test');
  const command = { event: marker, expectedSequence };
  expect((await nats.store.append(command)).status).toBe('appended');
}

async function refusesHoldButKeepsReleaseAfterSwitchOn() {
  const releaseId = await reserve(false, 'unsent-release');
  const expiryId = await reserve(false, 'unsent-expiry');
  await saveSwitchOn();
  await expect(reserve()).rejects.toThrow('Provider setup changed');
  await expect(reserve()).rejects.toThrow('Provider setup changed');
  expect(actor.state.reservations).toHaveLength(2);
  await actor.releaseUndispatched(releaseId);
  await expire();
  expect(actor.state.reservations[1]).toMatchObject({ id: expiryId, settledCents: 0 });
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
  const recovered = new BudgetActor(nats.store, 'test', now);
  await recovered.start();
  await expect(recovered.reserve(actor.state.reservations[0]!.call, 1))
    .rejects.toThrow('Provider setup changed');
}
it('refuses new holds after switch-on without stopping releases and expiry on the same actor',
  refusesHoldButKeepsReleaseAfterSwitchOn);

async function stopsSettlementAfterSwitchOnAndAnotherLeader() {
  const reservationId = await reserve(false, 'unsent-release');
  await saveSwitchOn();
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  const before = await nats.store.head();
  await expect(actor.releaseUndispatched(reservationId))
    .rejects.toThrow('Budget writer lost its fence');
  await expect(actor.releaseUndispatched(reservationId))
    .rejects.toThrow('Budget writer unavailable');
  expect(await nats.store.head()).toBe(before);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  await replacement.releaseUndispatched(reservationId);
  expect(totals(replacement.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}
it('keeps the old actor stopped when another budget writer follows switch-on',
  stopsSettlementAfterSwitchOnAndAnotherLeader);

async function projectedBudgetSummary() {
  const storage = await databases();
  const db = pgDb(storage.queue);
  const logger = createLogger('test', { level: 'silent' });
  const runner = new ProjectionRunner(db, nats.store, logger);
  try {
    await runner.initialise(budgets);
    await runner.run(budgets);
    const state = await readBudget(db, 'test');
    return budgetSummary(state, clock);
  } finally {
    await storage.close();
  }
}

async function rechecksAccessBeforeRetryingConfiguration(withHold: boolean) {
  if (withHold) {
    await reserve(false, 'unsent-release');
  }
  const expectedSequence = actor.state.sequence;
  await saveSwitchOn();
  const before = await nats.store.head('budget-test');
  let checks = 0;
  function checkAccess() {
    checks++;
    // Expire after the first append has refused its old budget position.
    if (checks === 3) {
      const error = new Error('Access expired');
      return Promise.reject(error);
    }
    return Promise.resolve();
  }
  const payload = {
    scope: 'global', dailyCeilingCents: 200, ceilingCents: 200, setBy: 'alice',
  };
  const refused = actor.configure(payload, 'configure-switch', expectedSequence, checkAccess);
  await expect(refused).rejects.toThrow('Access expired');
  expect(checks).toBe(3);
  expect(actor.state.ceilingCents).toBe(100);
  expect(await nats.store.head('budget-test')).toBe(before);
  const projected = await projectedBudgetSummary();
  const returned = budgetSummary(actor.state, clock);
  expect(returned.sequence).toBe(expectedSequence);
  expect(projected.sequence).toBe(returned.sequence);
  const retry = await actor.configure(payload, 'configure-switch', projected.sequence, checkAccess);
  expect(retry).toMatchObject({ status: 'appended' });
  expect(checks).toBe(5);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  expect(actor.state.sequence).toBe(before + 1);
  expect(actor.state.ceilingCents).toBe(200);
  const after = await projectedBudgetSummary();
  expect(after).toEqual(budgetSummary(actor.state, clock));
  const stale = await actor.configure(payload, 'configure-stale', expectedSequence, checkAccess);
  expect(stale).toEqual({ status: 'conflict' });
  expect(checks).toBe(6);
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  let reservedCents = 0;
  if (withHold) {
    reservedCents = 1;
  }
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents, monthCents: 0 });
}
it.each([false, true])(
  'retries an access-expired spending-limit change with its projected revision (hold: %s)',
  rechecksAccessBeforeRetryingConfiguration);

async function configuresAfterRefusingReservationPastSwitchOn() {
  const expectedSequence = actor.state.sequence;
  await saveSwitchOn();
  const before = await nats.store.head('budget-test');
  await expect(reserve()).rejects.toThrow('Provider setup changed');
  expect(await nats.store.head('budget-test')).toBe(before);
  const projected = await projectedBudgetSummary();
  expect(projected.sequence).toBe(expectedSequence);
  expect(budgetSummary(actor.state, clock).sequence).toBe(projected.sequence);
  const payload = {
    scope: 'global', dailyCeilingCents: 200, ceilingCents: 200, setBy: 'alice',
  };
  const result = await actor.configure(payload, 'configure-after-refusal', projected.sequence);
  expect(result).toMatchObject({ status: 'appended' });
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  expect(actor.state.sequence).toBe(before + 1);
  const after = await projectedBudgetSummary();
  expect(after).toEqual(budgetSummary(actor.state, clock));
  await expect(reserve()).rejects.toThrow('Provider setup changed');
  expect(await nats.store.head('budget-test')).toBe(before + 1);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}
it('changes spending limits with the projected revision after switch-on refuses a reservation',
  configuresAfterRefusingReservationPastSwitchOn);

async function advancesAfterLostReservationReply() {
  const faulty = await lostReplyStore(nats.connection);
  const store = faulty.store;
  actor = new BudgetActor(store, 'test', now);
  await actor.start();
  const before = await store.head('budget-test');
  faulty.loseNextReply();
  const first = await reserve();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  const second = await reserve();
  const rows = await history(store, 'budget-test', 'test');
  function isReservation(row: (typeof rows)[number]) {
    return row.event.type === 'budget.reserved';
  }
  const reservations = rows.filter(isReservation);
  expect(reservations).toMatchObject([
    { sequence: before + 1, event: { data: { reservationId: first } } },
    { sequence: before + 2, event: { data: { reservationId: second } } },
  ]);
  expect(reservations).toHaveLength(2);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 2, monthCents: 0 });
}
it('stores a lost-reply reservation once and uses its position for the next reservation',
  advancesAfterLostReservationReply);

async function oldLossKeepsCurrentHold(reclaimed: boolean) {
  const loss = envelope('test', 'computer-assistant', 'computer.lost', {
    assistantId: 'assistant', computerId: 'computer',
  });
  const saved = await nats.store.append({ event: loss, expectedSequence: 0 });
  if (saved.status !== 'appended') {
    throw new Error('Loss append failed');
  }
  if (reclaimed) {
    const claim = envelope('test', loss.subject, 'computer.claimed', {
      assistantId: 'assistant', computerId: 'computer', generation: 2, tokenId: 'token:new',
    });
    await nats.store.append({ event: claim, expectedSequence: saved.sequence });
  }
  const reservationId = await reserve(false, 'current-request');
  const before = await nats.store.head();
  await actor.computerLostRecorded(loss.subject, loss.id);
  expect(await nats.store.head()).toBe(before);
  expect(await history(nats.store, `effect-${reservationId}`, 'test')).toEqual([]);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
}
it.each([false, true])('old loss leaves a later reservation untouched (reclaimed: %s)',
  oldLossKeepsCurrentHold);

async function settlesExpiredLegacyHoldAfterReplay() {
  const reservationId = await reserve(false, undefined, true);
  const reservedAt = new Date(clock);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
  clock = reservedAt;
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const reservation = actor.state.reservations[0]!;
  const input = { callId: 'legacy-call', decisionId: 'legacy-decision',
    reservationId, bodyDigest: '0'.repeat(64), modelCall: reservation.call };
  async function fresh() {}
  await expect(actor.admitDispatch(input, fresh)).rejects.toThrow('no longer open');
  await actor.effect(reservationId, { inputTokens: 1000, outputTokens: 10 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  function observed(row: (typeof effects)[number]) {
    return row.event.type === 'effect.observed';
  }
  const usage = effects.find(observed)!;
  await actor.settleRecorded(reservationId, usage.event.id);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 1 });
  const storage = await databases();
  try {
    const db = pgDb(storage.queue);
    const logger = createLogger('legacy-expiry-test', { level: 'silent' });
    const runner = new ProjectionRunner(db, nats.store, logger);
    await runner.initialise(budgets);
    await runner.run(budgets);
    const projected = await readBudget(db, 'test');
    expect(projected.reservations).toEqual(actor.state.reservations);
    expect(totals(projected, clock)).toMatchObject({ reservedCents: 0, monthCents: 1 });
  } finally {
    await storage.close();
  }
}
it('settles later usage for an expired legacy hold without reopening admission after replay',
  settlesExpiredLegacyHoldAfterReplay);

async function admitsOnlyCheckedManagedHolds(restart: boolean) {
  await saveSwitchOn();
  if (restart) {
    actor = new BudgetActor(nats.store, 'test', now);
    await actor.start();
  }
  const call = { providerId: 'primary', bindingSequence: 42, requestId: 'managed',
    model: 'gpt-6-luna', priceTableId, computerId: 'computer', generation: 1,
    assistantId: 'assistant', requesterId: 'alice', conversationId: 'conversation',
    turnId: 'turn', threadId: 'thread', payingGroupId: 'group', contextDigest: 'a'.repeat(64) };
  let checks = 0;
  function confirm() {
    checks++;
    return Promise.resolve();
  }
  const reservationId = await actor.reserve(call, 1, confirm);
  expect(checks).toBe(restart ? 2 : 4);
  await expect(actor.reserve(call, 1)).rejects.toThrow('Provider setup changed');
  const incomplete = { ...call, bindingSequence: undefined };
  await expect(actor.reserve(incomplete, 1, confirm)).rejects.toThrow();
  const legacy = { ...call, providerId: undefined, bindingSequence: undefined };
  await expect(actor.reserve(legacy, 1, confirm)).rejects.toThrow('Provider setup changed');

  expect(actor.state.reservations).toHaveLength(1);
  expect(actor.state.reservations[0]?.call).toEqual(call);
  await actor.releaseUndispatched(reservationId);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}
it.each([false, true])('admits only validated, checked managed holds after switch-on (restart: %s)',
  admitsOnlyCheckedManagedHolds);

async function recoversCeilingAfterRestart() {
  const manager = await jetstreamManager(nats.connection);
  await manager.streams.update('EVENTS', { duplicate_window: 1_000_000_000 });
  const payload = { scope: 'global', ceilingCents: 300, setBy: 'alice' };
  const revision = actor.state.sequence;
  const saved = await actor.configure(payload, 'original-ceiling', revision);
  expect(saved).toMatchObject({ status: 'appended', receipt: {
    commandId: 'original-ceiling', ceilingCents: 300, setBy: 'alice',
  } });
  await reserve();
  await actor.configure({ ...payload, ceilingCents: 250 }, 'later-ceiling');
  await delay(1100);
  actor = new BudgetActor(nats.store, 'test', now);
  await actor.start();
  const before = await nats.store.head();
  expect(await actor.configure(payload, 'original-ceiling', revision)).toEqual(saved);
  expect(await actor.configure({ ...payload, setBy: 'bob' }, 'original-ceiling'))
    .toEqual({ status: 'conflict' });
  expect(await actor.configure({ ...payload, ceilingCents: 301 }, 'original-ceiling'))
    .toEqual({ status: 'conflict' });
  expect(await nats.store.head()).toBe(before);
}
it('returns the original ceiling receipt after restart and duplicate expiry',
  recoversCeilingAfterRestart);

async function recoversReplacementReceipt() {
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  const payload = { scope: 'global', ceilingCents: 0, setBy: 'alice' };
  const saved = await replacement.configure(payload, 'replacement-ceiling');
  expect(saved).toMatchObject({ receipt: {
    stop: { status: 'stopping', stopId: 'replacement-ceiling' },
  } });
  const before = await nats.store.head();
  expect(await actor.configure(payload, 'replacement-ceiling')).toEqual(saved);
  expect(await nats.store.head()).toBe(before);
}
it('recovers the exact stop receipt saved by a replacement budget actor',
  recoversReplacementReceipt);

async function relayReadsDoNotBlockMoney() {
  const position = await nats.store.head('budget-test');
  const replies: (() => void)[] = [];
  function delayedHead() {
    const result = Promise.withResolvers<number>();
    function reply() {
      result.resolve(position);
    }
    replies.push(reply);
    setTimeout(reply, 400);
    return result.promise;
  }
  const spy = vi.spyOn(nats.store, 'head').mockImplementation(delayedHead);
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'Date'] });
  const records: EgressCloseRecord[] = [];
  function capture(record: EgressCloseRecord) {
    records.push(record);
  }
  const registry = new EgressRelayRegistry(capture);
  function recheck() {
    return actor.requireCurrent(performance.now() + 2000);
  }
  function cleanup() {
    registry.closeAll();
    spy.mockRestore();
    for (const reply of replies) reply();
    vi.useRealTimers();
  }
  onTestFinished(cleanup);
  for (let index = 0; index < 4; index++) {
    const request = { host: 'registry.npmjs.org', port: 443, permitId: String(index),
      expiresAt: Date.now() + 60_000, recheck };
    await registry.register(request);
  }
  await vi.advanceTimersByTimeAsync(1900);
  expect(records).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  let reserved = false;
  function reservationSaved() {
    reserved = true;
  }
  const saving = reserve().then(reservationSaved);
  // Let real NATS finish the append without advancing the proof-read timers.
  await delay(100);
  expect(reserved).toBe(true);
  cleanup();
  await saving;
}
it('keeps four healthy relays open without putting proof reads ahead of money',
  relayReadsDoNotBlockMoney);

async function currentProofDeadline() {
  const position = await nats.store.head('budget-test');
  const deadline = performance.now() + 2000;
  function lateHead() {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(deadline);
    onTestFinished(clock.mockRestore.bind(clock));
    return Promise.resolve(position);
  }
  const spy = vi.spyOn(nats.store, 'head').mockImplementation(lateHead);
  onTestFinished(spy.mockRestore.bind(spy));
  await expect(actor.requireCurrent(deadline)).rejects.toThrow('Budget writer unavailable');
}
it('refuses current-writer proof whose matching position arrives at the deadline',
  currentProofDeadline);

async function currentProofWaitsForAppend() {
  const append = nats.store.appendOutcome.bind(nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function holdReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    entered.resolve();
    await release.promise;
    return result;
  }
  const spy = vi.spyOn(nats.store, 'appendOutcome').mockImplementation(holdReply);
  function cleanup() {
    release.resolve();
    spy.mockRestore();
  }
  onTestFinished(cleanup);
  const reservation = reserve();
  await entered.promise;
  let checked = false;
  let failure: unknown;
  function failed(error: unknown) {
    checked = true;
    failure = error;
  }
  function completed() {
    checked = true;
  }
  const checking = actor.requireCurrent(performance.now() + 2000).then(completed, failed);
  await delay(50);
  expect(checked).toBe(false);
  release.resolve();
  await reservation;
  await checking;
  expect(checked).toBe(true);
  expect(failure).toBeUndefined();
}
it('waits for its own unfinished append before proving the budget writer is current',
  currentProofWaitsForAppend);

async function moneyDuringProofRead() {
  const head = nats.store.head.bind(nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  async function holdFirstRead(...args: Parameters<typeof head>) {
    const position = await head(...args);
    reads++;
    if (reads === 1) {
      entered.resolve();
      await release.promise;
    }
    return position;
  }
  const spy = vi.spyOn(nats.store, 'head').mockImplementation(holdFirstRead);
  function cleanup() {
    release.resolve();
    spy.mockRestore();
  }
  onTestFinished(cleanup);
  const checking = actor.requireCurrent(performance.now() + 2000);
  await entered.promise;
  const reservation = await reserve();
  release.resolve();
  await checking;
  expect(actor.state.reservations).toMatchObject([{ id: reservation, amountCents: 1 }]);
  expect(reads).toBe(2);
}
it('rechecks a position read that overlapped a money command without blocking that command',
  moneyDuringProofRead);

async function failedWriterCannotProveCurrent() {
  const replacement = new BudgetActor(nats.store, 'test', now);
  await replacement.start();
  await expect(reserve()).rejects.toThrow('Budget writer lost its fence');
  await expect(actor.requireCurrent(performance.now() + 2000))
    .rejects.toThrow('Budget writer unavailable');
}
it('refuses proof from a failed writer even when its saved position still matches',
  failedWriterCannotProveCurrent);

async function admitsAfterUnrelatedWrite(change: string) {
  const reservationId = await reserve(false, 'admission-race');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'admission-race', decisionId: 'decision-race',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const budgetPosition = await nats.store.head('budget-test');
  const started = performance.now();
  const decisionClock = vi.spyOn(performance, 'now');
  decisionClock.mockReturnValue(started);
  function restoreDecisionClock() {
    decisionClock.mockRestore();
  }
  onTestFinished(restoreDecisionClock);
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (checks === 2) {
      // Move the global position during the checked append, after its earlier position read.
      const joined = { memberId: 'bob', email: 'bob@example.test',
        displayName: 'Bob', role: 'member' };
      const event = envelope('test', 'member-bob', 'member.joined', joined);
      const command = { event, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('appended');
      if (change === 'writer') {
        const replacement = new BudgetActor(nats.store, 'test', now);
        await replacement.start();
      }
    }
    if (checks >= 3 && change === 'revoked') {
      throw new Error('Authority changed');
    }
    if (checks >= 3 && change === 'expired') {
      decisionClock.mockReturnValue(started + 2001);
    }
    if (performance.now() >= started + 2000) {
      throw new Error('Authority snapshot expired');
    }
  }
  const admitted = actor.admitDispatch(admission, checkAccess);
  if (change === 'unchanged') {
    await admitted;
    expect(checks).toBe(4);
    expect(actor.state.dispatches).toEqual([admission]);
    expect(await nats.store.head('budget-test')).toBeGreaterThan(budgetPosition);
  } else {
    let reason = 'Budget writer lost its fence';
    if (change === 'revoked') {
      reason = 'Authority changed';
    }
    if (change === 'expired') {
      reason = 'Authority snapshot expired';
    }
    await expect(admitted).rejects.toThrow(reason);
    expect(actor.state.dispatches).toHaveLength(0);
    const rows = await history(nats.store, 'budget-test', 'test');
    function isAdmission(row: typeof rows[number]) {
      return row.event.type === 'budget.call_dispatch_admitted';
    }
    expect(rows.filter(isAdmission)).toHaveLength(0);
  }
  expect(actor.state.reservations).toHaveLength(1);
  expect(actor.state.reservations[0]!.settledCents).toBeUndefined();
}
it.each(['unchanged', 'revoked', 'expired', 'writer'])(
  'rechecks budget admission after an unrelated append with access %s',
  admitsAfterUnrelatedWrite);

async function admitsAfterRepeatedConflicts(change: string) {
  const reservationId = await reserve(false, 'repeated-admission');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'repeated-admission', decisionId: 'repeated-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const budgetPosition = await nats.store.head('budget-test');
  const deadline = performance.now() + 2000;
  const decisionClock = vi.spyOn(performance, 'now');
  onTestFinished(decisionClock.mockRestore.bind(decisionClock));
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (checks === 2 || checks === 4) {
      const memberId = `unrelated-${checks}`;
      const joined = { memberId, email: `${memberId}@example.test`,
        displayName: 'Unrelated member', role: 'member' };
      const event = envelope('test', `member-${memberId}`, 'member.joined', joined);
      const command = { event, expectedSequence: 0 };
      expect((await nats.store.append(command)).status).toBe('appended');
      if (checks === 4 && change === 'writer') {
        const replacement = new BudgetActor(nats.store, 'test', now);
        await replacement.start();
      }
    }
    if (checks === 5 && change === 'revoked') throw new Error('Authority changed');
    if (checks === 5 && change === 'expired') decisionClock.mockReturnValue(deadline);
    if (performance.now() >= deadline) throw new Error('Authority snapshot expired');
  }
  checkAccess.deadline = deadline;
  const reads = vi.spyOn(nats.store, 'readStream');
  const writes = vi.spyOn(nats.store, 'appendOutcome');
  onTestFinished(reads.mockRestore.bind(reads));
  onTestFinished(writes.mockRestore.bind(writes));
  const admitted = actor.admitDispatch(admission, checkAccess);
  if (change === 'unchanged') {
    await admitted;
    expect(checks).toBe(6);
    expect(actor.state.dispatches).toEqual([admission]);
    await expect(actor.admitDispatch(admission, checkAccess)).rejects.toThrow();
    expect(actor.state.dispatches).toHaveLength(1);
  } else {
    let reason = 'Budget writer lost its fence';
    if (change === 'revoked') reason = 'Authority changed';
    if (change === 'expired') reason = 'Authority snapshot expired';
    await expect(admitted).rejects.toThrow(reason);
    expect(actor.state.dispatches).toHaveLength(0);
  }
  for (const [subject, fromSequence, readDeadline] of reads.mock.calls) {
    if (subject === 'budget-test' && fromSequence === budgetPosition + 1) {
      expect(readDeadline).toBe(deadline);
    }
  }
  for (const [command] of writes.mock.calls) {
    if (command.checkAccess) expect(command.deadline).toBe(deadline);
  }
  decisionClock.mockRestore();
  if (change === 'writer') {
    await expect(reserve()).rejects.toThrow('Budget writer unavailable');
  } else {
    await reserve();
    expect(actor.state.reservations).toHaveLength(2);
  }
}
it.each(['unchanged', 'revoked', 'expired', 'writer'])(
  'checks every budget conflict and keeps the original deadline: %s',
  admitsAfterRepeatedConflicts);

async function remainsUsableAfterPublishDeadline() {
  const reservationId = await reserve(false, 'verify-late-publish');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'verify-late-publish', decisionId: 'verify-late-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const started = performance.now();
  const deadline = started + 2000;
  const decisionClock = vi.spyOn(performance, 'now');
  decisionClock.mockReturnValue(started);
  onTestFinished(decisionClock.mockRestore.bind(decisionClock));
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (checks === 2 || checks === 4) {
      const memberId = `late-unrelated-${checks}`;
      const payload = { memberId, email: `${memberId}@example.test`,
        displayName: 'Unrelated', role: 'member' };
      const event = envelope('test', `member-${memberId}`, 'member.joined', payload);
      const command = { event, expectedSequence: 0 };
      const saved = await nats.store.append(command);
      expect(saved.status).toBe('appended');
    }
    if (checks === 6) {
      // Let the last access check pass just before the store sees the deadline.
      decisionClock.mockReturnValue(deadline);
      decisionClock.mockReturnValueOnce(deadline - 0.001);
    }
    if (performance.now() >= deadline) throw new Error('Authority snapshot expired');
  }
  checkAccess.deadline = deadline;
  await expect(actor.admitDispatch(admission, checkAccess))
    .rejects.toThrow('Budget append unavailable');
  expect(performance.now()).toBe(deadline);
  decisionClock.mockRestore();
  expect(checks).toBe(6);
  expect(actor.state.dispatches).toHaveLength(0);
  const rows = await history(nats.store, 'budget-test', 'test');
  function isAdmission(row: typeof rows[number]) {
    return row.event.type === 'budget.call_dispatch_admitted';
  }
  expect(rows.filter(isAdmission)).toHaveLength(0);
  await reserve();
  expect(actor.state.reservations).toHaveLength(2);
}
it('keeps the writer usable when the original deadline expires before retry publish',
  remainsUsableAfterPublishDeadline);

async function refusesBeforeFirstPublish(boundary: string) {
  const reservationId = await reserve(false, 'first-publish-refused');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'first-publish-refused', decisionId: 'first-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const started = performance.now();
  const deadline = started + 2000;
  const decisionClock = vi.spyOn(performance, 'now');
  decisionClock.mockReturnValue(started);
  onTestFinished(decisionClock.mockRestore.bind(decisionClock));
  let checks = 0;
  function checkAccess() {
    checks += 1;
    if (boundary === 'before store' && checks === 1) {
      decisionClock.mockReturnValue(deadline);
      decisionClock.mockReturnValueOnce(deadline - 0.001);
    }
    if (checks === 2) {
      if (boundary === 'revoked') {
        throw new Error('Authority changed');
      }
      decisionClock.mockReturnValue(deadline);
    }
    if (performance.now() >= deadline) {
      throw new Error('Authority snapshot expired');
    }
    return Promise.resolve();
  }
  checkAccess.deadline = deadline;
  await expect(actor.admitDispatch(admission, checkAccess))
    .rejects.toThrow('Budget append unavailable');
  decisionClock.mockRestore();
  expect(checks).toBe(boundary === 'before store' ? 1 : 2);
  expect(actor.state.dispatches).toHaveLength(0);
  const rows = await history(nats.store, 'budget-test', 'test');
  function isAdmission(row: typeof rows[number]) {
    return row.event.type === 'budget.call_dispatch_admitted';
  }
  expect(rows.filter(isAdmission)).toHaveLength(0);
  await reserve();
  expect(actor.state.reservations).toHaveLength(2);
}
it.each(['before store', 'expired', 'revoked'])(
  'keeps the budget writer usable after refusal before the first publish: %s',
  refusesBeforeFirstPublish);

async function refusesAfterLostRepeatedPublishReply(change: string) {
  const faulty = await lostReplyStore(nats.connection);
  actor = new BudgetActor(faulty.store, 'test', now);
  await actor.start();
  const reservationId = await reserve(false, 'lost-repeated-publish');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'lost-repeated-publish', decisionId: 'lost-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const started = performance.now();
  const deadline = started + 2000;
  const decisionClock = vi.spyOn(performance, 'now');
  decisionClock.mockReturnValue(started);
  onTestFinished(decisionClock.mockRestore.bind(decisionClock));
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (checks === 2 || checks === 4) {
      const memberId = `lost-unrelated-${checks}`;
      const payload = { memberId, email: `${memberId}@example.test`,
        displayName: 'Unrelated member', role: 'member' };
      const event = envelope('test', `member-${memberId}`, 'member.joined', payload);
      const command = { event, expectedSequence: 0 };
      const saved = await nats.store.append(command);
      expect(saved.status).toBe('appended');
    }
    if (checks === 6) {
      faulty.loseNextReply();
    }
    if (checks === 7) {
      if (change === 'revoked') {
        throw new Error('Authority changed');
      }
      decisionClock.mockReturnValue(deadline);
    }
    if (performance.now() >= deadline) {
      throw new Error('Authority snapshot expired');
    }
  }
  checkAccess.deadline = deadline;
  await expect(actor.admitDispatch(admission, checkAccess))
    .rejects.toThrow('Budget append unavailable');
  decisionClock.mockRestore();
  expect(checks).toBe(7);
  expect(actor.state.dispatches).toHaveLength(0);
  const rows = await history(nats.store, 'budget-test', 'test');
  function isAdmission(row: typeof rows[number]) {
    return row.event.type === 'budget.call_dispatch_admitted';
  }
  expect(rows.filter(isAdmission)).toHaveLength(1);
  await expect(reserve()).rejects.toThrow('Budget writer lost its fence');
  await expect(reserve()).rejects.toThrow('Budget writer unavailable');
  await expect(actor.admitDispatch(admission, checkAccess))
    .rejects.toThrow('Budget writer unavailable');
}
it.each(['expired', 'revoked'])(
  'stops the writer when a repeated publish loses its reply before access is %s',
  refusesAfterLostRepeatedPublishReply);

async function keepsWriterAfterInvalidEvent() {
  await reserve();
  const call = { ...actor.state.reservations[0]!.call, computerId: '' };
  const before = await nats.store.head('budget-test');
  await expect(actor.reserve(call, 1)).rejects.toThrow('Invalid model event');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.reservations).toHaveLength(1);
  await reserve();
  expect(actor.state.reservations).toHaveLength(2);
}
it('keeps the writer usable when invalid event input is refused before publishing',
  keepsWriterAfterInvalidEvent);

async function keepsWriterAfterDuplicateId(afterConflict: boolean) {
  const commandId = 'colliding-budget-command';
  const payload = {
    scope: 'global', dailyCeilingCents: 200, ceilingCents: 200, setBy: 'alice',
  };
  async function saveMember(id: string) {
    const joined = { memberId: id, email: `${id}@example.test`,
      displayName: 'Unrelated member', role: 'member' };
    const event = envelope('test', `member-${id}`, 'member.joined', joined, id);
    const command = { event, expectedSequence: 0 };
    expect((await nats.store.append(command)).status).toBe('appended');
  }
  if (!afterConflict) {
    await saveMember(commandId);
  }
  const before = await nats.store.head('budget-test');
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (afterConflict && checks === 2) {
      await saveMember('unrelated-before-collision');
    }
    if (afterConflict && checks === 4) {
      await saveMember(commandId);
    }
  }
  checkAccess.deadline = performance.now() + 2000;
  const refused = actor.configure(payload, commandId, actor.state.sequence, checkAccess);
  await expect(refused).rejects.toThrow('Budget append rejected: duplicate_id');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.ceilingCents).toBe(100);
  await reserve();
  expect(actor.state.reservations).toHaveLength(1);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
}
it.each([false, true])(
  'keeps the writer usable after a duplicate id refusal (after conflict: %s)',
  keepsWriterAfterDuplicateId);

async function keepsWriterAfterStoreRejection() {
  const before = await nats.store.head('budget-test');
  const rejected = { status: 'rejected' as const, reason: 'invalid_event' as const };
  const writes = vi.spyOn(nats.store, 'appendOutcome').mockResolvedValueOnce(rejected);
  onTestFinished(writes.mockRestore.bind(writes));
  await expect(reserve()).rejects.toThrow('Budget append rejected: invalid_event');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.reservations).toHaveLength(0);
  await reserve();
  expect(actor.state.reservations).toHaveLength(1);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
}
it('keeps the writer usable after the store rejects an invalid event',
  keepsWriterAfterStoreRejection);

async function keepsWriterAfterAppendException(boundary: string) {
  const before = await nats.store.head('budget-test');
  const writes = vi.spyOn(nats.store, 'appendOutcome');
  const reads = vi.spyOn(nats.store, 'readStream');
  onTestFinished(writes.mockRestore.bind(writes));
  onTestFinished(reads.mockRestore.bind(reads));
  let message = 'Budget append contention';
  if (boundary === 'publish error') {
    message = 'Event append failed';
    writes.mockRejectedValueOnce(new Error(message));
  } else {
    writes.mockResolvedValueOnce({ status: 'conditional_rejection_unchanged' });
    if (boundary === 'read error') {
      message = 'Budget history unavailable';
      function failedRead(): ReturnType<typeof nats.store.readStream> {
        throw new Error(message);
      }
      reads.mockImplementationOnce(failedRead);
    }
  }
  await expect(reserve()).rejects.toThrow(message);
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.reservations).toHaveLength(0);
  await reserve();
  expect(actor.state.reservations).toHaveLength(1);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
}
it.each(['publish error', 'read error', 'unchecked contention'])(
  'keeps the writer usable after a request ends with %s', keepsWriterAfterAppendException);

async function keepsWriterAfterExactDuplicate() {
  const payload = {
    scope: 'global', dailyCeilingCents: 200, ceilingCents: 200, setBy: 'alice',
  };
  const original = await actor.configure(payload, 'same-budget-command');
  expect(original).toMatchObject({ status: 'appended' });
  const before = await nats.store.head('budget-test');
  expect(await actor.configure(payload, 'same-budget-command')).toEqual(original);
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.ceilingCents).toBe(200);
  await reserve();
  expect(actor.state.reservations).toHaveLength(1);
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1, monthCents: 0 });
}
it('returns the earlier result for an exact duplicate and keeps the writer usable',
  keepsWriterAfterExactDuplicate);

async function survivesKnownConflictReadTimeout() {
  const client = jetstream(nats.connection);
  const manager = await jetstreamManager(nats.connection);
  const probeStore = new EventStore(client, manager);
  const publish = client.publish.bind(client);
  const conflicts: number[] = [];
  async function recordConflict(...parameters: Parameters<typeof publish>) {
    try {
      return await publish(...parameters);
    } catch (error) {
      if (error instanceof JetStreamApiError) conflicts.push(error.code);
      throw error;
    }
  }
  client.publish = recordConflict;
  actor = new BudgetActor(probeStore, 'test', now);
  await actor.start();
  const reservationId = await reserve(false, 'known-conflict');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'known-conflict', decisionId: 'known-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const before = await nats.store.head('budget-test');
  const originalRead = probeStore.readStream.bind(probeStore);
  let refuseRead = false;
  let failedReads = 0;
  function readAfterConflict(...parameters: Parameters<typeof originalRead>) {
    if (refuseRead && parameters[0] === 'budget-test') {
      refuseRead = false;
      failedReads += 1;
      throw new TimeoutError();
    }
    return originalRead(...parameters);
  }
  const reader = vi.spyOn(probeStore, 'readStream');
  reader.mockImplementation(readAfterConflict);
  onTestFinished(reader.mockRestore.bind(reader));
  let checks = 0;
  async function checkAccess() {
    checks += 1;
    if (checks === 2) {
      const joined = { memberId: 'read-overlap', email: 'overlap@example.test',
        displayName: 'Unrelated member', role: 'member' };
      const event = envelope('test', 'member-read-overlap', 'member.joined', joined);
      const saved = await nats.store.append({ event, expectedSequence: 0 });
      expect(saved.status).toBe('appended');
      refuseRead = true;
    }
    if (checks === 3) {
      throw new Error('Authority changed');
    }
  }
  checkAccess.deadline = performance.now() + 2000;
  await expect(actor.admitDispatch(admission, checkAccess)).rejects.toThrow('Budget append unavailable');
  expect(conflicts).toHaveLength(1);
  expect([10071, 10164]).toContain(conflicts[0]);
  expect(failedReads).toBe(1);
  expect(checks).toBe(2);
  reader.mockRestore();
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.dispatches).toHaveLength(0);
  const recoveryReads = vi.spyOn(probeStore, 'readStream');
  onTestFinished(recoveryReads.mockRestore.bind(recoveryReads));
  await reserve();
  expect(recoveryReads).toHaveBeenCalledWith('budget-test', before + 1, expect.any(Number));
  expect(actor.state.reservations).toHaveLength(2);
}
it('keeps writer after confirmed conflict read timeout and access refusal',
  survivesKnownConflictReadTimeout);

async function keepsWriterAfterTransportFailure() {
  const before = await nats.store.head('budget-test');
  const cause = new TimeoutError();
  const result = { status: 'transport_failure' as const, cause, mayHavePublished: true };
  const writes = vi.spyOn(nats.store, 'appendOutcome').mockResolvedValueOnce(result);
  onTestFinished(writes.mockRestore.bind(writes));
  await expect(reserve()).rejects.toThrow('Budget append unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.reservations).toHaveLength(0);
  const reads = vi.spyOn(nats.store, 'readStream');
  onTestFinished(reads.mockRestore.bind(reads));
  function failRead(): ReturnType<typeof nats.store.readStream> {
    throw new TimeoutError();
  }
  reads.mockImplementationOnce(failRead);
  await expect(reserve()).rejects.toThrow(TimeoutError);
  expect(writes).toHaveBeenCalledTimes(1);
  await reserve();
  expect(reads).toHaveBeenCalledWith('budget-test', before + 1, expect.any(Number));
  expect(actor.state.reservations).toHaveLength(1);
  await actor.requireCurrent(performance.now() + 2000);
}
it('rechecks unknown transport state before the next request and keeps failed reads retryable',
  keepsWriterAfterTransportFailure);

async function keepsFallbackDeadline() {
  const reservationId = await reserve(false, 'fallback-deadline');
  const reservation = actor.state.reservations[0]!;
  const admission = { callId: 'fallback-deadline', decisionId: 'fallback-decision',
    bodyDigest: '0'.repeat(64), reservationId, modelCall: reservation.call };
  const started = performance.now();
  const decisionClock = vi.spyOn(performance, 'now').mockReturnValue(started);
  onTestFinished(decisionClock.mockRestore.bind(decisionClock));
  const writes = vi.spyOn(nats.store, 'appendOutcome');
  onTestFinished(writes.mockRestore.bind(writes));
  writes.mockResolvedValueOnce({ status: 'conditional_rejection_unchanged' });
  let checks = 0;
  function checkAccess() {
    checks += 1;
    if (checks === 2) decisionClock.mockReturnValue(started + 2000);
    return Promise.resolve();
  }
  await expect(actor.admitDispatch(admission, checkAccess))
    .rejects.toThrow('Authority snapshot expired');
  expect(checks).toBe(2);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes.mock.calls[0]![0].deadline).toBe(started + 2000);
  expect(actor.state.dispatches).toHaveLength(0);
  decisionClock.mockRestore();
  await reserve();
  expect(actor.state.reservations).toHaveLength(2);
}
it('keeps the fallback two-second deadline and checks expiry after the callback returns',
  keepsFallbackDeadline);

async function refusesForeignSwitchOn(field: 'silo' | 'subject') {
  const before = await nats.store.head('budget-test');
  const payload = { providerId: 'primary', revision: 1, changedBy: 'alice',
    expectedProviderSequence: 0 };
  const original = envelope('test', 'budget-test', 'provider.managed_calls_enabled', payload);
  const event = { ...original, [field]: field === 'silo' ? 'foreign' : 'budget-foreign' };
  async function* foreignRow() {
    const row = { sequence: before + 1, event };
    yield await Promise.resolve(row);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementationOnce(foreignRow);
  const writes = vi.spyOn(nats.store, 'appendOutcome');
  writes.mockResolvedValueOnce({ status: 'conditional_rejection_changed' });
  onTestFinished(reads.mockRestore.bind(reads));
  onTestFinished(writes.mockRestore.bind(writes));
  await expect(reserve()).rejects.toThrow('Budget writer lost its fence');
  await expect(reserve()).rejects.toThrow('Budget writer unavailable');
  expect(await nats.store.head('budget-test')).toBe(before);
  expect(actor.state.reservations).toHaveLength(0);
}
it.each(['silo', 'subject'] as const)(
  'stops a writer when switch-on recovery returns a foreign %s', refusesForeignSwitchOn);
