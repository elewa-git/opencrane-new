import { createHmac } from 'node:crypto';
import { OpenFgaClient } from '@openfga/sdk';
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
async function savedResult(context: Fixture, kind = 'final') {
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
  if (kind === 'human') {
    return { publicationKind: 'interim', resultEventId: undefined, text: '  Reviewed answer  ' };
  }
  const common = { conversationId: 'child', turnId: 'saved-turn' };
  const start = { ...common, assistantId: 'child-assistant',
    executionMode: 'restricted', sharingClass: 'shared_only' };
  await append('conversation-child', 'agent.turn_started', start, false);
  const encrypted = context.keys.encrypt('test', 'child', 'Saved answer');
  const data = { ...common, messageId: 'saved-message', contentType: 'text', ...encrypted };
  const result = await append('conversation-child', 'agent.message_completed', data, false);
  if (kind === 'final') {
    await append('conversation-child', 'agent.turn_completed', common, false);
  }
  return { publicationKind: kind, resultEventId: result.id, text: '  Reviewed answer  ' };
}
async function publishesOnce(kind: string) {
  const publicationKind = kind === 'human' ? 'interim' : kind;
  const context = await childFixture();
  try {
    const input = await savedResult(context, kind);
    const before = await context.nats.store.head();
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json()).toMatchObject({ status: 'reviewed', text: 'Reviewed answer',
      publicationKind, parentConversationId: 'parent',
      audience: ['alice', 'bob'], publishedBy: 'alice' });
    expect(await context.nats.store.head()).toBe(before);
    const payload = { id: 'publication', review: review.json<{ review: string }>().review,
      text: 'Reviewed answer' };
    const unrelated = { conversationId: 'parent', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...context.keys.encrypt('test', 'parent', 'Unrelated message') };
    await context.append('conversation-parent', 'message.posted', unrelated, false);
    await context.append('participation-child', 'conversation.closed',
      { conversationId: 'child', closedBy: 'alice' }, false);
    if (kind !== 'final') {
      const append = context.nats.store.append.bind(context.nats.store);
      async function loseReply(...args: Parameters<typeof append>) {
        const saved = await append(...args);
        if (saved.status === 'appended') throw new Error('Lost reply');
        return saved;
      }
      context.nats.store.append = loseReply;
      const lost = await request(context, 'publications', payload);
      expect(lost.statusCode, lost.body).toBe(503);
      context.nats.store.append = append;
    }
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
      publicationKind, contentType: 'text' });
    await context.runner.rebuild(conversations);
    const replay = await request(context, 'messages', undefined, 'bob', 'parent');
    expect(replay.json<{ rows: unknown[] }>().rows).toEqual(rows);
    await socketPublication(context, publicationKind);
    await context.append('participation-parent', 'participant.removed',
      { conversationId: 'parent', participantId: 'bob', removedBy: 'alice' }, false);
    expect((await request(context, 'publications', payload)).json()).toEqual(sent!.json());
  } finally {
    vi.restoreAllMocks();
    await context.close();
  }
}
it.each(['final', 'interim', 'human'])(
  'reviews and cancels without saving; publishes once across retry and replay: %s',
  publishesOnce, 120_000);

async function refusesChangedReview(change: string, kind = 'final') {
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
    const input = await savedResult(context, kind);
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
  'refuses a changed review without an entry: %s', refusesFinalChange, 120_000);

async function refusesUniformly(denial: string, kind = 'final') {
  const context = await childFixture();
  try {
    const input = await savedResult(context, kind);
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
  'uses the same refusal for %s', refusesFinalAccess, 120_000);

async function refusesFiles(fileIds: string[], kind = 'final') {
  const context = await childFixture();
  try {
    const input = { ...await savedResult(context, kind), fileIds };
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
  refusesFinalFiles, 120_000);

async function socketPublication(context: Fixture, publicationKind: string) {
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
      if (message.type === 'refused') received.resolve(message);
      if (message.row?.id === 'publication') received.resolve(message.row.data);
    }
    socket.on('message', receive);
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation',
      conversationId: 'parent', since: 0 }));
    expect(await received.promise).toEqual({ text: 'Reviewed answer', authorId: 'alice',
      publicationKind, contentType: 'text' });
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

async function parentHistory(context: Fixture) {
  const rows = [];
  for await (const row of context.nats.store.readStream('conversation-parent')) {
    rows.push(row);
  }
  return rows;
}

