import { expect, it, onTestFinished, vi } from 'vitest';
import { parseEventByType } from '@opencrane/events';
import { BudgetActor, envelope, history, priceTableId } from '../src/index.ts';
import { rootTotals } from '../src/root-budget.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
const binding = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', allowanceCents: 1000 };
const call = { requesterId: 'alice', conversationId: 'conversation', turnId: 'turn',
  threadId: 'thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  payingGroupId: 'personal-default', model: 'gpt-6-luna', priceTableId,
  contextDigest: '0'.repeat(64) };
async function fresh() {}
async function setup() {
  const context = await fixture();
  const close = context.close.bind(context);
  onTestFinished(close);
  return context;
}
async function stop(context: Fixture, rootId: string) {
  const subject = 'conversation-conversation';
  const payload = { conversationId: 'conversation', turnId: 'turn', requestedBy: 'alice' };
  await context.append(subject, 'agent.turn_stop_requested', payload);
  const position = await context.nats.store.head(subject);
  await context.actor.stopRoot(rootId, 'requester_stop', subject, position);
}
function dispatch(reservationId: string, rootId: string) {
  return { callId: reservationId, decisionId: 'decision', bodyDigest: '1'.repeat(64),
    reservationId, modelCall: call, rootId };
}
async function settle(context: Fixture, reservationId: string, settledCents: number) {
  const payload = { reservationId, permitId: reservationId, settledCents,
    outcome: 'settled', resolvedBy: 'owner', evidence: [{ kind: 'provider_receipt',
      reference: 'receipt', digest: '0'.repeat(64), amountCents: settledCents }] };
  const saved = envelope('test', `effect-${reservationId}`, 'effect.resolved', payload);
  const event = { ...saved, principal: { kind: 'human' as const, id: 'owner' } };
  await context.actor.settle(event);
}
async function counts(context: Fixture, type: string) {
  const rows = await history(context.nats.store, 'budget-test', 'test');
  function matches(row: (typeof rows)[number]) { return row.event.type === type; }
  return rows.filter(matches).length;
}
async function grantsRootedModel() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 1);
  expect((await context.call()).status).toBe(200);
  expect(context.received()).toBe(1);
  expect(context.actor.state.reservations[0]?.rootId).toBe(root.rootId);
  expect(context.actor.state.dispatches[0]?.rootId).toBe(root.rootId);
  await context.settled();
  expect(rootTotals(context.actor.state, root.rootId)).toMatchObject({
    settledCents: 1, heldCents: 0 });
  await stop(context, root.rootId);
  expect((await context.call()).status).toBe(403);
  expect(context.received()).toBe(1);
  expect(await counts(context, 'budget.reserved')).toBe(1);
}
it('finds the verified turn root at model grant and saves it at dispatch', grantsRootedModel);

async function stopsBetweenHoldAndAdmission() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 1);
  const append = context.nats.store.append.bind(context.nats.store);
  async function stopAfterAllow(command: Parameters<typeof append>[0]) {
    const result = await append(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'decision.recorded') {
      await stop(context, root.rootId);
    }
    return result;
  }
  const writer = vi.spyOn(context.nats.store, 'append');
  writer.mockImplementation(stopAfterAllow);
  try {
    expect((await context.call()).status).toBe(503);
  } finally {
    writer.mockRestore();
  }
  expect(context.received()).toBe(0);
  expect(root.stop?.reason).toBe('requester_stop');
  expect(await counts(context, 'budget.reserved')).toBe(1);
  expect(await counts(context, 'budget.call_dispatch_admitted')).toBe(0);
  expect(context.actor.state.reservations[0]).toMatchObject({ settledCents: 0 });
  expect(rootTotals(context.actor.state, root.rootId).heldCents).toBe(0);
}
it('releases an unsent model hold when Stop follows its allow decision',
  stopsBetweenHoldAndAdmission);

