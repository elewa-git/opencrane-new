import { afterAll, beforeAll, expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { BudgetActor, rootTotals } from '@opencrane/models';
import { childRequestedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
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

async function savedChild() {
  const input = { ...await context.parent(), payingGroupId: 'payer', allowanceBoundCents: 1000 };
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  const created = await createRequestedChild(context.options, 'alice', input);
  await context.auth.handler.handle(created.event, context.db);
  await addChildFirstInput(context.options, 'alice', input);
  await activateRequestedChild(context.options, 'alice', input, 1);
  return { input, data };
}

function recordingBridge() {
  const sent: string[] = [];
  async function send(binding: { turnId: string }) {
    sent.push(binding.turnId);
  }
  return { sent, send };
}

async function startsOnlyOnce() {
  const saved = await savedChild();
  const bridge = recordingBridge();
  const first = await startActivatedChild(context.options, actor, 'alice', saved.input,
    1, selected, bridge.send);
  const repeated = await startActivatedChild(context.options, actor, 'alice', saved.input,
    1, selected, bridge.send);
  expect(first.rootId).toBe(repeated.rootId);
  expect(first.turnId).toBe(saved.data.firstInputId);
  expect(bridge.sent).toEqual([saved.data.firstInputId]);
  const computer = await history(context.nats.store, 'computer-helper', 'test');
  const starts = computer.filter(row => row.event.type === 'computer.turn_started' &&
    row.event.data?.['turnId'] === saved.data.firstInputId);
  expect(starts).toHaveLength(1);
  expect(rootTotals(actor.state, first.rootId)).toEqual({
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
    1, selected, loseReply)).rejects.toThrow('Lost start reply');
  const second = new BudgetActor(context.nats.store, 'test');
  await second.start();
  const recovered = await startActivatedChild(context.options, second, 'alice', saved.input,
    1, selected, bridge.send);
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
    1, selected, bridge.send)).rejects.toThrow();
  expect(bridge.sent).toEqual([]);
}
it('does not start after parent access is removed', revokedBeforeStart);
