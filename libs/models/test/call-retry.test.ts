import { parseEventByType } from '@opencrane/events';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { readBudget, history } from '../src/index.ts';
import { rootTotals } from '../src/root-budget.ts';
import { fixture } from './fixture.ts';
import { managedFixture } from './managed-fixture.ts';

const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', allowanceCents: 1000 };
async function setup() {
  const context = await fixture();
  const close = context.close.bind(context);
  onTestFinished(close);
  await context.actor.setRootAllowance(binding, 1);
  return context;
}
function restore() {
  vi.restoreAllMocks();
}
afterEach(restore);

async function recoversHold(restart: boolean) {
  const context = await setup();
  const reserve = context.actor.reserve.bind(context.actor);
  async function loseHoldReply(...args: Parameters<typeof reserve>): Promise<string> {
    await reserve(...args);
    throw new Error('Lost hold reply');
  }
  const writer = vi.spyOn(context.actor, 'reserve');
  writer.mockImplementationOnce(loseHoldReply);
  expect((await context.call()).status).not.toBe(200);
  expect(context.received()).toBe(0);
  const saved = context.actor.state.reservations[0]!;
  if (restart) await context.restartActor();
  expect((await context.call({ 'x-request-id': 'caller-cannot-select' })).status).toBe(200);
  expect(context.received()).toBe(1);
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.dispatches).toHaveLength(1);
  expect(context.actor.state.dispatches[0]).toMatchObject({
    reservationId: saved.id, callId: saved.call.requestId });
  const decisions = await history(context.nats.store, `decision-${saved.call.requestId}`, 'test');
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.event.data).toMatchObject({ outcome: 'allow', permitId: saved.id });
  expect(saved.bodyDigest).toBe(
    '455534a3697bb0394d6711bf54a419f329b6a47616e9bf571bdad68116dc5467');
  await context.settled();
  expect(context.admitted).toEqual([saved.call.requestId]);
  const projected = await readBudget(context.db, 'test');
  expect(projected.reservations[0]).toMatchObject({
    retryDigest: saved.retryDigest, bodyDigest: saved.bodyDigest, settledCents: 1 });
  expect(rootTotals(context.actor.state, context.actor.state.roots[0]!.rootId))
    .toMatchObject({ settledCents: 1, heldCents: 0 });
}
it.each([false, true])('recovers the same unsent hold and original decision; restart=%s', recoversHold);

async function fresh() {}
async function unsent() {
  const context = await setup();
  function loseBeforeAdmission(): Promise<void> {
    throw new Error('Admission unavailable');
  }
  const admission = vi.spyOn(context.actor, 'admitDispatch');
  admission.mockImplementationOnce(loseBeforeAdmission);
  expect((await context.call()).status).toBe(503);
  expect(context.received()).toBe(0);
  return context;
}
async function reusesDecision() {
  const context = await unsent();
  const saved = context.actor.state.reservations[0]!;
  const subject = `decision-${saved.call.requestId}`;
  const position = await context.nats.store.head(subject);
  expect((await context.call()).status).toBe(200);
  expect(await context.nats.store.head(subject)).toBe(position);
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.dispatches[0]?.callId).toBe(saved.call.requestId);
  await context.settled();
}
it('reuses the original allow decision after a failure before dispatch admission', reusesDecision);

async function concurrentRetries(restart: boolean) {
  const context = restart ? await unsent() : await setup();
  if (restart) await context.restartActor();
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const reserve = context.actor.reserve.bind(context.actor);
  let calls = 0;
  async function pauseAfterHold(...args: Parameters<typeof reserve>) {
    const result = await reserve(...args);
    calls++;
    if (calls === 2) arrived.resolve();
    await release.promise;
    return result;
  }
  const writer = vi.spyOn(context.actor, 'reserve');
  writer.mockImplementation(pauseAfterHold);
  const first = context.call();
  const second = context.call();
  await arrived.promise;
  release.resolve();
  const replies = await Promise.all([first, second]);
  function sent(reply: typeof replies[number]) {
    return reply.status === 200;
  }
  expect(replies.filter(sent)).toHaveLength(1);
  expect(context.received()).toBe(1);
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.dispatches).toHaveLength(1);
  await context.settled();
}
it.each([false, true])('orders concurrent sends through one hold and admission; restart=%s',
  concurrentRetries);

async function changedBinding(field: 'priceTableId' | 'contextDigest' | 'payingGroupId') {
  const context = await unsent();
  const saved = context.actor.state.reservations[0]!;
  const call = { ...saved.call, [field]: 'changed', requestId: 'new-request' };
  const retry = { retryDigest: saved.retryDigest!, bodyDigest: saved.bodyDigest! };
  const position = await context.nats.store.head();
  await expect(context.actor.reserve(call, saved.amountCents, fresh, undefined, saved.rootId, retry))
    .rejects.toThrow('Model call retry refused');
  expect(await context.nats.store.head()).toBe(position);
  expect(saved.settledCents).toBeUndefined();
}
it.each(['priceTableId', 'contextDigest', 'payingGroupId'] as const)(
  'refuses a retry with changed %s without appending or releasing', changedBinding);

async function changedAdmission(field: 'bodyDigest' | 'callId' | 'rootId') {
  const context = await unsent();
  const saved = context.actor.state.reservations[0]!;
  const input = { callId: saved.call.requestId!, decisionId: 'decision',
    bodyDigest: saved.bodyDigest!, reservationId: saved.id, modelCall: saved.call,
    rootId: saved.rootId!, [field]: 'a'.repeat(64) };
  const position = await context.nats.store.head();
  await expect(context.actor.admitDispatch(input, fresh)).rejects.toThrow('binding changed');
  expect(await context.nats.store.head()).toBe(position);
  expect(saved.settledCents).toBeUndefined();
}
it.each(['bodyDigest', 'callId', 'rootId'] as const)(
  'refuses an admission with changed %s without appending or releasing', changedAdmission);