async function stopsOldHold() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 240);
  const first = await context.actor.reserve(call, 240, fresh, undefined, root.rootId);
  await settle(context, first, 240);
  await context.actor.reserve(call, 110, fresh, undefined, root.rootId);
  const results = await Promise.allSettled([
    context.actor.reserve(call, 400, fresh, undefined, root.rootId),
    context.actor.reserve(call, 300, fresh, undefined, root.rootId),
  ]);
  expect(results[0]?.status).toBe('fulfilled');
  expect(results[1]?.status).toBe('rejected');
  const held = context.actor.state.reservations[2]!;
  await expect(context.actor.admitDispatch(dispatch(held.id, root.rootId), fresh))
    .rejects.toThrow('Root budget refused');
  expect(root.stop?.reason).toBe('allowance_exhausted');
  expect(held.settledCents).toBe(0);
  expect(context.received()).toBe(0);
  expect(await counts(context, 'budget.call_dispatch_admitted')).toBe(0);
  expect(rootTotals(context.actor.state, root.rootId)).toEqual({
    settledCents: 240, heldCents: 110, availableCents: 650 });
}
it('releases the unadmitted 400 hold after competing 400 and 300 exhaust 650', stopsOldHold);

async function stopsToolsAtGrant() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 1);
  await stop(context, root.rootId);
  const toolCall = { ...call, model: 'mcp-zero-cost' };
  const before = await context.nats.store.head();
  await expect(context.actor.checkBudget(toolCall, fresh, root.position, root.rootId))
    .rejects.toThrow('Root budget refused');
  expect(await context.nats.store.head()).toBe(before);
}
it('refuses a stopped root at the zero-cost grant check without appending', stopsToolsAtGrant);

async function refusesChangedRoot() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 1);
  const held = await context.actor.reserve(call, 110, fresh, undefined, root.rootId);
  const before = await context.nats.store.head();
  await expect(context.actor.admitDispatch(dispatch(held, 'another-root'), fresh))
    .rejects.toThrow('Reservation binding changed');
  expect(await context.nats.store.head()).toBe(before);
  expect(rootTotals(context.actor.state, root.rootId).heldCents).toBe(110);
}
it('refuses a different dispatch root without releasing or appending', refusesChangedRoot);

async function settlesLateOnce() {
  const context = await setup();
  const root = await context.actor.setRootAllowance(binding, 240);
  const first = await context.actor.reserve(call, 240, fresh, undefined, root.rootId);
  await settle(context, first, 240);
  const held = await context.actor.reserve(call, 110, fresh, undefined, root.rootId);
  await context.actor.admitDispatch(dispatch(held, root.rootId), fresh);
  await stop(context, root.rootId);
  expect(rootTotals(context.actor.state, root.rootId)).toMatchObject({
    settledCents: 240, heldCents: 110 });
  await settle(context, held, 70);
  const before = await context.nats.store.head();
  await settle(context, held, 70);
  expect(await context.nats.store.head()).toBe(before);
  const recovered = new BudgetActor(context.nats.store, 'test', context.actor.now);
  await recovered.start();
  expect(rootTotals(recovered.state, root.rootId)).toEqual({
    settledCents: 310, heldCents: 0, availableCents: 690 });
  expect(recovered.state.reservations[1]?.call).toMatchObject({
    priceTableId, payingGroupId: 'personal-default' });
  expect(recovered.state.roots[0]?.stop?.reason).toBe('requester_stop');
}
it('settles late duplicated usage once after Stop and restart at the original tariff and payer',
  settlesLateOnce);

async function sendsUnaffectedTurns() {
  const context = await setup();
  const stopped = await context.actor.setRootAllowance(binding, 1);
  await stop(context, stopped.rootId);
  for (const turnId of ['other-root', 'non-root']) {
    const turn = { assistantId: 'assistant', computerId: 'computer',
      conversationId: 'conversation', turnId, threadId: turnId, requesterId: 'alice',
      task: 'chat_turn', payingGroupId: 'personal-default' };
    await context.append('computer-assistant', 'computer.turn_started', turn);
    const started = { conversationId: 'conversation', assistantId: 'assistant', turnId };
    await context.append('conversation-conversation', 'agent.turn_started', started);
    if (turnId === 'other-root') {
      const otherBinding = { ...binding, turnId, threadId: turnId };
      await context.actor.setRootAllowance(otherBinding, 1);
    }
    const claims = { ...context.t, turn: turnId, thread: turnId };
    const token = await context.sign(claims, 'decision-service');
    const headers = { 'x-turn-token': token, 'session-id': turnId };
    expect((await context.call(headers)).status).toBe(200);
  }
  expect(context.received()).toBe(2);
  expect(context.actor.state.dispatches).toHaveLength(2);
  expect(stopped.stop?.reason).toBe('requester_stop');
}
it('lets another root and a non-root turn send after Stop on the same computer',
  sendsUnaffectedTurns);
