import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { failingPublishStore } from '@opencrane/event-store/testing';
import { childRequestedDataSchema, childStartFailedEventSchema } from '@opencrane/events';
import { BudgetActor, history, reservationCents } from '@opencrane/models';
import { allocateChildRoot } from '../src/chat/child-root.ts';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { addChildFirstInput, createRequestedChild, requestChild, retryChildRequest }
  from '../src/chat/child-requests.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
let actor: BudgetActor;
const expensive = 'gpt-6.1-sol';
const cheap = 'gpt-6-luna';
const selected = { threadId: 'prepared-thread', computerId: 'computer', generation: 1, model: expensive };
const provider = { providerId: 'primary', revision: 1, changedBy: 'alice',
  expectedProviderSequence: 0 };
async function setup() {
  context = await summonFixture();
  for (const model of [expensive, cheap]) {
    for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'helper']]) {
      await context.append(grantStream('model', model), 'grant.given',
        { resourceType: 'model', resourceId: model, granteeKind, granteeId, grantedBy: 'alice' });
    }
  }
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start(10_000, 10_000, 'payer');
  await context.append('provider-primary', 'provider.created',
    { providerId: 'primary', revision: 1, changedBy: 'alice', provider: 'openai', name: 'Primary' }, false);
}
async function close() {
  await context?.close();
}
beforeAll(setup, 60_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
async function choose(model = expensive, state = 'active', kind = 'assistant') {
  await context.append('provider-primary', 'provider.model_binding_set',
    { ...provider, model, state, kind, dependantId: kind === 'assistant' ? 'helper' : 'test',
      task: 'chat_turn', previousBindingSequence: 0 }, false);
}
async function ready(computerId = 'computer', generation = 1) {
  await context.append('computer-helper', 'computer.ready',
    { assistantId: 'helper', computerId, generation }, false);
}
async function prepare(allowanceBoundCents = 1000) {
  await ready();
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start();
  const input = { ...await context.parent(), payingGroupId: 'payer', allowanceBoundCents };
  selected.threadId = `prepared-${input.requestId}`;
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  const creation = await createRequestedChild(context.options, 'alice', input);
  await context.auth.handler.handle(creation.event, context.db);
  await addChildFirstInput(context.options, 'alice', input);
  const before = await context.nats.store.head();
  await activateRequestedChild(context.options, 'alice', input, 1);
  expect(await context.nats.store.head()).toBe(before + 1);
  return { input, intent, data };
}
async function rejects(input: unknown, selection = selected) {
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', input, 1, selection))
    .rejects.toThrow();
  expect(await context.nats.store.head()).toBe(before);
}
async function drainingChoice() {
  const saved = await prepare();
  await context.append('provider-primary', 'provider.managed_calls_drain_set',
    { ...provider, draining: true, expectedDrainSequence: 0 }, false);
  await rejects(saved.input);
}
it('refuses draining legacy mode without allocating', drainingChoice);
async function missingChoice() {
  const saved = await prepare();
  await context.append('budget-test', 'provider.managed_calls_enabled', provider, false);
  await rejects(saved.input);
}
it('refuses missing enabled choices without allocating', missingChoice);

async function savedPricing(model: string) {
  await choose(cheap, 'active', 'silo_default');
  await choose(model);
  const bound = reservationCents(model, 2000);
  const tooSmall = await prepare(bound - 1);
  const alternative = { ...selected, model: cheap };
  await rejects(tooSmall.input, alternative);
  const saved = await prepare(bound);
  const allocate = vi.spyOn(actor, 'setRootAllowance');
  const before = await context.nats.store.head();
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, alternative);
  expect(allocate.mock.calls[0]?.[1]).toBe(bound);
  expect(root.allowanceCents).toBe(bound);
  expect(await context.nats.store.head()).toBe(before + 1);
  expect(actor.state.reservations).toEqual([]);
  expect(actor.state.dispatches).toEqual([]);
}
it.each([expensive, cheap])('prices the first call from saved %s despite a supplied model', savedPricing);

async function invalidPreparation(kind: string) {
  await choose();
  const saved = await prepare();
  let selection = selected;
  if (kind === 'computer') selection = { ...selected, computerId: 'other' };
  if (kind === 'generation') selection = { ...selected, generation: 2 };
  if (kind === 'paused') await choose(expensive, 'paused');
  if (kind === 'suspended') {
    await context.append('computer-helper', 'computer.suspended',
      { assistantId: 'helper', computerId: 'computer' }, false);
  }
  if (kind === 'used thread') {
    await context.append('computer-helper', 'computer.turn_started',
      { assistantId: 'helper', computerId: 'computer', conversationId: 'another-child',
        turnId: 'another-turn', threadId: selected.threadId, requesterId: 'alice',
        task: 'chat_turn', executionMode: 'restricted' }, false);
  }
  await rejects(saved.input, selection);
}
it.each(['computer', 'generation', 'paused', 'suspended', 'used thread'])(
  'refuses a prepared selection with invalid %s', invalidPreparation);

