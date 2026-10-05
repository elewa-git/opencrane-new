import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
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
  expect(await history(nats.store, `security-${reservationId}`, 'test')).toEqual([]);
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
