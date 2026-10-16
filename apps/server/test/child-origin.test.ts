import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenFgaClient } from '@openfga/sdk';
import { conversations, members } from '@opencrane/projections';
import { chatListSchema, chatOriginSchema } from '@opencrane/protocol';
import { envelope } from '@opencrane/models';
import { z } from 'zod';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { childFixture, childSession } from './support/child-fixture.ts';

type Fixture = Awaited<ReturnType<typeof childFixture>>;
let context: Fixture;
async function setup() {
  context = await childFixture();
}
async function cleanup() {
  vi.restoreAllMocks();
  await context.close();
}
beforeEach(setup);
afterEach(cleanup);

async function savedState() {
  const head = await context.nats.store.head();
  const tables = await context.db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const projections = [];
  for (const { tablename } of tables.rows) {
    const quoted = tablename.replaceAll('"', '""');
    const rows = await context.db.query(`SELECT to_jsonb(t) AS row FROM "${quoted}" t ORDER BY 1`);
    projections.push(rows.rows);
  }
  const client = new OpenFgaClient(context.options.binding);
  const tuples = await client.read({});
  return { head, projections, tuples: tuples.tuples };
}

function get(memberId = 'bob', conversationId = 'child', path = 'origin') {
  const request = { url: `/api/conversations/${conversationId}/${path}`,
    headers: context.headers(memberId) };
  return context.app.inject(request);
}
async function read(code: number, memberId = 'bob', conversationId = 'child') {
  const before = await savedState();
  const decrypt = vi.spyOn(context.keys, 'decrypt');
  decrypt.mockClear();
  const response = await get(memberId, conversationId);
  expect(response.statusCode, response.body).toBe(code);
  expect(response.headers['cache-control']).toBe('no-store');
  if (code === 200) {
    const body = chatOriginSchema.parse(response.json());
    const extra = { ...body, reason: 'hidden' };
    expect(chatOriginSchema.safeParse(extra).success).toBe(false);
  }
  expect(await savedState()).toEqual(before);
  if (response.json<{ status: string }>().status !== 'linked') {
    expect(decrypt).not.toHaveBeenCalled();
  }
  return response;
}
async function seeded() {
  const options = { parentSource: true };
  return childSession(context, 'child', options);
}
async function joinJane() {
  const invitation = { memberId: 'jane', invitationId: 'invite-jane',
    email: 'jane@example.test', role: 'member', invitedBy: 'alice',
    invitedIdentity: { issuer: context.config.issuerUrl, sub: 'jane' } };
  await context.append('member-jane', 'member.invited', invitation, false);
  const joined = { memberId: 'jane', invitationId: invitation.invitationId,
    email: invitation.email, displayName: 'Jane', role: 'member' };
  await context.append('member-jane', 'member.joined', joined);
  await context.runner.run(members);
}
async function add(conversationId: string, participantId: string, iam = true) {
  let data: object = { conversationId, participantId, addedBy: 'alice' };
  if (conversationId === 'child') {
    data = { ...data, contextKind: 'shared_child', joinKind: 'explicit_child',
      reviewPosition: await context.nats.store.head('conversation-child') };
  }
  await context.append(`participation-${conversationId}`, 'participant.added', data, iam);
}
async function remove(conversationId: string, participantId: string) {
  let data: object = { conversationId, participantId, removedBy: 'alice' };
  if (conversationId === 'child') {
    data = { ...data, contextKind: 'shared_child',
      reviewPosition: await context.nats.store.head('conversation-child') };
  }
  await context.append(`participation-${conversationId}`, 'participant.removed', data, false);
}

async function linked() {
  const child = await seeded();
  const origin = z.object({ origin: z.object({ sourceMessageId: z.string(),
    sourcePosition: z.number() }) }).parse(child.data).origin;
  const request = { url: '/api/conversations', headers: context.headers('bob') };
  const list = chatListSchema.parse((await context.app.inject(request)).json());
  function parent(row: (typeof list.rows)[number]) {
    return row.conversationId === 'parent';
  }
  const title = list.rows.find(parent)?.title;
  expect(title).toBe('the-parent-source-messag');
  const response = await read(200);
  const expected = { status: 'linked', parentConversationId: 'parent',
    parentTitle: title, ...origin };
  expect(response.json()).toEqual(expected);
}
it('links the visible source with exactly the reader’s Conversations list title', linked);