async function refusesUnknown(kind: 'lost' | 'lost_append' | '504') {
  const context = await setup();
  if (kind === 'lost') {
    const admit = context.actor.admitDispatch.bind(context.actor);
    async function loseReply(...args: Parameters<typeof admit>) {
      await admit(...args);
      throw new Error('Lost admission reply');
    }
    const admission = vi.spyOn(context.actor, 'admitDispatch');
    admission.mockImplementationOnce(loseReply);
  } else if (kind === 'lost_append') {
    const append = context.nats.store.append.bind(context.nats.store);
    async function loseAppendReply(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      const parsed = parseEventByType(command.event);
      if (parsed.success && parsed.event.type === 'budget.call_dispatch_admitted') {
        return { status: 'unavailable' as const, cause: new Error('Lost append reply') };
      }
      return result;
    }
    const writer = vi.spyOn(context.nats.store, 'append');
    writer.mockImplementation(loseAppendReply);
  } else {
    context.reject(504);
  }
  expect((await context.call()).status).not.toBe(200);
  await context.restartActor();
  const position = await context.nats.store.head();
  const held = context.actor.state.reservations[0]!;
  expect((await context.call()).status).not.toBe(200);
  expect(await context.nats.store.head()).toBe(position);
  expect(context.received()).toBe(kind === '504' ? 1 : 0);
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.dispatches).toHaveLength(1);
  expect(rootTotals(context.actor.state, held.rootId!)).toMatchObject({
    settledCents: 0, heldCents: held.amountCents });
}
it.each(['lost', 'lost_append', '504'] as const)('keeps an admitted hold after %s and refuses resend', refusesUnknown);

async function refusesEvidence(kind: 'effect' | 'security' | 'settled' | 'expired' | 'unknown') {
  const context = await unsent();
  await context.stopDispatch();
  const saved = context.actor.state.reservations[0]!;
  if (kind === 'effect') {
    const payload = { permitId: saved.id, computerId: 'computer', tool: 'gpt-6-luna',
      destination: 'openai', outcome: 'success', costCents: 1 };
    await context.append(`effect-${saved.id}`, 'effect.observed', payload);
  } else if (kind === 'security') {
    const payload = { alertId: 'alert', severity: 'high', reason: 'effect_without_permit' };
    await context.append(`security-${saved.id}`, 'security.alert_raised', payload);
  } else if (kind === 'settled') {
    await context.actor.releaseUndispatched(saved.id);
  } else {
    const type = kind === 'expired' ? 'budget.reservation_expired' : 'budget.settled';
    let payload: Record<string, unknown> = { reservationId: saved.id };
    if (kind === 'unknown') {
      payload = { ...payload, permitId: saved.id, settledCents: 0, outcome: 'unknown' };
    }
    await context.append('budget-test', type, payload);
    await context.restartActor();
  }
  const position = await context.nats.store.head();
  expect((await context.call()).status).not.toBe(200);
  expect(await context.nats.store.head()).toBe(position);
  expect(context.received()).toBe(0);
  expect(context.actor.state.reservations).toHaveLength(1);
}
it.each(['effect', 'security', 'settled', 'expired', 'unknown'] as const)(
  'refuses a saved %s call without appending', refusesEvidence);

async function managedRetry() {
  const context = await managedFixture();
  const rootBinding = { ...binding, turnId: 'bound' };
  await context.actor.setRootAllowance(rootBinding, 1);
  const reserve = context.actor.reserve.bind(context.actor);
  async function loseReply(...args: Parameters<typeof reserve>): Promise<string> {
    await reserve(...args);
    throw new Error('Lost hold reply');
  }
  const writer = vi.spyOn(context.actor, 'reserve');
  writer.mockImplementationOnce(loseReply);
  expect((await context.call()).status).not.toBe(200);
  const saved = context.actor.state.reservations[0]!;
  expect((await context.call()).status).toBe(200);
  expect(context.received()).toBe(1);
  expect(context.actor.state.reservations).toHaveLength(1);
  expect(context.actor.state.dispatches[0]?.callId).toBe(saved.call.requestId);
  expect(saved.call).toMatchObject({ providerId: 'primary', bindingSequence: 42 });
  await context.settled();
}
it('uses the same retry binding for managed model calls', managedRetry);

async function stoppedRetry() {
  const context = await unsent();
  const saved = context.actor.state.reservations[0]!;
  const subject = 'conversation-conversation';
  const payload = { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' };
  await context.append(subject, 'agent.turn_stop_requested', payload);
  const position = await context.nats.store.head(subject);
  await context.actor.stopRoot(saved.rootId!, 'requester_stop', subject, position);
  const before = await context.nats.store.head();
  const call = { ...saved.call, requestId: 'new-request' };
  const retry = { retryDigest: saved.retryDigest!, bodyDigest: saved.bodyDigest! };
  await expect(context.actor.reserve(call, saved.amountCents, fresh, undefined, saved.rootId, retry))
    .rejects.toThrow('Root budget refused');
  expect(await context.nats.store.head()).toBe(before);
  expect(context.received()).toBe(0);
  expect(context.actor.state.dispatches).toHaveLength(0);
}
it('checks Stop again before granting a recovered hold', stoppedRetry);
