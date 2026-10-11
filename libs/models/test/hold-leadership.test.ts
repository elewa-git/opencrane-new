import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history, priceTableId, totals } from '../src/index.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
const baseTime = Date.parse('2026-10-05T12:00:00Z');
const call = {
  requestId: 'request', model: 'gpt-6-luna', priceTableId,
  computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
  conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
  payingGroupId: 'group', contextDigest: '0'.repeat(64),
};

async function initialise() {
  nats = await natsFixture();
}

async function close() {
  vi.restoreAllMocks();
  await nats.close();
}

beforeEach(initialise);
afterEach(close);

function oldClock() {
  return new Date(baseTime);
}

function skewedClock() {
  return new Date(baseTime + 181_000);
}

async function allow(reservationId: string) {
  const payload = {
    requestId: 'request', route: 'model', outcome: 'allow', reason: 'model_allowed',
    contextDigest: '0'.repeat(64), permitId: reservationId,
  };
  const event = envelope('test', 'decision-request', 'decision.recorded', payload);
  const command = { event, expectedSequence: 0 };
  expect((await nats.store.append(command)).status).toBe('appended');
}

function afterDecisionRead(between: () => Promise<void>) {
  const read = nats.store.readStream.bind(nats.store);
  let interrupted = false;

  async function* interruptedRead(...args: Parameters<typeof read>) {
    const interrupt = !interrupted && args[0].startsWith('effect-');
    if (interrupt) {
      interrupted = true;
    }
    for await (const row of read(...args)) {
      yield row;
    }
    if (interrupt) {
      await between();
    }
  }

  const reader = vi.spyOn(nats.store, 'readStream');
  reader.mockImplementation(interruptedRead);
  return reader;
}

function fresh() {
  return Promise.resolve();
}

async function restoresHoldAfterLeaderChange() {
  const oldLeader = new BudgetActor(nats.store, 'test', oldClock);
  await oldLeader.start(1000, 1000, 'group');
  const reservationId = await oldLeader.reserve(call, 500);
  const newLeader = new BudgetActor(nats.store, 'test', skewedClock);
  await newLeader.start();
  let permitReturned = false;

  async function admitDuringExpiry() {
    await allow(reservationId);
    await expect(oldLeader.admitDispatch({ callId: 'request', decisionId: 'decision',
      bodyDigest: '0'.repeat(64), reservationId, modelCall: call }, fresh)).rejects.toThrow('lost its fence');
    permitReturned = false;
  }

  const reader = afterDecisionRead(admitDuringExpiry);
  await newLeader.expire();
  reader.mockRestore();
  expect(permitReturned).toBe(false);
  expect(totals(newLeader.state, skewedClock())).toMatchObject({ reservedCents: 0 });
  await newLeader.uncertain(reservationId, 'transport_failure');
  expect(totals(newLeader.state, skewedClock())).toMatchObject({
    reservedCents: 500, monthCents: 0,
  });
  const recovered = new BudgetActor(nats.store, 'test', skewedClock);
  await recovered.start();
  expect(totals(recovered.state, skewedClock())).toMatchObject({ reservedCents: 500 });
  const effects = await history(nats.store, `effect-${reservationId}`, 'test');
  expect(effects[0]?.event.data).toMatchObject({ reason: 'transport_failure' });
  expect(await history(nats.store, `security-${reservationId}`, 'test')).toEqual([]);
}

it('refuses a stale leader during expiry and keeps late evidence held',
  restoresHoldAfterLeaderChange);

async function refusesPermitOnSameActor() {
  let clock = oldClock();
  function now() {
    return clock;
  }
  const actor = new BudgetActor(nats.store, 'test', now);
  await actor.start(1000, 1000, 'group');
  const reservationId = await actor.reserve(call, 500);
  clock = skewedClock();
  let permit: Promise<void> | undefined;

  async function enqueueAdmissionDuringExpiry() {
    await allow(reservationId);
    permit = actor.admitDispatch({ callId: 'request', decisionId: 'decision',
      bodyDigest: '0'.repeat(64), reservationId, modelCall: call }, fresh);
    // Handle the queued refusal immediately so it cannot become an unhandled rejection.
    void permit.catch(ignoreExpectedRefusal);
  }

  const reader = afterDecisionRead(enqueueAdmissionDuringExpiry);
  await actor.expire();
  reader.mockRestore();
  expect(permit).toBeDefined();
  await expect(permit).rejects.toThrow('Reservation is no longer open');
  expect(totals(actor.state, clock)).toMatchObject({ reservedCents: 0, monthCents: 0 });
}

function ignoreExpectedRefusal() {
  return undefined;
}

it('refuses a permit queued after expiry on the same actor', refusesPermitOnSameActor);
