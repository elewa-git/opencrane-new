import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { childRequestedDataSchema, childStartFailedEventSchema } from '@opencrane/events';
import { z } from 'zod';
import { conversations } from '@opencrane/projections';
import { BudgetActor, budgets, history, readBudget, rootTotals } from '@opencrane/models';
import { allocateChildRoot } from '../src/chat/child-root.ts';
import { activateRequestedChild } from '../src/chat/child-activation.ts';
import { addChildFirstInput, createRequestedChild, requestChild, retryChildRequest }
  from '../src/chat/child-requests.ts';
import { summonFixture } from './support/child-summon.ts';
import { shortDuplicateWindowFixture, waitForDuplicateWindow }
  from './support/duplicate-window.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
let actor: BudgetActor;
const selected = { threadId: 'selected-thread', computerId: 'selected-computer',
  generation: 1, model: 'gpt-6.1-sol' };
async function initialise() {
  const nats = await shortDuplicateWindowFixture();
  context = await summonFixture(nats);
  for (const [granteeKind, granteeId] of [['member', 'alice'], ['assistant', 'helper']]) {
    await context.append(grantStream('model', selected.model), 'grant.given',
      { resourceType: 'model', resourceId: selected.model, granteeKind, granteeId,
        grantedBy: 'alice' });
  }
  await context.append('computer-helper', 'computer.ready',
    { assistantId: 'helper', computerId: selected.computerId, generation: 1 }, false);
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start(10_000, 10_000, 'payer');
}
async function close() {
  await context?.close();
}
beforeAll(initialise, 60_000);
afterAll(close);
afterEach(vi.restoreAllMocks);
async function prepare(allowanceBoundCents = 1000, activate = true) {
  const input = { ...await context.parent(), payingGroupId: 'payer', allowanceBoundCents };
  const intent = await requestChild(context.options, 'alice', input);
  const data = childRequestedDataSchema.parse(intent.event.data);
  const creation = await createRequestedChild(context.options, 'alice', input);
  await context.auth.handler.handle(creation.event, context.db);
  await addChildFirstInput(context.options, 'alice', input);
  if (activate) await activateRequestedChild(context.options, 'alice', input, 1);
  return { input, intent, data };
}
async function seedSavedFailure(saved: Awaited<ReturnType<typeof prepare>>) {
  // Keep testing old conflicting history even though recovery can no longer create it.
  const data = { conversationId: saved.input.conversationId,
    requestId: saved.input.requestId, childConversationId: saved.data.childConversationId,
    intentEventId: saved.intent.event.id, attempt: 1, stage: 'first_input', reason: 'access_refused' };
  const id = `${saved.intent.event.id}-failure`;
  const event = childStartFailedEventSchema.parse({ id, commandId: id, silo: 'test',
    subject: `conversation-${saved.input.conversationId}`, type: 'conversation.child_start_failed',
    source: 'opencrane-server', time: new Date().toISOString(), data,
    principal: { kind: 'system', id: 'opencrane-server' } });
  await context.nats.seed([event]);
}
async function allocatesOnce() {
  const saved = await prepare();
  const before = await context.nats.store.head();
  const reads = vi.spyOn(context.nats.store, 'readStream');
  const heads = vi.spyOn(context.nats.store, 'head');
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  for (const conversationId of [saved.input.conversationId, saved.data.childConversationId]) {
    function matches(call: unknown[]) {
      return call[0] === `conversation-${conversationId}`;
    }
    const index = reads.mock.calls.findIndex(matches);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(reads.mock.invocationCallOrder[index]).toBeLessThan(heads.mock.invocationCallOrder[0]!);
  }
  for (const [subject] of heads.mock.calls) {
    if (subject) expect(subject).not.toMatch(/^conversation-/u);
  }
  expect(root).toMatchObject({ requesterId: 'alice', assistantId: 'helper',
    conversationId: saved.data.childConversationId, turnId: saved.data.firstInputId,
    threadId: 'selected-thread', computerId: 'selected-computer', generation: 1,
    payingGroupId: 'payer', allowanceCents: 1000 });
  expect(rootTotals(actor.state, root.rootId)).toEqual({
    settledCents: 0, heldCents: 0, availableCents: 1000 });
  expect(await context.nats.store.head()).toBe(before + 1);
  const rows = await history(context.nats.store, 'budget-test', 'test');
  expect(rows.at(-1)?.event.type).toBe('budget.root_allowance_set');
  expect(await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .toEqual(root);
  expect(await context.nats.store.head()).toBe(before + 1);
}
it('allocates the reviewed child root once without holding or spending cents', allocatesOnce);

async function concurrentAndLostReply() {
  const saved = await prepare();
  const before = await context.nats.store.head();
  const results = await Promise.all([
    allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected),
    allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(await context.nats.store.head()).toBe(before + 1);
  const lost = await prepare(777);
  const append = context.nats.store.append.bind(context.nats.store);
  async function lose(command: Parameters<typeof append>[0]) {
    await append(command);
    return { status: 'unavailable' as const, cause: new Error('Lost reply') };
  }
  vi.spyOn(context.nats.store, 'append').mockImplementationOnce(lose);
  await expect(allocateChildRoot(context.options, actor, 'alice', lost.input, 1, selected))
    .rejects.toThrow();
  vi.restoreAllMocks();
  const rows = await history(context.nats.store, 'budget-test', 'test');
  const recorded = rows.at(-1)!;
  expect(recorded.event.type).toBe('budget.root_allowance_set');
  await waitForDuplicateWindow(context.nats);
  actor = new BudgetActor(context.nats.store, 'test');
  await actor.start();
  const afterRestart = await context.nats.store.head();
  const recovered = await allocateChildRoot(context.options, actor, 'alice', lost.input, 1, selected);
  const recordedBinding = z.record(z.string(), z.unknown()).parse(recorded.event.data);
  expect(recovered).toMatchObject(recordedBinding);
  expect(recovered.allowanceCents).toBe(777);
  await context.runner.initialise(budgets);
  await context.runner.rebuild(budgets);
  await context.runner.rebuild(conversations);
  expect(await readBudget(context.db, 'test')).toEqual(actor.state);
  expect(await context.nats.store.head()).toBe(afterRestart);
  expect(actor.state.reservations).toEqual([]);
  expect(actor.state.dispatches).toEqual([]);
}
it('recovers concurrent calls and a lost reply after deduplication, restart and replay',
  concurrentAndLostReply);

async function changedBindings() {
  const saved = await prepare();
  await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  const before = await context.nats.store.head();
  for (const patch of [{ threadId: 'other' }, { computerId: 'other' }, { generation: 2 }]) {
    const changed = { ...selected, ...patch };
    await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, changed))
      .rejects.toThrow();
  }
  for (const patch of [{ payingGroupId: 'owners' }, { allowanceBoundCents: 999 }]) {
    const changed = { ...saved.input, ...patch };
    await expect(allocateChildRoot(context.options, actor, 'alice', changed, 1, selected))
      .rejects.toThrow('Child request changed');
  }
  const changedRequest = { ...saved.input, requestId: 'other' };
  await expect(allocateChildRoot(context.options, actor, 'alice', changedRequest, 1, selected))
    .rejects.toThrow('Child activation unavailable');
  await expect(allocateChildRoot(context.options, actor, 'bob', saved.input, 1, selected))
    .rejects.toThrow('Child request unavailable');
  expect(await context.nats.store.head()).toBe(before);
}
it('refuses changed requester, payer, reviewed allowance and execution choices', changedBindings);