async function restricted(kind: string) {
  if (kind === 'missing source') await childSession(context);
  else await seeded();
  let reader = 'bob';
  if (kind !== 'missing source') {
    await joinJane();
    await add('child', 'jane');
    reader = 'jane';
    if (kind !== 'child only') await add('parent', 'jane');
    if (kind === 'removed parent') await remove('parent', 'jane');
  }
  expect((await read(200, reader)).body).toBe('{"status":"restricted"}');
}
it.each(['child only', 'late parent join', 'missing source', 'removed parent'])(
  'returns the identical restricted body for %s', restricted);

async function removedInheritance() {
  await seeded();
  await remove('parent', 'bob');
  expect((await read(403)).body).toBe('{"status":"refused"}');
  await add('parent', 'bob');
  expect((await read(403)).body).toBe('{"status":"refused"}');
}
it('never revives inherited access after parent removal and rejoining', removedInheritance);

async function foreignIds() {
  await seeded();
  await joinJane();
  const direct = { conversationId: 'direct', createdBy: 'alice', mode: 'direct',
    participantIds: ['alice', 'bob'] };
  await context.append('conversation-direct', 'conversation.created', direct);
  const privateChat = { conversationId: 'private', createdBy: 'alice', mode: 'agent_session',
    assistantId: 'assistant' };
  await context.append('conversation-private', 'conversation.created', privateChat);
  const foreignData = { ...direct, conversationId: 'foreign' };
  const foreign = envelope('other-silo', 'conversation-foreign', 'conversation.created', foreignData);
  await context.nats.seed([foreign]);
  const refused = await get('alice', 'missing', 'messages');
  expect(refused.statusCode).toBe(403);
  for (const id of ['missing', 'foreign', 'parent', 'direct', 'private']) {
    expect((await read(403, 'alice', id)).body).toBe(refused.body);
  }
  expect((await read(403, 'jane')).body).toBe(refused.body);
  const removal = { memberId: 'bob', removedBy: 'alice' };
  await context.append('member-bob', 'member.removed', removal, false);
  expect((await read(403)).body).toBe(refused.body);
}
it('matches foreign messages refusal for outsiders, inactive members and every non-child id',
  foreignIds);

async function applying(conversationId: string) {
  await seeded();
  await joinJane();
  await add('child', 'jane', conversationId !== 'child');
  if (conversationId === 'parent') await add('parent', 'jane', false);
  const code = conversationId === 'child' ? 425 : 200;
  const body = conversationId === 'child' ? 'access_applying' : 'restricted';
  expect((await read(code, 'jane')).body).toBe(JSON.stringify({ status: body }));
}
it.each(['parent', 'child'])('classifies unapplied %s access', applying);

async function outageProxy(conversationId: string) {
  const binding = context.options.binding;
  const original = binding.apiUrl;
  const identity = Buffer.from(JSON.stringify(['test', conversationId]));
  const object = `conversation:${identity.toString('base64url')}`;
  async function forward(request: IncomingMessage, reply: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Unexpected proxy body');
      chunks.push(chunk);
    }
    const encoded = Buffer.concat(chunks);
    const body = encoded.toString();
    if (request.url?.endsWith('/check') && body.includes(object)) {
      reply.writeHead(503);
      reply.end('{}');
      return;
    }
    const options = { method: request.method ?? 'POST',
      headers: { 'content-type': 'application/json' }, body };
    const response = await fetch(original + request.url, options);
    reply.writeHead(response.status, { 'content-type': 'application/json' });
    reply.end(await response.text());
  }
  function handle(request: IncomingMessage, reply: ServerResponse) {
    function fail() {
      reply.writeHead(500);
      reply.end();
    }
    void forward(request, reply).catch(fail);
  }
  const proxy = createServer(handle);
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Missing proxy address');
  binding.apiUrl = `http://127.0.0.1:${address.port}`;
  async function close() {
    binding.apiUrl = original;
    proxy.close();
    await once(proxy, 'close');
  }
  return close;
}
async function unavailable(conversationId: string) {
  await seeded();
  const close = await outageProxy(conversationId);
  try {
    expect((await read(503)).body).toBe('{"status":"unavailable"}');
  } finally {
    await close();
  }
}
it.each(['parent', 'child'])('keeps %s IAM outages retryable', unavailable, 60_000);

