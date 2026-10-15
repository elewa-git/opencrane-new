import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { chatMessageSchema } from '@opencrane/protocol';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachWebSocketServer } from '../src/websocket.ts';
import { expect, it, vi } from 'vitest';
import { conversations } from '@opencrane/projections';
import { envelope } from '@opencrane/models';
import { childFixture, childSession } from './support/child-fixture.ts';

type Fixture = Awaited<ReturnType<typeof childFixture>>;
function request(context: Fixture, path: string, payload?: object, memberId = 'alice',
  child = 'child') {
  const options = { method: payload ? 'POST' as const : 'GET' as const,
    url: `/api/conversations/${child}/${path}`, headers: context.headers(memberId),
    ...(payload === undefined ? {} : { payload }) };
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
    const unrelated = { conversationId: 'parent', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...context.keys.encrypt('test', 'parent', 'Unrelated message') };
    await context.append('conversation-parent', 'message.posted', unrelated, false);
    await context.append('participation-child', 'conversation.closed',
      { conversationId: 'child', closedBy: 'alice' }, false);
    const concurrent = [request(context, 'publications', payload),
      request(context, 'publications', payload)];
    const [sent, duplicate] = await Promise.all(concurrent);
    expect(sent!.statusCode, sent!.body).toBe(200);
    expect(duplicate!.json()).toEqual(sent!.json());
    const sequence = sent!.json<{ sequence: number }>().sequence;
    expect(sequence).toBe(before + 3);
    const changed = { ...payload, text: 'Different answer' };
    expect((await request(context, 'publications', changed)).statusCode).toBe(409);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    const retry = await request(context, 'publications', payload);
    expect(retry.json()).toEqual(sent!.json());
    expect(await context.nats.store.head()).toBe(sequence);
    await context.runner.run(conversations);
    const receipt = await request(context, 'changes/publication', undefined, 'alice', 'parent');
    expect(receipt.json()).toMatchObject({ status: 'appended', sequence });
    await context.append('participation-child', 'participant.removed',
      { conversationId: 'child', participantId: 'bob', removedBy: 'alice' }, false);
    const messages = await request(context, 'messages', undefined, 'bob', 'parent');
    const rows = messages.json<{ rows: { id: string; data: unknown }[] }>().rows;
    function isPublication(row: (typeof rows)[number]) {
      return row.id === 'publication';
    }
    expect(rows.find(isPublication)?.data).toEqual({ text: 'Reviewed answer', authorId: 'alice',
      publicationKind: 'final', contentType: 'text' });
    await context.runner.rebuild(conversations);
    const replay = await request(context, 'messages', undefined, 'bob', 'parent');
    expect(replay.json<{ rows: unknown[] }>().rows).toEqual(rows);
    await socketPublication(context);
    await context.append('participation-parent', 'participant.removed',
      { conversationId: 'parent', participantId: 'bob', removedBy: 'alice' }, false);
    expect((await request(context, 'publications', payload)).json()).toEqual(sent!.json());
  } finally {
    vi.restoreAllMocks();
    await context.close();
  }
}
it('reviews without saving and publishes one credited parent entry across retry and replay',
  publishesOnce, 120_000);

