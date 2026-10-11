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
