import { afterEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor, envelope } from '@opencrane/models';
import { turnCommand } from '../src/chat/turns.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
async function close() {
  await nats?.close();
}
afterEach(close);

const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
const input = { conversationId: 'conversation', turnId: 'message', threadId: 'thread',
  status: 'started' as const };
async function seedTurn() {
  nats = await natsFixture();
  const actor = new BudgetActor(nats.store, 'test');
  await actor.start(2000, 20000, 'personal-default');
  const rows = [
    envelope('test', 'member-alice', 'member.joined', { memberId: 'alice',
      email: 'alice@example.test', displayName: 'Alice', role: 'owner' }),
    envelope('test', 'assistant-assistant', 'assistant.created', {
      assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }),
    envelope('test', 'computer-assistant', 'computer.ready', { assistantId: 'assistant',
      computerId: 'computer', generation: 1, podUid: 'pod' }),
    envelope('test', 'conversation-conversation', 'conversation.created', {
      conversationId: 'conversation', assistantId: 'assistant', createdBy: 'alice',
      mode: 'agent_session' }),
    envelope('test', 'conversation-conversation', 'message.posted', {
      conversationId: 'conversation', authorId: 'alice', authorKind: 'human',
      ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:1', contentType: 'text' }, 'message'),
  ];
  await nats.seed(rows);
  expect(await turnCommand(nats.store, context, input)).toMatchObject({
    payingGroupId: 'personal-default' });
  return actor;
}

const scopes = ['personal-default', 'other', 'recovered'] as const;
async function checksRenewal(scope: typeof scopes[number]) {
  const actor = await seedTurn();
  const scopeId = scope === 'other' ? 'other' : 'personal-default';
  const limit = { scope: 'paying_group', scopeId, ceilingCents: 0, setBy: 'alice' };
  await actor.configure(limit);
  if (scope === 'recovered') {
    await actor.configure({ ...limit, ceilingCents: 20000 });
  }
  const renewal = turnCommand(nats.store, context, input);
  if (scope === 'other') {
    await expect(renewal).resolves.toMatchObject({ payingGroupId: 'personal-default' });
  } else {
    await expect(renewal).rejects.toThrow('spending');
  }
  expect(actor.state.reservations).toEqual([]);
  expect(actor.state.dispatches).toEqual([]);
}
it.each(scopes)('checks the saved turn before renewing after a %s stop', checksRenewal);