async function refusesChangedReview(change: string) {
  const context = await childFixture();
  const warnings: unknown[] = [];
  function recordWarning(...args: unknown[]) {
    warnings.push(args);
  }
  function captureWarnings(request: FastifyRequest) {
    vi.spyOn(request.log, 'warn').mockImplementation(recordWarning);
    return Promise.resolve();
  }
  context.app.addHook('onRequest', captureWarnings);
  try {
    const input = await savedResult(context);
    const reviewed = await request(context, 'publication-review', input);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const payload = { id: 'refused-publication', text: 'Reviewed answer',
      review: reviewed.json<{ review: string }>().review };
    let status = 'review_stale';
    if (change === 'text') payload.text = 'Edited answer';
    if (change === 'expiry') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    if (change === 'lost') {
      await context.append('conversation-child', 'agent.output_lost',
        { conversationId: 'child', turnId: 'saved-turn' }, false);
    }
    if (change === 'join' || change === 'removal') {
      const type = change === 'join' ? 'participant.added' : 'participant.removed';
      const data = change === 'join'
        ? { conversationId: 'parent', participantId: 'jane', addedBy: 'alice' }
        : { conversationId: 'parent', participantId: 'bob', removedBy: 'alice' };
      await context.append('participation-parent', type, data, false);
    }
    if (change === 'closed') {
      await context.append('participation-parent', 'conversation.closed',
        { conversationId: 'parent', closedBy: 'alice' }, false);
      status = 'parent_closed';
    }
    if (['moved', 'missing', 'incomplete', 'unshared', 'delta', 'outage'].includes(change)) {
      const read = context.nats.store.readStream.bind(context.nats.store);
      async function* moved(...args: Parameters<typeof read>) {
        if (change === 'outage' && args[0] === 'conversation-parent') {
          throw new Error('Private upstream detail');
        }
        for await (const row of read(...args)) {
          const selected = row.event.id === input.resultEventId;
          if (selected && change === 'missing') continue;
          if (change === 'incomplete' && row.event.type === 'agent.turn_completed') continue;
          if (change === 'unshared' && row.event.type === 'agent.turn_started') continue;
          if (selected && change === 'delta') {
            yield { ...row, event: { ...row.event, type: 'agent.message_delta' } };
            continue;
          }
          if (selected && change === 'moved') yield { ...row, sequence: row.sequence + 1 };
          else yield row;
        }
      }
      context.nats.store.readStream = moved;
    }
    const before = await context.nats.store.head();
    const sent = await request(context, 'publications', payload);
    let expected = 409;
    if (change === 'outage') {
      expected = 503;
      status = 'unavailable';
      expect(warnings).toEqual([[{ operation: 'child-publication' },
        'Publication unavailable']]);
    }
    expect(sent.statusCode, sent.body).toBe(expected);
    expect(sent.json()).toEqual({ status });
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    vi.restoreAllMocks();
    await context.close();
  }
}
it.each(['text', 'expiry', 'lost', 'moved', 'missing', 'incomplete', 'unshared',
  'delta', 'outage', 'join', 'removal', 'closed'])(
  'refuses a changed review without an entry: %s', refusesChangedReview, 120_000);

async function refusesUniformly(denial: string) {
  const context = await childFixture();
  try {
    const input = await savedResult(context);
    const reviewed = await request(context, 'publication-review', input);
    const payload = { id: 'denied-publication', text: 'Reviewed answer',
      review: reviewed.json<{ review: string }>().review };
    let member = 'alice';
    let child = 'child';
    if (denial === 'signature') payload.review += 'changed';
    if (denial === 'another-publisher') member = 'bob';
    if (denial === 'unknown' || denial === 'parent') child = denial;
    if (denial === 'parent-only' || denial === 'child-only') {
      member = 'bob';
      let removed = 'child';
      if (denial === 'child-only') {
        removed = 'parent';
        const join = { conversationId: 'child', participantId: 'bob', addedBy: 'alice',
          contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: 1 };
        await context.append('participation-child', 'participant.removed',
          { conversationId: 'child', participantId: 'bob', removedBy: 'alice' });
        await context.append('participation-child', 'participant.added', join);
      }
      await context.append(`participation-${removed}`, 'participant.removed',
        { conversationId: removed, participantId: 'bob', removedBy: 'alice' }, false);
    }
    if (denial === 'private' || denial === 'foreign' || denial === 'other-child') {
      child = denial;
      let data: unknown = { conversationId: child, createdBy: 'alice',
        mode: 'agent_session', assistantId: 'assistant' };
      if (denial === 'other-child') {
        for await (const row of context.nats.store.readStream('conversation-child')) {
          data = { ...z.record(z.string(), z.unknown()).parse(row.event.data), conversationId: child };
          break;
        }
      }
      const event = envelope(denial === 'foreign' ? 'elsewhere' : 'test',
        `conversation-${child}`, 'conversation.created', data);
      await context.nats.seed([event]);
      if (denial !== 'foreign') await context.auth.handler.handle(event, context.db);
    }
    const before = await context.nats.store.head();
    const sent = await request(context, 'publications', payload, member, child);
    expect(sent.statusCode, sent.body).toBe(403);
    expect(sent.json()).toEqual({ status: 'refused' });
    const review = await request(context, 'publication-review', input, member, child);
    if (!['signature', 'another-publisher', 'other-child'].includes(denial)) {
      expect(review.statusCode, review.body).toBe(403);
      expect(review.json()).toEqual({ status: 'refused' });
    }
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    await context.close();
  }
}
it.each(['signature', 'another-publisher', 'unknown', 'parent', 'private', 'foreign',
  'other-child', 'parent-only', 'child-only'])(
  'uses the same refusal for %s', refusesUniformly, 120_000);

