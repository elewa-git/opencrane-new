import { afterEach, expect, it, vi } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { computerSummary, readComputerControl } from '@opencrane/auth';
import { auditTrail, readAudit } from '@opencrane/projections';
import type { AppendCommand } from '@opencrane/event-store';
import { requestControl } from '../src/computers/takeover.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { viewAccess } from '../src/computers/view-access.ts';
import { viewFixture } from './support/view-fixture.ts';

let fixture: Awaited<ReturnType<typeof viewFixture>>;
function noDesktop(): Promise<never> {
  return Promise.reject(new Error('No writer is available'));
}
async function cleanup() {
  vi.restoreAllMocks();
  await fixture?.close();
}
afterEach(cleanup);
async function setup() {
  fixture = await viewFixture(noDesktop);
  await fixture.append('conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  }, true);
  await fixture.append('budget-test', 'budget.ceiling_set', {
    scope: 'global', ceilingCents: 20000, setBy: 'alice', defaultPayingGroupId: 'personal',
  });
  const rows = [];
  for await (const row of fixture.nats.store.readStream('conversation-chat')) rows.push(row);
  const requesterEventId = rows.at(-1)!.event.id;
  const options = { ...fixture, store: fixture.nats.store, silo: 'test' };
  const input = { commandId: 'control-one', conversationId: 'chat', requesterEventId,
    generation: 1 };
  return { options, input };
}
async function keepsIntentAndReplay() {
  const { options, input } = await setup();
  const first = await requestControl(options, 'alice', input);
  expect(first.phase).toBe('requested');
  expect(await requestControl(options, 'alice', input)).toEqual(first);
  await expect(requestControl(options, 'alice', { ...input, commandId: 'second-tab' }))
    .rejects.toThrow('Control conflict');
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'desktop' };
  const start = { conversationId: 'chat', turnId: input.requesterEventId,
    threadId: 'thread', status: 'started' as const };
  await expect(turnCommand(options.store, context, start)).rejects.toThrow('Computer control');
  expect(await viewAccess(options, 'alice', 'chat')).toMatchObject({ computerId: 'desktop' });
  const rebuilt = computerSummary.empty();
  for await (const row of options.store.readStream('computer-assistant')) {
    computerSummary.add(rebuilt, row);
  }
  expect(rebuilt.lifecycle?.event.type).toBe('computer.ready');
  expect(rebuilt.control).toEqual(first);
  await fixture.runner.initialise(auditTrail);
  await fixture.runner.run(auditTrail);
  const audit = await readAudit(fixture.db, 'test');
  expect(audit.rows[0]?.records[0]).toMatchObject({
    computerId: 'desktop', generation: 1, takeoverId: 'control-one',
    affectedTurnCount: 0,
  });
  expect(typeof audit.rows[0]?.records[0]?.recordedAt).toBe('string');
  await fixture.runner.rebuild(auditTrail);
  expect(await readAudit(fixture.db, 'test')).toEqual(audit);
}
it('keeps one intent, replayable status and audit, and independently authorised viewing',
  keepsIntentAndReplay, 30_000);
async function refusesAnotherRequester() {
  const { options, input } = await setup();
  expect(await readComputerControl(options.store, 'test', 'assistant')).toBeUndefined();
  await expect(requestControl(options, 'bob', input)).rejects.toThrow('Requester only');
  expect(await readComputerControl(options.store, 'test', 'assistant')).toBeUndefined();
}
it('refuses Bob because Alice requested the work, without another control intent',
  refusesAnotherRequester, 30_000);
async function racesIntent(other: 'intent' | 'turn') {
  const { options, input } = await setup();
  await fixture.append('conversation-other', 'conversation.created', {
    conversationId: 'other', assistantId: 'assistant', createdBy: 'alice', mode: 'agent_session',
  }, true);
  const message = await fixture.append('conversation-other', 'message.posted', {
    conversationId: 'other', authorId: 'alice', authorKind: 'human',
    ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:test', contentType: 'text',
  });
  const append = options.store.append.bind(options.store);
  const both = Promise.withResolvers<void>();
  let arrivals = 0;
  async function appendTogether(command: AppendCommand) {
    arrivals++;
    if (arrivals === 2) both.resolve();
    await both.promise;
    return append(command);
  }
  vi.spyOn(options.store, 'append').mockImplementation(appendTogether);
  const second = { ...input, conversationId: 'other', commandId: 'control-two',
    requesterEventId: message.id };
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'desktop' };
  const turn = { conversationId: 'other', turnId: message.id, threadId: 'other-thread',
    status: 'started' as const };
  const competing = other === 'intent' ? requestControl(options, 'alice', second)
    : turnCommand(options.store, context, turn);
  const results = await Promise.allSettled([requestControl(options, 'alice', input), competing]);
  const fulfilled = results.filter(isFulfilled);
  expect(fulfilled).toHaveLength(1);
  if (other === 'turn') {
    vi.restoreAllMocks();
    const control = await readComputerControl(options.store, 'test', 'assistant');
    if (!control) {
      const saved = await requestControl(options, 'alice', input);
      expect(saved.affectedTurnIds).toEqual([message.id]);
    }
  }
}
function isFulfilled(result: PromiseSettledResult<unknown>) {
  return result.status === 'fulfilled';
}
it.each(['intent', 'turn'] as const)('lets only one append succeed when intent races %s',
  racesIntent, 30_000);
async function refusesRemovedMember(reinvite: boolean) {
  const { options, input } = await setup();
  await fixture.append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' });
  if (reinvite) {
    await fixture.append('member-alice', 'member.invited', {
      memberId: 'alice', invitationId: 'new-invite', email: 'a@example.test',
      role: 'member', invitedBy: 'owner',
    });
  }
  await expect(requestControl(options, 'alice', input)).rejects.toThrow();
  expect(await readComputerControl(options.store, 'test', 'assistant')).toBeUndefined();
}
it.each([false, true])('refuses saved removal while IAM still allows access, reinvite=%s',
  refusesRemovedMember, 30_000);
