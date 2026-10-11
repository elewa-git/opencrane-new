import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, history, priceTableId, totals } from '../src/index.ts';
import { fixture } from './fixture.ts';

const call = {
  requestId: 'request', model: 'gpt-6-luna', priceTableId,
  computerId: 'computer', assistantId: 'assistant', requesterId: 'alice',
  conversationId: 'conversation', turnId: 'turn', threadId: 'thread',
  payingGroupId: 'group', contextDigest: '0'.repeat(64),
};
function admission(reservationId: string) {
  return { callId: 'request', decisionId: 'decision', bodyDigest: '1'.repeat(64),
    reservationId, modelCall: call };
}
async function fresh() {}
function restoreMocks() {
  vi.restoreAllMocks();
}
afterEach(restoreMocks);

async function blocksQueuedCall() {
  const setup = await fixture();
  const close = setup.close.bind(setup);
  onTestFinished(close);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let exhausted = false;
  async function exhaustAfterAudit(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'decision.recorded' && !exhausted) {
      exhausted = true;
      const exhaustingCall = { ...call, payingGroupId: 'personal-default', turnId: 'exhausting' };
      await expect(setup.actor.reserve(exhaustingCall, 20_001)).rejects.toThrow('spending cap');
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(exhaustAfterAudit);
  expect((await setup.call()).status).toBe(503);
  expect(exhausted).toBe(true);
  expect(setup.received()).toBe(0);
  setup.advance();
  await setup.actor.expire();
  expect(setup.actor.state.reservations[0]?.settledCents).toBe(0);
}

it('blocks a reserved model call stopped before the final gate and releases its unsent hold',
  blocksQueuedCall);

async function stopsAfterHandoff() {
  const setup = await fixture();
  const close = setup.close.bind(setup);
  onTestFinished(close);
  const admit = setup.actor.admitDispatch.bind(setup.actor);
  async function stopBeforeReply(...args: Parameters<typeof admit>) {
    await admit(...args);
    const limit = { scope: 'global', ceilingCents: 0, setBy: 'alice' };
    await setup.actor.configure(limit);
  }
  const sender = vi.spyOn(setup.actor, 'admitDispatch');
  sender.mockImplementation(stopBeforeReply);
  expect((await setup.call()).status).toBe(200);
  expect(setup.received()).toBe(1);
  const rows = await history(setup.nats.store, 'budget-test', 'test');
  function isAdmission(row: (typeof rows)[number]) {
    return row.event.type === 'budget.call_dispatch_admitted';
  }
  expect(rows.filter(isAdmission)).toHaveLength(1);
}

it('sends once when exhaustion follows the successful final gate', stopsAfterHandoff);

async function keepsLostGateHold() {
  const setup = await fixture();
  const close = setup.close.bind(setup);
  onTestFinished(close);
  const append = setup.nats.store.append.bind(setup.nats.store);
  async function loseReply(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'budget.call_dispatch_admitted') {
      return { status: 'unavailable' as const, cause: new Error('Lost admission reply') };
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(loseReply);
  expect((await setup.call()).status).toBe(503);
  expect(setup.received()).toBe(0);
  writer.mockRestore();
  setup.advance();
  const recovered = new BudgetActor(setup.nats.store, 'test', setup.actor.now);
  await recovered.start();
  await recovered.expire();
  expect(totals(recovered.state, recovered.now()).reservedCents).toBeGreaterThan(0);
  const saved = recovered.state.dispatches[0]!;
  await expect(recovered.admitDispatch(saved, fresh)).rejects.toThrow('already admitted');
  await expect(recovered.releaseUndispatched(saved.reservationId!))
    .rejects.toThrow('may have been dispatched');
  expect(setup.received()).toBe(0);
}

it('keeps a lost gate reply held after replay and gives a duplicate no send permission',
  keepsLostGateHold);

async function ordersExpiry(first: 'expiry' | 'dispatch') {
  const nats = await natsFixture();
  let clock = new Date('2026-10-10T12:00:00Z');
  function now() {
    return clock;
  }
  const actor = new BudgetActor(nats.store, 'test', now);
  try {
    await actor.start(10, 10, 'group');
    const reservationId = await actor.reserve(call, 10);
    const input = admission(reservationId);
    if (first === 'dispatch') {
      await actor.admitDispatch(input, fresh);
    }
    clock = new Date(clock.getTime() + 181_000);
    await actor.expire();
    if (first === 'expiry') {
      await expect(actor.admitDispatch(input, fresh)).rejects.toThrow('no longer open');
      expect(totals(actor.state, clock).reservedCents).toBe(0);
    } else {
      await expect(actor.admitDispatch(input, fresh)).rejects.toThrow('already admitted');
      expect(totals(actor.state, clock).reservedCents).toBe(10);
    }
  } finally {
    await nats.close();
  }
}
it.each(['expiry', 'dispatch'] as const)('orders %s before the other operation', ordersExpiry);

async function refusesUnknownReservation() {
  const nats = await natsFixture();
  const close = nats.close.bind(nats);
  onTestFinished(close);
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(10, 10, 'group');
  await expect(actor.admitDispatch(admission('missing'), fresh))
    .rejects.toThrow('no longer open');
  expect(actor.state.dispatches).toEqual([]);
  expect(actor.state.reservations).toEqual([]);
}
it('refuses an unknown reservation without needing a settled hold', refusesUnknownReservation);

async function refusesIndependentDuplicate(key: 'call' | 'hold') {
  const nats = await natsFixture();
  const close = nats.close.bind(nats);
  onTestFinished(close);
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(10, 10, 'group');
  const modelCall = { ...call, requestId: undefined };
  const firstHold = await actor.reserve(modelCall, 1);
  const first = { ...admission(firstHold), modelCall };
  await actor.admitDispatch(first, fresh);
  let duplicate = { ...first, callId: 'different-call' };
  if (key === 'call') {
    const secondHold = await actor.reserve(modelCall, 1);
    duplicate = { ...first, reservationId: secondHold };
  }
  await expect(actor.admitDispatch(duplicate, fresh)).rejects.toThrow('already admitted');
  expect(actor.state.dispatches).toHaveLength(1);
}
it.each(['call', 'hold'] as const)('refuses the duplicate %s key independently',
  refusesIndependentDuplicate);

async function refusesCurrentCapacity(accessRevoked: boolean) {
  const nats = await natsFixture();
  const close = nats.close.bind(nats);
  onTestFinished(close);
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(10, 10, 'group');
  const held = await actor.reserve(call, 4);
  const otherCall = { ...call, requestId: undefined, turnId: 'other-turn' };
  const charged = await actor.reserve(otherCall, 1);
  await actor.effect(charged, { inputTokens: 1_000_000, outputTokens: 0 });
  const effects = await history(nats.store, `effect-${charged}`, 'test');
  await actor.settleRecorded(charged, effects[0]!.event.id);
  expect(totals(actor.state)).toMatchObject({ reservedCents: 4, monthCents: 19 });
  expect(actor.state.stops).toEqual([]);
  const before = await nats.store.head('budget-test');
  let accessChecked = false;
  async function currentAccess() {
    accessChecked = true;
    if (accessRevoked) {
      throw new Error('Access revoked');
    }
  }
  let reason = 'spending cap';
  if (accessRevoked) {
    reason = 'Access revoked';
  }
  await expect(actor.admitDispatch(admission(held), currentAccess)).rejects.toThrow(reason);
  expect(accessChecked).toBe(true);
  expect(actor.state.dispatches).toEqual([]);
  expect(totals(actor.state)).toMatchObject({ reservedCents: 4, monthCents: 19 });
  if (accessRevoked) {
    expect(await nats.store.head('budget-test')).toBe(before);
    expect(actor.state.stops).toEqual([]);
  } else {
    expect(actor.state.stops).toHaveLength(1);
    expect(actor.state.stoppedWork).toEqual([
      { conversationId: 'conversation', turnId: 'turn', stopId: actor.state.stops[0]!.id },
      { conversationId: 'conversation', turnId: 'other-turn',
        stopId: actor.state.stops[0]!.id },
    ]);
  }
}
it.each([false, true])('checks capacity before admission without a saved stop (revoked: %s)',
  refusesCurrentCapacity);

async function closesExpiredLegacyModelHold() {
  const setup = await fixture();
  const close = setup.close.bind(setup);
  onTestFinished(close);
  const append = setup.nats.store.append.bind(setup.nats.store);
  let expired = false;
  async function expireLegacyAfterAudit(command: Parameters<typeof append>[0]) {
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'budget.reserved') {
      const legacy = { ...parsed.event.data };
      delete legacy.dispatchGate;
      command.event.data = legacy;
    }
    const result = await append(command);
    if (parsed.success && parsed.event.type === 'decision.recorded' && !expired) {
      expired = true;
      expect(setup.actor.state.reservations[0]?.dispatchGate).toBeUndefined();
      setup.advance();
      await setup.actor.expire();
    }
    return result;
  }
  const writer = vi.spyOn(setup.nats.store, 'append');
  writer.mockImplementation(expireLegacyAfterAudit);
  expect((await setup.call()).status).toBe(503);
  expect(expired).toBe(true);
  expect(setup.received()).toBe(0);
  writer.mockRestore();
  const reservation = setup.actor.state.reservations[0]!;
  expect(reservation.settledCents).toBeUndefined();
  const beforeExpiry = new Date(reservation.time);
  function replayClock() {
    return beforeExpiry;
  }
  const recovered = new BudgetActor(setup.nats.store, 'test', replayClock);
  await recovered.start();
  const input = { ...admission(reservation.id), callId: reservation.call.requestId!,
    modelCall: reservation.call };
  await expect(recovered.admitDispatch(input, fresh)).rejects.toThrow('no longer open');
  expect(totals(recovered.state, replayClock()).reservedCents).toBe(reservation.amountCents);
  expect(recovered.state.dispatches).toEqual([]);
  expect(setup.received()).toBe(0);
}
it('closes an expired legacy model hold before admission and after replay with an earlier clock',
  closesExpiredLegacyModelHold);