async function changesAfterChildHistory(change: string) {
  const context = await childFixture();
  const released = Promise.withResolvers<void>();
  try {
    const input = await savedResult(context);
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    const payload = { id: 'result-race', text: 'Reviewed answer',
      review: review.json<{ review: string }>().review };
    const parentBefore = await parentHistory(context);
    const reached = Promise.withResolvers<void>();
    const read = context.nats.store.readStream.bind(context.nats.store);
    let paused = false;
    async function* pauseCompleteChildHistory(...args: Parameters<typeof read>) {
      let completed = false;
      for await (const row of read(...args)) {
        if (row.event.type === 'agent.turn_completed') completed = true;
        yield row;
      }
      // Wait for the full saved result, not an earlier read of child creation.
      if (!paused && args[0] === 'conversation-child' && completed) {
        paused = true;
        reached.resolve();
        await released.promise;
      }
    }
    context.nats.store.readStream = pauseCompleteChildHistory;
    const sending = request(context, 'publications', payload).then();
    await reached.promise;
    if (change === 'message') {
      const encrypted = context.keys.encrypt('test', 'child', 'Unrelated message');
      const data = { conversationId: 'child', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted };
      await context.append('conversation-child', 'message.posted', data, false);
    } else {
      let turnId = 'saved-turn';
      if (change === 'other-turn') turnId = 'other-turn';
      const data = { conversationId: 'child', turnId };
      await context.append('conversation-child', 'agent.output_lost', data, false);
    }
    released.resolve();
    const response = await sending;
    const parentAfter = await parentHistory(context);
    if (change === 'lost') {
      expect.soft(response.statusCode, response.body).toBe(409);
      expect.soft(response.json()).toEqual({ status: 'review_stale' });
      expect(parentAfter).toEqual(parentBefore);
    } else {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'appended' });
      expect(parentAfter).toHaveLength(parentBefore.length + 1);
      expect(parentAfter.at(-1)?.event.id).toBe('result-race');
    }
  } finally {
    released.resolve();
    await context.close();
  }
}
it.each(['lost', 'message', 'other-turn'])(
  'checks result validity after complete child history loads: %s',
  changesAfterChildHistory, 120_000);

async function verifyPublicationWindow(kind: string, caseName: string) {
  const [window, change] = caseName.split(':');
  const context = await childFixture();
  try {
    const input = await savedResult(context, kind);
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    const payload = { id: 'verify-window', text: 'Reviewed answer',
      review: review.json<{ review: string }>().review };
    const parentBefore = await parentHistory(context);
    const childPosition = await context.nats.store.head('conversation-child');
    let injected = false;
    let readCompleteHistory = false;
    async function injectChange() {
      if (injected) return;
      injected = true;
      if (change === 'message') {
        const encrypted = context.keys.encrypt('test', 'child', 'Unrelated child message');
        const data = { conversationId: 'child', authorId: 'alice', authorKind: 'human',
          contentType: 'text', ...encrypted };
        await context.append('conversation-child', 'message.posted', data, false);
      } else {
        const otherTurn = change === 'other-turn' || change === 'other-failed';
        const failed = change === 'failed' || change === 'other-failed';
        const turnId = otherTurn ? 'other-turn' : 'saved-turn';
        const type = failed ? 'agent.turn_failed' : 'agent.output_lost';
        const data = { conversationId: 'child', turnId,
          ...(failed ? { reason: 'bridge_interrupted' } : {}) };
        await context.append('conversation-child', type, data, false);
      }
    }
    const read = context.nats.store.readStream.bind(context.nats.store);
    async function* interceptRead(...args: Parameters<typeof read>) {
      let completed = false;
      for await (const row of read(...args)) {
        if (row.event.id === input.resultEventId) completed = true;
        yield row;
      }
      if (args[0] === 'conversation-child' && completed) readCompleteHistory = true;
      // Finish both parts of chatHistory, then insert the change before returning.
      if (window === 'history' && readCompleteHistory && args[0] === 'participation-child') {
        await injectChange();
      }
      // The incremental recheck starts immediately after the saved content position.
      if (window === 'recheck' && args[0] === 'conversation-child' &&
          args[1] === childPosition + 1) await injectChange();
    }
    context.nats.store.readStream = interceptRead;
    const append = context.nats.store.append.bind(context.nats.store);
    async function interceptAppend(...args: Parameters<typeof append>) {
      if (window === 'append' && z.object({ type: z.string() }).parse(args[0].event).type ===
          'conversation.child_result_published') {
        await injectChange();
      }
      return append(...args);
    }
    context.nats.store.append = interceptAppend;
    const head = context.nats.store.head.bind(context.nats.store);
    const watched = new Set<string>();
    async function recordHead(subject?: string, deadline?: number) {
      if (subject) watched.add(subject);
      return head(subject, deadline);
    }
    context.nats.store.head = recordHead;
    const response = await request(context, 'publications', payload);
    expect([...watched].sort()).toEqual([
      'member-alice', 'participation-child', 'participation-parent',
    ]);
    const parentAfter = await parentHistory(context);
    const childAfter = [];
    for await (const row of read('conversation-child')) childAfter.push(row);
    expect(injected).toBe(true);
    const lastChild = childAfter.at(-1)!;
    expect(lastChild.sequence).toBeGreaterThan(childPosition);
    if (change === 'lost' || change === 'failed') {
      expect.soft(response.statusCode, response.body).toBe(409);
      expect.soft(response.json()).toEqual({ status: 'review_stale' });
      expect(parentAfter).toEqual(parentBefore);
    } else {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'appended' });
      expect(parentAfter).toHaveLength(parentBefore.length + 1);
    }
  } finally {
    await context.close();
  }
}
const publicationWindows = ['history:lost', 'history:message', 'history:other-turn',
  'recheck:lost', 'recheck:message', 'recheck:other-turn',
  'append:lost', 'append:message', 'append:other-turn',
  'history:failed', 'recheck:failed', 'append:failed',
  'history:other-failed', 'recheck:other-failed', 'append:other-failed'];
