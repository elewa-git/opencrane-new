import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { grantStream } from '@opencrane/authz';
import { BudgetActor, budgets, rootTotals } from '@opencrane/models';
import { conversations } from '@opencrane/projections';
import { childRequestedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { allocateChildRoot } from '../src/chat/child-root.ts';
import { addChildFirstInput, createRequestedChild, requestChild }
  from '../src/chat/child-requests.ts';
import { startActivatedChild } from '../src/chat/child-start.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
let actor: BudgetActor;
const selected = { computerId: 'child-computer', generation: 1, threadId: 'child-thread' };

async function initialise() {
  context = await summonFixture();
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'helper']]) {
    await context.append(grantStream('model', 'gpt-6.1-sol'), 'grant.given',
      { resourceType: 'model', resourceId: 'gpt-6.1-sol', granteeKind, granteeId,
        grantedBy: 'alice' });
  }
  await context.append('computer-helper', 'computer.ready',
    { assistantId: 'helper', computerId: selected.computerId, generation: 1 }, false);
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start(10_000, 10_000, 'payer');
}

beforeAll(initialise, 60_000);
afterAll(async () => context?.close());

async function savedChild(allowanceBoundCents = 1000) {
  const input = { ...await context.parent(), payingGroupId: 'payer', allowanceBoundCents };
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  const created = await createRequestedChild(context.options, 'alice', input);
  await context.auth.handler.handle(created.event, context.db);
  await addChildFirstInput(context.options, 'alice', input);
  await activateRequestedChild(context.options, 'alice', input, 1);
  return { input, data, selected: { ...selected, threadId: data.firstInputId } };
}

function recordingBridge() {
  const sent: string[] = [];
  function send(binding: { turnId: string }) {
    sent.push(binding.turnId);
    return Promise.resolve();
  }
  return { sent, send };
}

async function startsOnlyOnce() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  const first = await startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send);
  const repeated = await startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send);
  expect(first.rootId).toBe(repeated.rootId);
  expect(first.turnId).toBe(saved.data.firstInputId);
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
  const computer = await history(context.nats.store, 'computer-helper', 'test');
  function startedThisTurn(row: typeof computer[number]) {
    if (row.event.type !== 'computer.turn_started') return false;
    const data = z.object({ turnId: z.string() }).safeParse(row.event.data);
    return data.success && data.data.turnId === saved.data.firstInputId;
  }
  const starts = computer.filter(startedThisTurn);
  expect(starts).toHaveLength(1);
  expect(rootTotals(actor.state, z.string().parse(first.rootId))).toEqual({
    settledCents: 0, heldCents: 0, availableCents: 1000 });
}
it('starts the saved first input with one root and one computer start', startsOnlyOnce);

async function lostSendReply() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  async function loseReply(binding: { turnId: string }) {
    await bridge.send(binding);
    throw new Error('Lost start reply');
  }
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, loseReply)).rejects.toThrow('Lost start reply');
  const second = new BudgetActor(context.nats.store, 'test');
  await second.start();
  actor = second;
  const recovered = await startActivatedChild(context.options, second, 'alice', saved.input,
    1, saved.selected, bridge.send);
  expect(recovered.turnId).toBe(saved.data.firstInputId);
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
}
it('uses the same start after a lost send reply and actor restart', lostSendReply);

async function revokedBeforeStart() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  await context.append(`participation-${saved.input.conversationId}`, 'participant.removed',
    { conversationId: saved.input.conversationId, participantId: 'alice', removedBy: 'bob' });
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not start after parent access is removed', revokedBeforeStart);

async function twoWorkers() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  function start() {
    return startActivatedChild(context.options, actor, 'alice', saved.input,
      1, saved.selected, bridge.send);
  }
  const results = await Promise.allSettled([start(), start()]);
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  await start();
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
  const before = await context.nats.store.head();
  await context.runner.rebuild(conversations);
  await context.runner.initialise(budgets);
  await context.runner.rebuild(budgets);
  expect(await context.nats.store.head()).toBe(before);
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
}
it('admits one start across concurrent workers and projection replay', twoWorkers);

async function refusesChangedRequest() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  for (const changed of [
    { ...saved.input, sourceMessageId: 'other-source' },
    { ...saved.input, conversationId: 'other-parent' },
    { ...saved.input, payingGroupId: 'other-payer' },
  ]) {
    await expect(startActivatedChild(context.options, actor, 'alice', changed,
      1, saved.selected, bridge.send)).rejects.toThrow();
  }
  expect(bridge.sent).toEqual([]);
}
it('refuses changed source, parent and payer without sending', refusesChangedRequest);

async function closedBeforeStart() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  await context.append(`participation-${saved.input.conversationId}`, 'conversation.closed',
    { conversationId: saved.input.conversationId, closedBy: 'alice' }, false);
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not start after the parent closes', closedBeforeStart);

async function stoppedBeforeStart() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input,
    1, saved.selected);
  const terminal = { conversationId: saved.data.childConversationId,
    turnId: saved.data.firstInputId };
  const ended = await context.append(`conversation-${saved.data.childConversationId}`,
    'agent.turn_completed', terminal, false);
  const position = await context.nats.store.head(ended.subject);
  await actor.stopRoot(root.rootId, 'turn_ended', ended.subject, position);
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not send from a stopped root', stoppedBeforeStart);

async function queuedForCapacity() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  await actor.configure({ scope: 'global', dailyCeilingCents: 999,
    ceilingCents: 999, setBy: 'alice' });
  try {
    await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
      1, saved.selected, bridge.send)).rejects.toThrow();
    expect(bridge.sent).toEqual([]);
    const pending = await history(context.nats.store, 'computer-helper', 'test');
    function startedThisTurn(row: typeof pending[number]) {
      if (row.event.type !== 'computer.turn_started') return false;
      const data = z.object({ turnId: z.string() }).safeParse(row.event.data);
      return data.success && data.data.turnId === saved.data.firstInputId;
    }
    expect(pending.some(startedThisTurn)).toBe(false);
  } finally {
    await actor.configure({ scope: 'global', dailyCeilingCents: 10_000,
      ceilingCents: 10_000, setBy: 'alice' });
  }
  const admitted = await startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send);
  expect(admitted.turnId).toBe(saved.data.firstInputId);
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
}
it('keeps the original ids queued while capacity is busy', queuedForCapacity);

async function unavailableFirstCall() {
  const saved = await savedChild(501);
  const bridge = recordingBridge();
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not start when the root cannot cover its first call', unavailableFirstCall);

async function lostGeneration() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  await context.append('computer-helper', 'computer.lost',
    { assistantId: 'helper', computerId: selected.computerId }, false);
  await expect(startActivatedChild(context.options, actor, 'alice', saved.input,
    1, saved.selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not send after the computer generation is lost', lostGeneration);
