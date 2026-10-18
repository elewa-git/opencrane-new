import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { data, history } from '../src/index.ts';
import { rootTotals } from '../src/root-budget.ts';
import { fixture } from './fixture.ts';

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
function restore() { vi.restoreAllMocks(); }
afterEach(restore);

async function recoversHold(restart: boolean) {
  const context = await setup();
  const reserve = context.actor.reserve.bind(context.actor);
  async function loseHoldReply(...args: Parameters<typeof reserve>) {
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
  expect(data(decisions[0]!.event)).toMatchObject({ outcome: 'allow', permitId: saved.id });
  expect(context.admitted).toEqual([saved.call.requestId]);
  await context.settled();
  expect(rootTotals(context.actor.state, context.actor.state.roots[0]!.rootId))
    .toMatchObject({ settledCents: 1, heldCents: 0 });
}
it.each([false, true])('recovers the same unsent hold and original decision; restart=%s', recoversHold);