async function refusesFiles(fileIds: string[]) {
  const context = await childFixture();
  try {
    const input = { ...await savedResult(context), fileIds };
    const malformed = { method: 'POST' as const,
      url: '/api/conversations/child/publication-review',
      headers: { ...context.headers(), 'content-type': 'application/json' },
      payload: '{"text":"private-body' };
    const invalid = await context.app.inject(malformed);
    expect(invalid.json()).toEqual({ status: 'refused' });
    expect(invalid.headers['cache-control']).toBe('no-store');
    const before = await context.nats.store.head();
    const response = await request(context, 'publication-review', input);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({ status: 'files_unavailable' });
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    await context.close();
  }
}
it.each([[[]], [['private-file-name']]])('refuses any file list without details: %j',
  refusesFiles, 120_000);

async function socketPublication(context: Fixture) {
  const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed: context.feed, binding: context.options.binding, chat: context.options };
  const server = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`,
    { headers: context.headers('bob') });
  try {
    await once(socket, 'open');
    const received = Promise.withResolvers<unknown>();
    function receive(raw: Buffer) {
      const message = chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown);
      if (message.row?.id === 'publication') received.resolve(message.row.data);
    }
    socket.on('message', receive);
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation',
      conversationId: 'parent', since: 0 }));
    expect(await received.promise).toEqual({ text: 'Reviewed answer', authorId: 'alice',
      publicationKind: 'final', contentType: 'text' });
  } finally {
    socket.terminate();
    function close(resolve: () => void) {
      server.close(resolve);
    }
    await new Promise<void>(close);
  }
}
async function closesDuringHistory() {
  const context = await childFixture();
  const released = Promise.withResolvers<void>();
  try {
    const input = await savedResult(context);
    const review = await request(context, 'publication-review', input);
    const payload = { id: 'close-race', text: 'Reviewed answer',
      review: review.json<{ review: string }>().review };
    const reached = Promise.withResolvers<void>();
    const read = context.nats.store.readStream.bind(context.nats.store);
    let paused = false;
    async function* pauseFirstHistoryRead(...args: Parameters<typeof read>) {
      yield* read(...args);
      if (!paused && args[0] === 'conversation-parent') {
        paused = true;
        reached.resolve();
        await released.promise;
      }
    }
    context.nats.store.readStream = pauseFirstHistoryRead;
    const sending = request(context, 'publications', payload).then();
    await reached.promise;
    await context.append('participation-parent', 'conversation.closed',
      { conversationId: 'parent', closedBy: 'alice' }, false);
    const before = await context.nats.store.head();
    released.resolve();
    const response = await sending;
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({ status: 'parent_closed' });
    expect(await context.nats.store.head()).toBe(before);
  } finally {
    released.resolve();
    await context.close();
  }
}
it('refuses a parent close after command history loads', closesDuringHistory, 120_000);
