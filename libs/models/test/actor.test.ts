import { EgressRelayRegistry, type EgressCloseRecord } from '../src/egress-relay.ts';
import { jetstreamManager } from '@nats-io/jetstream';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { countReads, expectNoWholeReads, lostReplyStore, natsFixture } from '@opencrane/event-store/testing';
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
  const append = nats.store.append.bind(nats.store);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  async function holdReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    entered.resolve();
    await release.promise;
    return result;
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(holdReply);
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
  const cause = new Error('private-canary');
  function unavailable() {
    return Promise.resolve({ status: 'unavailable' as const, cause });
  }
  const spy = vi.spyOn(nats.store, 'append').mockImplementation(unavailable);
  onTestFinished(spy.mockRestore.bind(spy));
  await expect(reserve()).rejects.toThrow('Budget writer lost its fence');
  spy.mockRestore();
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
  onTestFinished(decisionClock.mockRestore);
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
