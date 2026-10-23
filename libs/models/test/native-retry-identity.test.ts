import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope, history, priceTableId } from '../src/index.ts';
import { grantModelCall } from '../src/call-retry.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let actor: BudgetActor;
const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'root-turn',
  threadId: 'root-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'group', allowanceCents: 1000 };
const modelCall = { requesterId: 'alice', conversationId: 'conversation',
  assistantId: 'assistant', computerId: 'computer', generation: 1, payingGroupId: 'group',
  turnId: 'child-turn', threadId: 'child-thread', model: 'gpt-6-luna', priceTableId,
  providerId: 'provider', bindingSequence: 1, contextDigest: '0'.repeat(64),
  requestId: 'original' };
async function fresh() {}
function interrupted(): Promise<string> {
  throw new Error('Decision not saved');
}
async function setup() {
  nats = await natsFixture();
  actor = new BudgetActor(nats.store, 'test');
  await actor.start(10_000, 10_000, 'group');
  await actor.setRootAllowance(binding, 1);
}
async function close() {
  vi.restoreAllMocks();
  await nats.close();
}
beforeEach(setup);
afterEach(close);

function nativeCall() {
  const rootTurn = { turnId: binding.turnId, threadId: binding.threadId };
  return { callId: 'verified-call', rootId: actor.state.roots[0]!.rootId,
    rootTurn, accessExpiresAt: Date.now() + 2000 };
}
async function keepsNativeIdentity(field: string) {
  const reserve = vi.spyOn(actor, 'reserve');
  reserve.mockRejectedValue(new Error('Inspect identity before binding validation'));
  const native = nativeCall();
  await expect(grantModelCall(actor, modelCall, 10, 'body', fresh, undefined,
    interrupted, native)).rejects.toThrow('Model call retry refused');
  const original = reserve.mock.calls[0]![5]!;
  const changedCall = { ...modelCall, requestId: 'replacement' };
  let amountCents = 10;
  let raw = 'body';
  if (field === 'rootId') {
    native.rootId = 'other-root';
  } else if (field === 'root turn') {
    native.rootTurn.turnId = 'other-turn';
  } else if (field === 'root thread') {
    native.rootTurn.threadId = 'other-thread';
  } else if (field === 'body') {
    raw = 'different bytes';
  } else if (field === 'amount') {
    amountCents = 11;
  } else if (field === 'generation') {
    changedCall.generation = 2;
  } else if (field === 'bindingSequence') {
    changedCall.bindingSequence = 2;
  } else if (field === 'expiry') {
    native.accessExpiresAt++;
  } else {
    Reflect.set(changedCall, field, 'changed');
  }
  await expect(grantModelCall(actor, changedCall, amountCents, raw, fresh, undefined,
    interrupted, native)).rejects.toThrow('Model call retry refused');
  expect(reserve.mock.calls[1]![5]!.retryDigest).toBe(original.retryDigest);
}
it.each(['rootId', 'root turn', 'root thread', 'body', 'amount', 'generation', 'model',
  'priceTableId', 'payingGroupId', 'providerId', 'bindingSequence', 'turnId', 'threadId',
  'computerId', 'assistantId', 'requesterId', 'conversationId', 'contextDigest', 'requestId',
  'expiry'])('keeps native identity independent of %s before binding validation', keepsNativeIdentity);

async function scopesNativeIdentity(silo: string, expected: string) {
  const reserve = vi.spyOn(actor, 'reserve');
  reserve.mockRejectedValue(new Error('Inspect identity before binding validation'));
  Reflect.set(actor, 'silo', silo);
  await expect(grantModelCall(actor, modelCall, 10, 'body', fresh, undefined,
    interrupted, nativeCall())).rejects.toThrow('Model call retry refused');
  expect(reserve.mock.calls[0]![5]!.retryDigest).toBe(expected);
}
it.each([
  ['test', '090873dc74d576e537ed44cc788afdfbc56d29112dfb9d6d6189c541c3069b2a'],
  ['other', 'eeec792bb0388fb7783595f7f8c8ae50fa30c883068aade714d20b0cc7cc8dda'],
])('binds native identity to the namespace and silo %s', scopesNativeIdentity);

