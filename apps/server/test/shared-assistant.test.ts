import { WebSocket } from 'ws';
import { once } from 'node:events';
import { attachWebSocketServer } from '../src/websocket.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history, modelGrantHandler } from '@opencrane/models';
import {
  computers, conversations, groups, members, connectMemberFeed, pgDb,
  ProjectionRunner, readEvents, readGroups,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { lifecycleHandlers } from '../../ops/src/lifecycle.ts';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let directory: string;
let chat: NonNullable<Parameters<typeof buildServer>[1]>['chat'];
let counter = 0;
let delayIdentity: (() => Promise<void>) | undefined;
const grants = [{ resourceType: 'model', resourceId: 'gpt-6.1-sol' }];
const creation = { commandId: 'create-shared', assistantId: 'shared', groupId: 'sales',
  name: 'Sales assistant', grants };

async function append(subject: string, type: string, data: unknown) {
  const record = envelope('test', subject, type, data, `shared-fixture-${++counter}`);
  record.source = 'opencrane-server';
  if (type === 'silo.owner_bootstrapped') {
    const owner = z.object({ identity: z.object({ sub: z.string() }) }).parse(data);
    record.principal = { kind: 'human', id: owner.identity.sub };
  }
  if (type === 'member.joined') {
    const joined = z.object({ memberId: z.string() }).parse(data);
    record.principal = { kind: 'human', id: joined.memberId };
  }
  const result = await nats.store.append({ event: record,
    expectedSequence: await nats.store.head(subject) });
  expect(result.status).toBe('appended');
  if (auth.handler.eventTypes.includes(type)) await auth.handler.handle(record, pgDb(dbs.queue));
  return record;
}
async function memberId(_silo: string, _issuer: string, sub: string) {
  await delayIdentity?.();
  return sub;
}
function request(method: 'GET' | 'POST', url: string, payload?: unknown, sub = 'owner') {
  const headers = {
    origin: 'https://app.example.test', 'content-type': 'application/json',
    cookie: `${config.cookieName}=${encodeSession(config, { sub, orgId: 'org-test',
      roles: [], authTime: 1790856000, exp: 2000000000 })}`,
  };
  return app.inject({ method, url, headers, ...(payload ? { payload: JSON.stringify(payload) } : {}) });
}
async function initialise() {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  directory = await mkdtemp(`${tmpdir()}/shared-assistant-`);
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.store, createLogger('shared-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(computers);
  await runner.initialise(conversations);
  await runner.initialise(groups);
  await append('member-bootstrap-owner', 'silo.owner_bootstrapped', {
    memberId: 'bootstrap-owner', role: 'owner', email: 'first@example.test',
    displayName: 'First owner', identity: { issuer: config.issuerUrl, sub: 'bootstrap-owner' },
  });
  for (const [id, role] of [['owner', 'owner'], ['alice', 'member'], ['bob', 'member']]) {
    await append(`member-${id}`, 'member.invited', { memberId: id, role,
      email: `${id}@example.test`, invitedBy: 'owner', invitationId: `invite-${id}`,
      invitedIdentity: { issuer: config.issuerUrl, sub: id } });
    await append(`member-${id}`, 'member.joined', { memberId: id, role,
      email: `${id}@example.test`, displayName: id, invitationId: `invite-${id}` });
  }
  await append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'owner',
  });
  for (const id of ['alice', 'bob']) {
    await append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: id, addedBy: 'owner',
    });
  }
  await runner.run(members);
  chat = { silo: 'test', store: nats.store, db, binding,
    feed: { memberId }, keys: conversationKeys(directory) };
  app = buildServer(config, { chat });
}
beforeAll(initialise, 120_000);
async function close() {
  await app?.close();
  await nats?.close();
  await dbs?.close();
  await fga?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
}
afterAll(close);

async function createsSharedAssistantOnce() {
  const response = await request('POST', '/api/assistants', creation);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ status: 'appended', assistantId: 'shared' });
  expect((await request('POST', '/api/assistants', creation)).json()).toEqual(response.json());
  const rows = await history(nats.store, 'assistant-shared', 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event.data).toEqual({ assistantId: 'shared', ownerId: 'sales',
    kind: 'team', name: 'Sales assistant', grants });
}
it('an admin creates a group assistant once with explicit grants', createsSharedAssistantOnce);


