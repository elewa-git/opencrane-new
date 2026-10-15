import { expect, it, vi } from 'vitest';
import { conversations } from '@opencrane/projections';
import { envelope } from '@opencrane/models';
import { childFixture, childSession } from './support/child-fixture.ts';

type Fixture = Awaited<ReturnType<typeof childFixture>>;
function request(context: Fixture, path: string, payload?: object, memberId = 'alice',
  child = 'child') {
  const options = { method: payload ? 'POST' as const : 'GET' as const,
    url: `/api/conversations/${child}/${path}`, headers: context.headers(memberId), payload };
  return context.app.inject(options);
}
async function savedResult(context: Fixture) {
  const append = context.append;
  async function withSource(...args: Parameters<typeof append>) {
    if (args[0] === 'team-child-team') {
      context.keys.provision('test', 'parent');
      const encrypted = context.keys.encrypt('test', 'parent', 'Please investigate');
      const data = { conversationId: 'parent', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted };
      const source = envelope('test', 'conversation-parent', 'message.posted', data);
      source.id = 'hidden-source';
      await context.nats.seed([source]);
    }
    return append(...args);
  }
  await childSession({ ...context, append: withSource });
  const common = { conversationId: 'child', turnId: 'saved-turn' };
  const start = { ...common, assistantId: 'child-assistant',
    executionMode: 'restricted', sharingClass: 'shared_only' };
  await append('conversation-child', 'agent.turn_started', start, false);
  const encrypted = context.keys.encrypt('test', 'child', 'Saved answer');
  const data = { ...common, messageId: 'saved-message', contentType: 'text', ...encrypted };
  const result = await append('conversation-child', 'agent.message_completed', data, false);
  await append('conversation-child', 'agent.turn_completed', common, false);
  return { publicationKind: 'final', resultEventId: result.id, text: '  Reviewed answer  ' };
}
async function publishesOnce() {
  const context = await childFixture();
  try {
    const input = await savedResult(context);
    const before = await context.nats.store.head();
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json()).toMatchObject({ status: 'reviewed', text: 'Reviewed answer',
      publicationKind: 'final', parentConversationId: 'parent',
      audience: ['alice', 'bob'], publishedBy: 'alice' });
    expect(await context.nats.store.head()).toBe(before);
    const payload = { id: 'publication', review: review.json<{ review: string }>().review,
      text: 'Reviewed answer' };
    const sent = await request(context, 'publications', payload);
    expect(sent.statusCode, sent.body).toBe(200);
    const sequence = sent.json<{ sequence: number }>().sequence;
    expect(sequence).toBe(before + 1);
    const retry = await request(context, 'publications', payload);
    expect(retry.json()).toEqual(sent.json());
    expect(await context.nats.store.head()).toBe(sequence);
    await context.runner.run(conversations);
    const receipt = await request(context, 'changes/publication', undefined, 'alice', 'parent');
    expect(receipt.json()).toMatchObject({ status: 'appended', sequence });
    const messages = await request(context, 'messages', undefined, 'bob', 'parent');
    const rows = messages.json<{ rows: { id: string; data: unknown }[] }>().rows;
    function isPublication(row: (typeof rows)[number]) { return row.id === 'publication'; }
    expect(rows.find(isPublication)?.data).toEqual({ text: 'Reviewed answer', authorId: 'alice',
      publicationKind: 'final', contentType: 'text' });
    await context.runner.rebuild(conversations);
    const replay = await request(context, 'messages', undefined, 'bob', 'parent');
    expect(replay.json<{ rows: unknown[] }>().rows).toEqual(rows);
  } finally {
    vi.restoreAllMocks();
    await context.close();
  }
}
it('reviews without saving and publishes one credited parent entry across retry and replay',
  publishesOnce, 120_000);