async function changesWhileQueued(kind: string) {
  await choose();
  const saved = await prepare();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = actor.setRootAllowance.bind(actor);
  async function pause(...args: Parameters<typeof original>) {
    entered.resolve();
    await release.promise;
    return original(...args);
  }
  vi.spyOn(actor, 'setRootAllowance').mockImplementationOnce(pause);
  const pending = allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  const refused = expect(pending).rejects.toThrow();
  await entered.promise;
  try {
    if (kind === 'model') await choose(cheap);
    if (kind === 'same model revision') await choose();
    if (kind === 'paused') await choose(expensive, 'paused');
    if (kind === 'computer') await ready('replacement', 2);
    const before = await context.nats.store.head();
    release.resolve();
    await refused;
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    release.resolve();
  }
}
it.each(['model', 'same model revision', 'paused', 'computer'])(
  'refuses a changed %s after preparation resumes', changesWhileQueued);

async function failedPublishChange(kind: string) {
  await choose();
  const saved = await prepare();
  const connection = await context.nats.client('command');
  const retry = await failingPublishStore(connection);
  const options = { ...context.options, store: retry.store };
  const restarted = new BudgetActor(retry.store, 'test');
  await restarted.start();
  const before = await context.nats.store.head('budget-test');
  async function change() {
    if (kind === 'model') await choose(cheap);
    if (kind === 'computer') await ready('replacement', 2);
    if (kind === 'deadline') {
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
    }
    if (kind === 'removal') {
      await context.append(`participation-${saved.input.conversationId}`, 'participant.removed',
        { conversationId: saved.input.conversationId, participantId: 'alice', removedBy: 'bob' });
    }
    if (kind === 'closure') {
      await context.append(`conversation-${saved.input.conversationId}`, 'conversation.closed',
        { conversationId: saved.input.conversationId, closedBy: 'alice' }, false);
    }
    if (kind === 'new attempt') {
      // Keep detecting conflicting old history that today's failure command cannot create.
      const id = `${saved.intent.event.id}-failure`;
      const event = childStartFailedEventSchema.parse({ id, commandId: id, silo: 'test',
        subject: `conversation-${saved.input.conversationId}`, type: 'conversation.child_start_failed',
        source: 'opencrane-server', time: new Date().toISOString(),
        principal: { kind: 'system', id: 'opencrane-server' },
        data: { conversationId: saved.input.conversationId, requestId: saved.input.requestId,
          childConversationId: saved.data.childConversationId, intentEventId: saved.intent.event.id,
          attempt: 1, stage: 'activation', reason: 'access_refused' } });
      await context.nats.seed([event]);
      const request = { retryId: 'retry', failureEventId: id };
      await retryChildRequest(context.options, 'alice', saved.input.conversationId,
        saved.input.requestId, request);
    }
  }
  retry.failNextPublish(change);
  if (kind === 'unchanged') {
    const root = await allocateChildRoot(options, restarted, 'alice', saved.input, 1, selected);
    expect(root.allowanceCents).toBe(1000);
    expect(retry.publishAttempts()).toBe(2);
  } else {
    await expect(allocateChildRoot(options, restarted, 'alice', saved.input, 1, selected))
      .rejects.toThrow();
    expect(await context.nats.store.head('budget-test')).toBe(before);
    expect(retry.publishAttempts()).toBe(1);
  }
}
it.each(['model', 'computer', 'deadline', 'removal', 'closure', 'new attempt', 'unchanged'])(
  'checks preparation and access on real transport retry: %s', failedPublishChange);

async function slowPreparation() {
  await choose();
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  let elapsed = 0;
  const now = performance.now.bind(performance);
  function clock() { return now() + elapsed; }
  vi.spyOn(performance, 'now').mockImplementation(clock);
  const delayed = new Set<string>();
  async function* slow(subject: string, from?: number, deadline?: number) {
    if (!delayed.has(subject) && (subject === 'provider-*' || subject === 'computer-helper' ||
        (subject.startsWith('conversation-') && (from === undefined || from === 1)))) {
      elapsed += 2500;
      delayed.add(subject);
    }
    yield* read(subject, from, deadline);
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(slow);
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  expect(root.allowanceCents).toBe(1000);
  const rows = await history(context.nats.store, 'computer-helper', 'test');
  function started(row: typeof rows[number]) { return row.event.type === 'computer.turn_started'; }
  // Only the deliberately seeded foreign turn exists; allocation starts no work.
  expect(rows.filter(started)).toHaveLength(1);
}
it('loads slow provider, computer and conversation history before the access window', slowPreparation);