async function admitsBootstrappedOwner() {
  const input = { ...creation, assistantId: 'first-owner-shared', commandId: 'first-owner-create' };
  expect((await request('POST', '/api/assistants', input, 'bootstrap-owner')).statusCode).toBe(200);
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'bootstrap-owner', addedBy: 'owner',
  });
  const rows = await history(nats.store, 'assistant-first-owner-shared', 'test');
  await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
  const session = { id: 'first-owner-session', conversationId: 'first-owner-session',
    assistantId: 'first-owner-shared', payingGroupId: 'sales' };
  expect((await request('POST', '/api/conversations', session, 'bootstrap-owner'))
    .statusCode).toBe(200);
}
it('the installed first owner can create a group assistant and bind shared work',
  admitsBootstrappedOwner);

async function provisionsExplicitGrantsAndOneComputer() {
  const rows = await history(nats.store, 'assistant-shared', 'test');
  const created = rows[0]!.event;
  const db = pgDb(dbs.queue);
  await auth.handler.handle(created, db);
  const claim = lifecycleHandlers(nats.store)[1];
  await claim.handle(created, db);
  await claim.handle(created, db);
  const lifecycle = await history(nats.store, 'computer-shared', 'test');
  expect(lifecycle).toHaveLength(1);
  const seed = modelGrantHandler(nats.store);
  await seed.handle(created, db);
  await seed.handle(created, db);
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (row.event.type === 'grant.given') await auth.handler.handle(row.event, db);
  }
  expect((await auth.actsFor('alice', 'shared')).allowed).toBe(true);
  expect((await auth.actsFor('bob', 'shared')).allowed).toBe(true);
  expect((await auth.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await auth.use('assistant', 'shared', 'model', 'gpt-6-luna')).allowed).toBe(false);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  expect((await rebuilt.actsFor('bob', 'shared')).allowed).toBe(true);
  expect((await rebuilt.use('assistant', 'shared', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  await runner.run(computers);
  const detail = await request('GET', '/api/assistants/shared', undefined, 'bob');
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({ rows: [{ ownerId: 'sales', kind: 'team',
    name: 'Sales assistant', status: 'claiming', generation: 1 }] });
  expect((await auth.desktop('bob', 'shared')).allowed).toBe(false);
}
it('replays group rights and selected grants and repeated reactions claim one computer',
  provisionsExplicitGrantsAndOneComputer);

async function keepsGrantKindsDistinct() {
  const input = { ...creation, assistantId: 'sales', commandId: 'sales-assistant' };
  expect((await request('POST', '/api/assistants', input)).statusCode).toBe(200);
  const rows = await history(nats.store, 'assistant-sales', 'test');
  const db = pgDb(dbs.queue);
  await modelGrantHandler(nats.store).handle(rows[0]!.event, db);
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (row.event.type === 'grant.given') await auth.handler.handle(row.event, db);
  }
  expect((await auth.use('assistant', 'sales', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await auth.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  expect((await rebuilt.use('assistant', 'sales', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await rebuilt.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  const expectedGrant = { resourceType: 'model', resourceId: 'gpt-6.1-sol', relation: 'use' };
  await runner.run(groups);
  const currentGroups = await readGroups(db, 'test', 'sales');
  expect(currentGroups[0]?.access.grants).toContainEqual(expectedGrant);
  await runner.rebuild(groups);
  const replayedGroups = await readGroups(db, 'test', 'sales');
  expect(replayedGroups[0]?.access.grants).toContainEqual(expectedGrant);
}
it('assistant and owning group with the same id keep distinct resource grants',
  keepsGrantKindsDistinct);

async function refusesAnotherMembersPrivateSession() {
  for (const id of ['alice', 'bob']) {
    const input = { id: `create-${id}`, conversationId: id,
      assistantId: 'shared', payingGroupId: 'sales' };
    expect((await request('POST', '/api/conversations', input, id)).statusCode).toBe(200);
    const rows = await history(nats.store, `conversation-${id}`, 'test');
    await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
    const message = { id: `message-${id}`, text: `Private request from ${id}` };
    expect((await request('POST', `/api/conversations/${id}/messages`, message, id))
      .statusCode).toBe(200);
  }
  // Even a mistaken participant grant cannot disclose a private execution session.
  await append('conversation-alice', 'participant.added', {
    conversationId: 'alice', participantId: 'bob', addedBy: 'owner',
  });
  await runner.run(conversations);
  expect((await request('GET', '/api/conversations/alice/messages', undefined, 'bob'))
    .statusCode).toBe(403);
  expect((await request('POST', '/api/conversations/alice/messages', {
    id: 'bob-resume', text: 'Resume Alice context',
  }, 'bob')).statusCode).toBe(403);
  const list = await request('GET', '/api/conversations', undefined, 'bob');
  expect(list.body).not.toContain('Private request from alice');
  expect(list.json()).toMatchObject({ rows: [{ conversationId: 'bob' }] });
  const retry = { id: 'create-alice', conversationId: 'alice', assistantId: 'shared',
    payingGroupId: 'sales' };
  expect((await request('POST', '/api/conversations', retry, 'alice')).statusCode).toBe(200);
  expect((await request('POST', '/api/conversations', { ...retry, payingGroupId: 'other' },
    'alice')).statusCode).toBe(403);
}
it('refuses cross-member reads and resumption even with a conversation participant grant',
  refusesAnotherMembersPrivateSession);


async function refusesPrivateWebSocketRead() {
  if (!chat) throw new Error('Missing chat fixture');
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  expect(await feed.memberId('test', config.issuerUrl, 'bob')).toBe('bob');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const realtimeChat = { ...chat, feed };
  const realtime = { feed, binding: auth.binding, chat: realtimeChat };
  const websocketServer = attachWebSocketServer(app.server, app.log, config, realtime);
  const session = { sub: 'bob', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
  const messages: string[] = [];
  function collect(raw: unknown) {
    messages.push(z.instanceof(Buffer).parse(raw).toString());
  }
  function closed(resolve: () => void) {
    websocketServer.close(resolve);
  }
  socket.on('message', collect);
  try {
    await once(socket, 'open');
    const closure = once(socket, 'close');
    const subscription = { type: 'subscribe', topic: 'conversation',
      conversationId: 'alice', since: 0 };
    socket.send(JSON.stringify(subscription));
    const closureValues: unknown = await closure;
    const [code] = z.tuple([z.number(), z.instanceof(Buffer)]).parse(closureValues);
    expect(code).toBe(1008);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!)).toMatchObject({ type: 'refused' });
    expect(messages.join(' ')).not.toContain('Private request from alice');
  } finally {
    socket.terminate();
    await new Promise<void>(closed);
    await feed.close();
  }
}
it('refuses another member at the authenticated WebSocket transcript seam',
  refusesPrivateWebSocketRead);

async function refusesSwappedThreadAtAdmission() {
  const lifecycle = await history(nats.store, 'computer-shared', 'test');
  const data = z.object({ computerId: z.string() }).parse(lifecycle[0]!.event.data);
  const computerId = data.computerId;
  await append('computer-shared', 'computer.ready', {
    assistantId: 'shared', computerId, generation: 1, podUid: 'pod',
  });
  const context = { silo: 'test', computerId, assistantId: 'shared' };
  const alice = { conversationId: 'alice', turnId: 'message-alice',
    threadId: 'alice-thread', status: 'started' as const };
  const first = await turnCommand(nats.store, context, alice);
  expect(first).toMatchObject({ requesterId: 'alice', payingGroupId: 'sales' });
  await expect(turnCommand(nats.store, context, { ...alice, conversationId: 'bob',
    turnId: 'message-bob' })).rejects.toThrow('Thread');
  const bob = await turnCommand(nats.store, context, { ...alice, conversationId: 'bob',
    turnId: 'message-bob', threadId: 'bob-thread' });
  expect(bob).toMatchObject({ requesterId: 'bob', payingGroupId: 'sales' });
  expect(await turnCommand(nats.store, context, alice)).toEqual(first);
  const busy = await request('GET', '/api/assistants/shared', undefined, 'alice');
  expect(busy.json()).toMatchObject({ rows: [{ busy: true }] });
  await turnCommand(nats.store, context, { ...alice, status: 'completed' });
  await turnCommand(nats.store, context, { ...alice, conversationId: 'bob',
    turnId: 'message-bob', threadId: 'bob-thread', status: 'completed' });
  const idle = await request('GET', '/api/assistants/shared', undefined, 'alice');
  expect(idle.json()).toMatchObject({ rows: [{ busy: false }] });
}
it('admits concurrent requester threads and refuses a thread previously bound to another member',
  refusesSwappedThreadAtAdmission);

async function keepsAuthorisedPayerImmutable() {
  await append('team-support', 'team.created', {
    teamId: 'support', name: 'Support', createdBy: 'owner',
  });
  await append('team-support', 'team.member_added', {
    teamId: 'support', memberId: 'alice', addedBy: 'owner',
  });
  const changed = { id: 'create-alice', conversationId: 'alice', assistantId: 'shared',
    payingGroupId: 'support' };
  expect((await request('POST', '/api/conversations', changed, 'alice')).statusCode).toBe(409);
  const original = await history(nats.store, 'conversation-alice', 'test');
  expect(original[0]?.event.data).toMatchObject({ payingGroupId: 'sales' });
}
it('refuses switching to another authorised payer on a retry', keepsAuthorisedPayerImmutable);

async function refusesRevokedOwnerGroupBeforeIamCatchesUp() {
  await append('team-support', 'team.member_added', {
    teamId: 'support', memberId: 'bob', addedBy: 'owner',
  });
  const record = envelope('test', 'team-sales', 'team.member_removed', {
    teamId: 'sales', memberId: 'bob', removedBy: 'owner',
  });
  expect((await nats.store.append({ event: record,
    expectedSequence: await nats.store.head('team-sales') })).status).toBe('appended');
  const input = { id: 'removed-member', conversationId: 'removed-member', assistantId: 'shared',
    payingGroupId: 'support' };
  expect((await request('POST', '/api/conversations', input, 'bob')).statusCode).toBe(403);
  expect((await request('GET', '/api/conversations/bob/messages', undefined, 'bob'))
    .statusCode).toBe(403);
  const list = await request('GET', '/api/conversations', undefined, 'bob');
  expect(list.statusCode).toBe(200);
  expect(list.json()).toEqual({ rows: [] });
}
it('refuses a revoked assistant audience even with a different authorised payer and stale IAM',
  refusesRevokedOwnerGroupBeforeIamCatchesUp);

async function serialisesRepeatedCreation() {
  const first = { ...creation, assistantId: 'race', commandId: 'create-race' };
  const second = { ...first, commandId: 'create-race-again' };
  const firstRequest = request('POST', '/api/assistants', first);
  const secondRequest = request('POST', '/api/assistants', second);
  const results = await Promise.all([firstRequest, secondRequest]);
  function status(response: typeof results[number]) {
    return response.statusCode;
  }
  const statuses = results.map(status);
  statuses.sort();
  expect(statuses).toEqual([200, 409]);
  const rows = await history(nats.store, 'assistant-race', 'test');
  expect(rows).toHaveLength(1);
  const claim = lifecycleHandlers(nats.store)[1];
  await claim.handle(rows[0]!.event, pgDb(dbs.queue));
  await claim.handle(rows[0]!.event, pgDb(dbs.queue));
  expect(await history(nats.store, 'computer-race', 'test')).toHaveLength(1);
  expect((await request('POST', '/api/assistants', {
    ...first, grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna' }],
  })).statusCode).toBe(409);
  expect((await request('POST', '/api/assistants', {
    ...creation, assistantId: 'forbidden', commandId: 'member-create',
  }, 'alice')).statusCode).toBe(403);
}
it('racing creation commands cannot claim extra computers and altered retries refuse',
  serialisesRepeatedCreation);

async function keepsOneRequestDeadline() {
  async function stallIdentityRead() {
    await delay(2100);
  }
  const cases = [
    { url: '/api/conversations', sub: 'alice', subject: 'conversation-late-session',
      input: { id: 'late-session', conversationId: 'late-session',
        assistantId: 'shared', payingGroupId: 'sales' } },
    { url: '/api/assistants', sub: 'owner', subject: 'assistant-late-assistant',
      input: { ...creation, commandId: 'late-assistant', assistantId: 'late-assistant' } },
  ];
  delayIdentity = stallIdentityRead;
  const heads = vi.spyOn(nats.store, 'head');
  const reads = vi.spyOn(nats.store, 'readStream');
  try {
    for (const testCase of cases) {
      heads.mockClear();
      reads.mockClear();
      const started = performance.now();
      const response = await request('POST', testCase.url, testCase.input, testCase.sub);
      const deadline = heads.mock.calls[0]?.[1];
      expect(deadline).toBeLessThanOrEqual(started + 2500);
      for (const read of reads.mock.calls) {
        expect(read[2]).toBeLessThanOrEqual(started + 2500);
      }
      expect(response.statusCode).not.toBe(200);
      expect(await history(nats.store, testCase.subject, 'test')).toEqual([]);
    }
  } finally {
    delayIdentity = undefined;
    heads.mockRestore();
    reads.mockRestore();
  }
}
it('late identity resolution cannot restart the shared authority deadline', keepsOneRequestDeadline);