async function refusesValidReplacement(field: string) {
  const native = nativeCall();
  await expect(grantModelCall(actor, modelCall, 10, 'body', fresh, undefined,
    interrupted, native)).rejects.toThrow('Model call retry refused');
  const saved = actor.state.reservations[0]!;
  const alternative = { ...modelCall, requestId: 'alternative' };
  let amountCents = 10;
  if (field === 'generation') {
    alternative.generation = 2;
  } else if (field === 'model') {
    alternative.model = 'gpt-6-astra';
  } else if (field === 'bindingSequence') {
    alternative.bindingSequence = 2;
  } else if (field === 'amount') {
    amountCents = 11;
  } else if (field === 'contextDigest') {
    alternative.contextDigest = '1'.repeat(64);
  } else if (field !== 'root') {
    Reflect.set(alternative, field, 'alternative');
  }
  const alternativeBinding = { ...binding, requesterId: alternative.requesterId,
    conversationId: alternative.conversationId, assistantId: alternative.assistantId,
    computerId: alternative.computerId, generation: alternative.generation,
    payingGroupId: alternative.payingGroupId, turnId: 'alternative-root' };
  const otherRoot = await actor.setRootAllowance(alternativeBinding, 1);
  const rootTurn = { turnId: otherRoot.turnId, threadId: otherRoot.threadId };
  const competing = { ...native, rootId: otherRoot.rootId, rootTurn };
  async function allow(reservationId: string, requestId: string) {
    const payload = { requestId, route: 'model', outcome: 'allow', reason: 'model_allowed',
      contextDigest: alternative.contextDigest, permitId: reservationId };
    const event = envelope('test', `decision-${requestId}`, 'decision.recorded', payload);
    await nats.seed([event]);
    return event.id;
  }
  const before = await nats.store.head();
  await expect(grantModelCall(actor, alternative, amountCents, 'body', fresh, undefined,
    allow, competing)).rejects.toThrow('Model call retry refused');
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.reservations).toHaveLength(1);
  expect(saved.settledCents).toBeUndefined();
  expect(actor.state.dispatches).toHaveLength(0);
  const originalDecisions = await history(nats.store, `decision-${saved.call.requestId}`, 'test');
  expect(originalDecisions).toHaveLength(0);
  // Prove the replacement itself is valid when it belongs to a different call.
  const separate = { ...competing, callId: 'different-verified-call' };
  const granted = await grantModelCall(actor, alternative, amountCents, 'body', fresh,
    undefined, allow, separate);
  expect(granted.reservationId).not.toBe(saved.id);
  expect(actor.state.reservations).toHaveLength(2);
  expect(actor.state.dispatches).toHaveLength(1);
  expect(actor.state.dispatches[0]?.reservationId).toBe(granted.reservationId);
  expect(saved.settledCents).toBeUndefined();
}
it.each(['root', 'generation', 'payingGroupId', 'model', 'providerId', 'bindingSequence',
  'turnId', 'threadId', 'computerId', 'assistantId', 'requesterId', 'conversationId',
  'contextDigest', 'amount'])(
  'refuses an otherwise valid competing native %s without a second hold', refusesValidReplacement);

async function refusesUndatedNativeHold() {
  const native = nativeCall();
  const retry = {
    retryDigest: '090873dc74d576e537ed44cc788afdfbc56d29112dfb9d6d6189c541c3069b2a',
    bodyDigest: '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5',
  };
  const reservationId = await actor.reserve(modelCall, 10, fresh, undefined,
    native.rootId, retry, native.rootTurn);
  const recovered = new BudgetActor(nats.store, 'test');
  await recovered.start();
  const allow = vi.fn(interrupted);
  const before = await nats.store.head();
  await expect(grantModelCall(recovered, modelCall, 10, 'body', fresh, undefined,
    allow, native)).rejects.toThrow('Model call retry refused');
  expect(allow).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
  expect(recovered.state.reservations).toHaveLength(1);
  expect(recovered.state.reservations[0]).toMatchObject({ id: reservationId, amountCents: 10 });
  expect(recovered.state.reservations[0]?.settledCents).toBeUndefined();
  expect(recovered.state.dispatches).toHaveLength(0);
}
it('refuses an older native hold without its original access expiry after replay',
  refusesUndatedNativeHold);

async function expiresDuringDecisionRead() {
  const native = nativeCall();
  await expect(grantModelCall(actor, modelCall, 10, 'body', fresh, undefined,
    interrupted, native)).rejects.toThrow('Model call retry refused');
  const saved = actor.state.reservations[0]!;
  let currentTime = native.accessExpiresAt - 300;
  function wallClock() {
    return currentTime;
  }
  const clock = vi.spyOn(Date, 'now');
  clock.mockImplementation(wallClock);
  const read = nats.store.readStream.bind(nats.store);
  async function* delayedRead(...args: Parameters<typeof read>) {
    yield* read(...args);
    if (args[0] === `decision-${saved.call.requestId}`) {
      currentTime += 400;
    }
  }
  const reader = vi.spyOn(nats.store, 'readStream');
  reader.mockImplementation(delayedRead);
  const allow = vi.fn(interrupted);
  const before = await nats.store.head();
  await expect(grantModelCall(actor, modelCall, 10, 'body', fresh, undefined,
    allow, native)).rejects.toThrow('Model call retry refused');
  expect(allow).not.toHaveBeenCalled();
  expect(await nats.store.head()).toBe(before);
  expect(actor.state.reservations).toHaveLength(1);
  expect(saved.settledCents).toBeUndefined();
  expect(actor.state.dispatches).toHaveLength(0);
}
it('refuses decision saving when reading its history crosses the original expiry',
  expiresDuringDecisionRead);