for (const kind of ['final', 'interim']) {
  async function checkWindow(caseName: string) {
    await verifyPublicationWindow(kind, caseName);
  }
  it.each(publicationWindows)(
    `keeps ${kind} result valid through the parent append: %s`, checkWindow, 120_000);
}

async function refusesFinalChange(change: string) {
  await refusesChangedReview(change);
}
async function refusesFinalAccess(denial: string) {
  await refusesUniformly(denial);
}
async function refusesFinalFiles(fileIds: string[]) {
  await refusesFiles(fileIds);
}
async function refusesInterimChange(change: string) {
  await refusesChangedReview(change, 'interim');
}
async function refusesInterimAccess(denial: string) {
  await refusesUniformly(denial, 'interim');
}
async function refusesInterimFiles(fileIds: string[]) {
  await refusesFiles(fileIds, 'interim');
}
it.each(['text', 'expiry', 'lost', 'moved', 'missing', 'unshared', 'delta',
  'outage', 'join', 'removal', 'closed'])(
  'refuses changed interim review: %s', refusesInterimChange, 120_000);
it.each(['signature', 'another-publisher', 'unknown', 'parent', 'private', 'foreign',
  'other-child', 'parent-only', 'child-only'])(
  'refuses interim access: %s', refusesInterimAccess, 120_000);
it.each([[[]], [['private-file-name']]])('refuses interim files: %j',
  refusesInterimFiles, 120_000);

async function refusesInterimSource(change: string) {
  const context = await childFixture();
  try {
    const input = await savedResult(context, 'interim');
    if (change === 'final') {
      const data = { conversationId: 'child', turnId: 'saved-turn' };
      await context.append('conversation-child', 'agent.turn_completed', data, false);
    } else {
      const data = { conversationId: 'child', turnId: 'other-turn', messageId: 'delta',
        ...context.keys.encrypt('test', 'child', 'Live text'), contentType: 'text' };
      const delta = await context.append('conversation-child', 'agent.message_delta', data, false);
      input.resultEventId = delta.id;
    }
    const before = await parentHistory(context);
    const response = await request(context, 'publication-review', input);
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toEqual({ status: 'review_stale' });
    expect(await parentHistory(context)).toEqual(before);
  } finally {
    await context.close();
  }
}
it.each(['final', 'delta'])('refuses an interim source that is %s', refusesInterimSource, 120_000);

async function conflictsWithSavedId(change: string) {
  const context = await childFixture();
  try {
    const input = await savedResult(context, 'interim');
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    const payload = { id: 'same-id', text: 'Reviewed answer',
      review: review.json<{ review: string }>().review };
    expect((await request(context, 'publications', payload)).statusCode).toBe(200);
    if (change === 'kind') {
      await context.append('conversation-child', 'agent.turn_completed',
        { conversationId: 'child', turnId: 'saved-turn' }, false);
      input.publicationKind = 'final';
    } else if (change === 'text') {
      input.text = 'Another reviewed answer';
      payload.text = input.text;
    } else {
      input.resultEventId = undefined;
    }
    const changed = await request(context, 'publication-review', input);
    expect(changed.statusCode, changed.body).toBe(200);
    payload.review = changed.json<{ review: string }>().review;
    const before = await parentHistory(context);
    const response = await request(context, 'publications', payload);
    expect(response.statusCode, response.body).toBe(409);
    expect(await parentHistory(context)).toEqual(before);
  } finally {
    await context.close();
  }
}
it.each(['kind', 'text', 'source'])('conflicts with a saved id after changed %s',
  conflictsWithSavedId, 120_000);