async function unavailableActivation(kind: string) {
  const saved = await prepare(1000, kind !== 'missing');
  if (kind === 'failed' || kind === 'superseded') {
    await seedSavedFailure(saved);
    if (kind === 'superseded') {
      const rows = await history(context.nats.store, `conversation-${saved.input.conversationId}`, 'test');
      const retry = { retryId: 'retry', failureEventId: rows.at(-1)!.event.id };
      await retryChildRequest(context.options, 'alice', saved.input.conversationId,
        saved.input.requestId, retry);
    }
  }
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .rejects.toThrow(/Child (activation unavailable|request failed)/u);
  if (kind === 'superseded') {
    await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 2, selected))
      .rejects.toThrow('Child request changed');
  }
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['missing', 'failed', 'superseded'])('refuses %s activation', unavailableActivation);

async function forgedActivation(field: string) {
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* altered(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      if (row.event.type !== 'conversation.child_activated') {
        yield row;
        continue;
      }
      const data = z.record(z.string(), z.unknown()).parse(row.event.data);
      yield { ...row, event: { ...row.event, data: { ...data, [field]: 'forged' } } };
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(altered);
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .rejects.toThrow('Child request changed');
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['intentEventId', 'creationEventId', 'firstInputId', 'requestedBy', 'payingGroupId', 'attempt'])(
  'refuses a forged activation %s', forgedActivation);

async function missingRecord(type: string) {
  const saved = await prepare();
  const read = context.nats.store.readStream.bind(context.nats.store);
  async function* omitted(...args: Parameters<typeof read>) {
    for await (const row of read(...args)) {
      const childRecord = row.event.subject === `conversation-${saved.data.childConversationId}`;
      if (row.event.type === type && (childRecord || type === 'conversation.child_requested')) continue;
      yield row;
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(omitted);
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .rejects.toThrow(/Child (request|activation)/u);
  expect(await context.nats.store.head()).toBe(before);
}
it.each(['conversation.child_requested', 'conversation.created', 'message.posted'])(
  'refuses allocation without saved %s', missingRecord);

async function closedConversation(parent: boolean) {
  const saved = await prepare();
  const conversationId = parent ? saved.input.conversationId : saved.data.childConversationId;
  await context.append(`participation-${conversationId}`, 'conversation.closed',
    { conversationId, closedBy: 'alice' }, false);
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .rejects.toThrow('Conversation closed');
  expect(await context.nats.store.head()).toBe(before);
}
it.each([true, false])('refuses a closed conversation, parent=%s', closedConversation);

async function refusesCapacity(kind: string) {
  // The full-context first call costs 502 cents at the saved server tariff.
  const saved = await prepare(kind === 'first call' ? 501 : 1000);
  if (kind === 'capacity') {
    await actor.configure({ scope: 'global', dailyCeilingCents: 999,
      ceilingCents: 999, setBy: 'alice' });
  }
  const before = await context.nats.store.head();
  try {
    await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
      .rejects.toMatchObject({ reason: 'allowance_unavailable' });
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    await actor.configure({ scope: 'global', dailyCeilingCents: 10_000,
      ceilingCents: 10_000, setBy: 'alice' });
  }
}
it.each(['first call', 'capacity'])('saves no root when %s cannot fit', refusesCapacity);

async function stoppedRoot() {
  const saved = await prepare(777);
  const root = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  // Use a saved terminal event to stop the root without revoking the requester's access.
  const terminal = { conversationId: saved.data.childConversationId, turnId: saved.data.firstInputId };
  const ended = await context.append(`conversation-${saved.data.childConversationId}`,
    'agent.turn_completed', terminal, false);
  const position = await context.nats.store.head(ended.subject);
  await actor.stopRoot(root.rootId, 'turn_ended', ended.subject, position);
  const before = await context.nats.store.head();
  const retried = await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  expect(retried.stop).toMatchObject({ reason: 'turn_ended' });
  expect(retried.allowanceCents).toBe(777);
  expect(await context.nats.store.head()).toBe(before);
}
it('returns an existing stopped root without reopening or resizing it', stoppedRoot);

async function queueChange(kind: string) {
  const saved = await prepare();
  if (kind === 'saved grant') {
    await allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  }
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  async function pause() {
    entered.resolve();
    await release.promise;
  }
  const blocking = actor.configure({ scope: 'global', ceilingCents: 10_000, setBy: 'alice' },
    undefined, undefined, pause);
  await entered.promise;
  const original = actor.setRootAllowance.bind(actor);
  function capture(...args: Parameters<typeof original>) {
    queued.resolve();
    return original(...args);
  }
  vi.spyOn(actor, 'setRootAllowance').mockImplementation(capture);
  const pending = allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected);
  const refused = expect(pending).rejects.toThrow();
  await queued.promise;
  const grant = { resourceType: 'model', resourceId: selected.model,
    granteeKind: 'member', granteeId: 'alice' };
  try {
    if (kind === 'deadline') {
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
    } else if (kind === 'membership') {
      await context.append('team-payer', 'team.member_removed',
        { teamId: 'payer', memberId: 'alice', removedBy: 'bob' });
    } else if (kind === 'grant' || kind === 'saved grant') {
      await context.append(grantStream('model', selected.model), 'grant.revoked',
        { ...grant, revokedBy: 'alice' });
    } else if (kind === 'failure') {
      await seedSavedFailure(saved);
    } else {
      const conversationId = kind === 'parent' ? saved.input.conversationId : saved.data.childConversationId;
      await context.append(`conversation-${conversationId}`, 'conversation.closed',
        { conversationId, closedBy: 'alice' }, false);
    }
    release.resolve();
    await blocking;
    const before = await context.nats.store.head();
    await refused;
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    release.resolve();
    vi.restoreAllMocks();
    if (kind === 'membership') {
      await context.append('team-payer', 'team.member_added',
        { teamId: 'payer', memberId: 'alice', addedBy: 'alice' });
    }
    if (kind === 'grant' || kind === 'saved grant') {
      await context.append(grantStream('model', selected.model), 'grant.given',
        { ...grant, grantedBy: 'alice' });
    }
  }
}
it.each(['deadline', 'membership', 'grant', 'saved grant', 'failure', 'parent', 'child'])(
  'refuses queued allocation after changed %s', queueChange);

async function deadlineAtAppend() {
  const saved = await prepare();
  const now = actor.now;
  function expire() {
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 2001);
    return now();
  }
  vi.spyOn(actor, 'now').mockImplementationOnce(expire);
  const before = await context.nats.store.head();
  await expect(allocateChildRoot(context.options, actor, 'alice', saved.input, 1, selected))
    .rejects.toThrow('Authority snapshot expired');
  expect(await context.nats.store.head()).toBe(before);
}
it('checks the original deadline again immediately before the actor append', deadlineAtAppend);