async function sourceGuard(field: string) {
  await seeded();
  const logged: unknown[][] = [];
  function recordError(...values: unknown[]) {
    logged.push(values);
  }
  function capture(request: FastifyRequest, _reply: FastifyReply, done: () => void) {
    vi.spyOn(request.log, 'error').mockImplementation(recordError);
    done();
  }
  context.app.addHook('onRequest', capture);
  const original = context.nats.store.readStream.bind(context.nats.store);
  async function* readStream(subject: string, from = 1, deadline = Infinity) {
    for await (const row of original(subject, from, deadline)) {
      if (subject === 'conversation-parent' && from > 1) {
        if (field === 'outage') throw new Error('Store unavailable: parent');
        const changed = structuredClone(row);
        if (field === 'position') changed.sequence += 1;
        if (field === 'id') changed.event.id = 'different-source';
        if (field === 'type') changed.event.type = 'conversation.closed';
        if (field === 'silo') changed.event.silo = 'another';
        if (field === 'parent') changed.event.data = { conversationId: 'another' };
        yield changed;
      } else yield row;
    }
  }
  vi.spyOn(context.nats.store, 'readStream').mockImplementation(readStream);
  const response = await read(field === 'outage' ? 503 : 200);
  const status = field === 'outage' ? 'unavailable' : 'restricted';
  expect(response.body).toBe(JSON.stringify({ status }));
  if (field === 'outage') expect(logged).toHaveLength(1);
  expect(JSON.stringify(logged)).not.toContain('parent');
}
it.each(['position', 'id', 'type', 'silo', 'parent', 'outage'])(
  'checks the exact saved source: %s', sourceGuard);

async function delayedContent(kind: string) {
  await seeded();
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = context.nats.store.readStream.bind(context.nats.store);
  async function* readStream(subject: string, from = 1, deadline = Infinity) {
    if (subject === 'conversation-parent' && from > 1) {
      held.resolve();
      await release.promise;
    }
    yield* original(subject, from, deadline);
  }
  const query = context.db.query.bind(context.db);
  const delayedQuery: typeof context.db.query = async function delayedQuery(sql, values) {
    if (sql.includes('WITH visible_first')) {
      held.resolve();
      await release.promise;
    }
    return query(sql, values);
  };
  if (kind === 'title') vi.spyOn(context.db, 'query').mockImplementation(delayedQuery);
  else vi.spyOn(context.nats.store, 'readStream').mockImplementation(readStream);
  let before = await savedState();
  const pending = get().then(completed);
  function completed(response: Awaited<ReturnType<typeof get>>) {
    return response;
  }
  try {
    await Promise.race([held.promise, delay(5000)]);
    if (kind === 'removal') {
      await remove('child', 'bob');
      before = await savedState();
    } else if (kind === 'timeout') await delay(10_100);
    else await delay(2100);
  } finally {
    release.resolve();
  }
  const response = await pending;
  let code = 200;
  let status = 'linked';
  if (kind === 'removal') {
    code = 403;
    status = 'refused';
  } else if (kind === 'timeout') {
    code = 503;
    status = 'unavailable';
  }
  expect(response.statusCode, response.body).toBe(code);
  expect(response.json()).toMatchObject({ status });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(await savedState()).toEqual(before);
}
it.each(['source', 'title', 'removal', 'timeout'])(
  'allows slow content but checks access after source loading: %s', delayedContent);

async function viewerTitle() {
  const child = await seeded();
  await joinJane();
  await add('parent', 'jane');
  const encrypted = context.keys.encrypt('test', 'parent', 'A later visible source');
  const message = { conversationId: 'parent', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...encrypted };
  const source = await context.append('conversation-parent', 'message.posted', message, false);
  const sourcePosition = await context.nats.store.head('conversation-parent');
  const created = z.record(z.string(), z.unknown()).parse(child.data);
  const origin = z.record(z.string(), z.unknown()).parse(created['origin']);
  const data = { ...created, conversationId: 'later-child',
    origin: { ...origin, sourceMessageId: source.id, sourcePosition,
      intentPosition: sourcePosition + 1 } };
  await context.append('conversation-later-child', 'conversation.created', data);
  const explicit = { conversationId: 'later-child', participantId: 'jane', addedBy: 'alice',
    contextKind: 'shared_child', joinKind: 'explicit_child', reviewPosition: sourcePosition };
  await context.append('participation-later-child', 'participant.added', explicit);
  await context.runner.run(conversations);
  const request = { url: '/api/conversations', headers: context.headers('jane') };
  const list = chatListSchema.parse((await context.app.inject(request)).json());
  function parent(row: (typeof list.rows)[number]) {
    return row.conversationId === 'parent';
  }
  const title = list.rows.find(parent)?.title;
  expect(title).toBe('a-later-visible-source');
  const expected = { status: 'linked', parentConversationId: 'parent', parentTitle: title,
    sourceMessageId: source.id, sourcePosition };
  expect((await read(200, 'jane', 'later-child')).json()).toEqual(expected);
  await remove('parent', 'jane');
  expect((await read(200, 'jane', 'later-child')).body).toBe('{"status":"restricted"}');
}
it('uses the reader’s parent history start when choosing the linked title', viewerTitle);
