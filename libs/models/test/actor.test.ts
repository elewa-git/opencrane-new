import { afterEach, beforeEach, expect, it } from 'vitest';
import { countReads, expectNoWholeReads, lostReplyStore, natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history, priceTableId, totals } from '../src/index.ts';

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

async function reserve(provider = false, requestId?: string) {
  const call = {
    requestId, model: 'gpt-6-luna', priceTableId,
    computerId: provider ? 'provider-primary' : 'computer',
    assistantId: provider ? 'provider-verification' : 'assistant',
    requesterId: 'alice', conversationId: provider ? 'provider-primary' : 'conversation',
    turnId: 'attempt', threadId: 'attempt', payingGroupId: 'group',
    contextDigest: '0'.repeat(64),
  };
  return actor.reserve(call, 1);
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
  const reservationId = await reserve(provider, 'request');
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

async function keepsLegacyHold() {
  const reservationId = await reserve(false, undefined);
  await expire();
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 1 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects[0]?.event.type).toBe('effect.uncertain');
}

it('keeps a hold from before request ids were recorded uncertain', keepsLegacyHold);

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
  expect(await actor.configure(payload, 'configure-once')).toEqual({ status: 'appended' });
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