async function refusesSignedChanges(change: string) {
  const context = await childFixture();
  try {
    const input = await savedResult(context, 'interim');
    const review = await request(context, 'publication-review', input);
    expect(review.statusCode, review.body).toBe(200);
    const signed = review.json<{ review: string }>().review;
    const decoded = Buffer.from(signed.split('.')[0]!, 'base64url').toString();
    const binding = z.record(z.string(), z.unknown()).parse(JSON.parse(decoded));
    if (change === 'turn') binding['turnId'] = 'other-turn';
    if (change === 'ancestor') binding['parentConversationId'] = 'ancestor';
    if (change === 'silo') binding['silo'] = 'foreign';
    const encoded = Buffer.from(JSON.stringify(binding)).toString('base64url');
    let purpose = 'child-publication';
    if (change === 'purpose') purpose = 'child-review';
    const hmac = createHmac('sha256', context.config.cookieSecret);
    hmac.update(`${purpose}:${encoded}`);
    const signature = hmac.digest('base64url');
    const payload = { id: 'forged', text: 'Reviewed answer', review: `${encoded}.${signature}` };
    const before = await parentHistory(context);
    const response = await request(context, 'publications', payload);
    expect(response.statusCode, response.body).toBe(change === 'turn' ? 409 : 403);
    expect(await parentHistory(context)).toEqual(before);
  } finally {
    await context.close();
  }
}
it.each(['turn', 'ancestor', 'silo', 'purpose'])(
  'refuses an interim review with substituted %s', refusesSignedChanges, 120_000);

async function removesAccessAfterHistory(change: string) {
  const context = await childFixture();
  try {
    const input = await savedResult(context, 'interim');
    const reviewed = await request(context, 'publication-review', input);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const payload = { id: 'access-race', text: 'Reviewed answer',
      review: reviewed.json<{ review: string }>().review };
    let injected = false;
    let historyLoaded = false;
    const read = context.nats.store.readStream.bind(context.nats.store);
    async function* interceptHistory(...args: Parameters<typeof read>) {
      for await (const row of read(...args)) {
        if (row.event.id === input.resultEventId) historyLoaded = true;
        yield row;
      }
      if (injected || !historyLoaded || args[0] !== 'participation-child') return;
      injected = true;
      if (change === 'role') {
        const personId = Buffer.from(JSON.stringify(['test', 'alice'])).toString('base64url');
        const siloId = Buffer.from(JSON.stringify(['test'])).toString('base64url');
        const tuple = { user: `person:${personId}`, relation: 'member', object: `silo:${siloId}` };
        const client = new OpenFgaClient(context.options.binding);
        await client.write({ deletes: [tuple] });
      } else if (change === 'member') {
        const data = { memberId: 'alice', removedBy: 'bob' };
        await context.append('member-alice', 'member.removed', data, false);
      } else {
        let conversationId = 'child';
        if (change === 'parent' || change === 'source' || change === 'close') {
          conversationId = 'parent';
        }
        if (change === 'close') {
          const data = { conversationId, closedBy: 'alice' };
          await context.append('conversation-parent', 'conversation.closed', data, false);
          return;
        }
        const data = { conversationId, participantId: 'alice', removedBy: 'bob' };
        await context.append(`participation-${conversationId}`, 'participant.removed', data, false);
        if (change === 'source') {
          const join = { conversationId, participantId: 'alice', addedBy: 'bob' };
          await context.append('participation-parent', 'participant.added', join);
          const childJoin = { conversationId: 'child', participantId: 'alice', addedBy: 'bob',
            contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: 1 };
          await context.append('participation-child', 'participant.removed',
            { conversationId: 'child', participantId: 'alice', removedBy: 'bob' });
          await context.append('participation-child', 'participant.added', childJoin);
        }
      }
    }
    context.nats.store.readStream = interceptHistory;
    const before = await parentHistory(context);
    const response = await request(context, 'publications', payload);
    expect(injected).toBe(true);
    expect(response.statusCode, response.body).toBe(change === 'close' ? 409 : 403);
    const after = await parentHistory(context);
    if (change === 'close') expect(after).toHaveLength(before.length + 1);
    else expect(after).toEqual(before);
  } finally {
    await context.close();
  }
}
it.each(['child', 'parent', 'source', 'member', 'role', 'close'])(
  'refuses interim publication after history and loss of %s', removesAccessAfterHistory, 120_000);
