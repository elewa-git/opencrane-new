import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tokenIssuer } from '@opencrane/auth';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { connectBridge } from '../src/chat/bridge.ts';
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
import { databases, openfga, until } from '@opencrane/authz/testing';
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
const creation = { commandId: 'create-shared', assistantId: 'team-shared', groupId: 'sales', payingGroupId: 'sales',
  name: 'Sales assistant', grants };

async function append(subject: string, type: string, data: unknown, apply = true) {
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
  if (apply && auth.handler.eventTypes.includes(type)) await auth.handler.handle(record, pgDb(dbs.queue));
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
  expect(response.json()).toMatchObject({ status: 'appended', assistantId: 'team-shared' });
  expect((await request('POST', '/api/assistants', creation)).json()).toEqual(response.json());
  const rows = await history(nats.store, 'assistant-team-shared', 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event.data).toEqual({ assistantId: 'team-shared', ownerId: 'sales',
    kind: 'team', payingGroupId: 'sales', name: 'Sales assistant', grants });
}
it('an admin creates a group assistant once with explicit grants', createsSharedAssistantOnce);


async function admitsBootstrappedOwner() {
  const input = { ...creation, assistantId: 'team-first-owner-shared', commandId: 'first-owner-create' };
  expect((await request('POST', '/api/assistants', input, 'bootstrap-owner')).statusCode).toBe(200);
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'bootstrap-owner', addedBy: 'owner',
  });
  const rows = await history(nats.store, 'assistant-team-first-owner-shared', 'test');
  await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
  const session = { id: 'first-owner-session', conversationId: 'first-owner-session',
    assistantId: 'team-first-owner-shared', payingGroupId: 'sales' };
  expect((await request('POST', '/api/conversations', session, 'bootstrap-owner'))
    .statusCode).toBe(200);
}
it('the installed first owner can create a group assistant and bind shared work',
  admitsBootstrappedOwner);

async function provisionsExplicitGrantsAndOneComputer() {
  const rows = await history(nats.store, 'assistant-team-shared', 'test');
  const created = rows[0]!.event;
  const db = pgDb(dbs.queue);
  await auth.handler.handle(created, db);
  const claim = lifecycleHandlers(nats.store)[1];
  await claim.handle(created, db);
  await claim.handle(created, db);
  const lifecycle = await history(nats.store, 'computer-team-shared', 'test');
  expect(lifecycle).toHaveLength(1);
  const seed = modelGrantHandler(nats.store);
  await seed.handle(created, db);
  await seed.handle(created, db);
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (row.event.type === 'grant.given') await auth.handler.handle(row.event, db);
  }
  expect((await auth.actsFor('alice', 'team-shared')).allowed).toBe(true);
  expect((await auth.actsFor('bob', 'team-shared')).allowed).toBe(true);
  expect((await auth.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await auth.use('assistant', 'team-shared', 'model', 'gpt-6-luna')).allowed).toBe(false);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  expect((await rebuilt.actsFor('bob', 'team-shared')).allowed).toBe(true);
  expect((await rebuilt.use('assistant', 'team-shared', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  await runner.run(computers);
  const detail = await request('GET', '/api/assistants/team-shared', undefined, 'bob');
  expect(detail.statusCode).toBe(200);
  expect(detail.json()).toMatchObject({ rows: [{ ownerId: 'sales', kind: 'team',
    name: 'Sales assistant', status: 'claiming', generation: 1 }] });
  expect((await auth.desktop('bob', 'team-shared')).allowed).toBe(false);
}
it('replays group rights and selected grants and repeated reactions claim one computer',
  provisionsExplicitGrantsAndOneComputer);

async function keepsGrantKindsDistinct() {
  const input = { ...creation, assistantId: 'team-sales', commandId: 'sales-assistant' };
  expect((await request('POST', '/api/assistants', input)).statusCode).toBe(200);
  const rows = await history(nats.store, 'assistant-team-sales', 'test');
  const db = pgDb(dbs.queue);
  await auth.handler.handle(rows[0]!.event, db);
  await modelGrantHandler(nats.store).handle(rows[0]!.event, db);
  for await (const row of readEvents(nats.store, 1, await nats.store.head())) {
    if (row.event.type === 'grant.given') await auth.handler.handle(row.event, db);
  }
  expect((await auth.use('assistant', 'team-sales', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await auth.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  const rebuilt = await rebuildMembers(fga.apiUrl, 'test', nats.reader);
  expect((await rebuilt.use('assistant', 'team-sales', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  expect((await rebuilt.use('person', 'bob', 'model', 'gpt-6.1-sol')).allowed).toBe(true);
  const expectedGrant = { resourceType: 'model', resourceId: 'gpt-6.1-sol', relation: 'use' };
  await runner.run(groups);
  const currentGroups = await readGroups(db, 'test', 'sales');
  expect(currentGroups[0]?.access.grants).toContainEqual(expectedGrant);
  await runner.rebuild(groups);
  const replayedGroups = await readGroups(db, 'test', 'sales');
  expect(replayedGroups[0]?.access.grants).toContainEqual(expectedGrant);
}
it('assistant and owning group keep distinct resource grants after replay',
  keepsGrantKindsDistinct);

async function refusesAnotherMembersPrivateSession() {
  for (const id of ['alice', 'bob']) {
    const input = { id: `create-${id}`, conversationId: id,
      assistantId: 'team-shared', payingGroupId: 'sales' };
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
  const retry = { id: 'create-alice', conversationId: 'alice', assistantId: 'team-shared',
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
it('refuses another member at the authenticated WebSocket transcript route',
  refusesPrivateWebSocketRead);

async function refusesSwappedThreadAtAdmission() {
  const lifecycle = await history(nats.store, 'computer-team-shared', 'test');
  const data = z.object({ computerId: z.string() }).parse(lifecycle[0]!.event.data);
  const computerId = data.computerId;
  await append('computer-team-shared', 'computer.ready', {
    assistantId: 'team-shared', computerId, generation: 1, podUid: 'pod',
  });
  const context = { silo: 'test', computerId, assistantId: 'team-shared' };
  const alice = { conversationId: 'alice', turnId: 'message-alice',
    threadId: 'alice-thread', status: 'started' as const };
  await expect(turnCommand(nats.store, context, alice)).rejects.toThrow('binding');
  const authorisedContext = { ...context, binding: auth.binding };
  const first = await turnCommand(nats.store, authorisedContext, alice);
  expect(first).toMatchObject({ requesterId: 'alice', payingGroupId: 'sales' });
  await expect(turnCommand(nats.store, authorisedContext, { ...alice, conversationId: 'bob',
    turnId: 'message-bob' })).rejects.toThrow('Thread');
  const bob = await turnCommand(nats.store, authorisedContext, { ...alice, conversationId: 'bob',
    turnId: 'message-bob', threadId: 'bob-thread' });
  expect(bob).toMatchObject({ requesterId: 'bob', payingGroupId: 'sales' });
  expect(await turnCommand(nats.store, authorisedContext, alice)).toEqual(first);
  const busy = await request('GET', '/api/assistants/team-shared', undefined, 'alice');
  expect(busy.json()).toMatchObject({ rows: [{ busy: true }] });
  await turnCommand(nats.store, authorisedContext, { ...alice, status: 'completed' });
  await turnCommand(nats.store, authorisedContext, { ...alice, conversationId: 'bob',
    turnId: 'message-bob', threadId: 'bob-thread', status: 'completed' });
  const idle = await request('GET', '/api/assistants/team-shared', undefined, 'alice');
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
  const wrongPayer = { id: 'unrelated-payer', conversationId: 'unrelated-payer',
    assistantId: 'team-shared', payingGroupId: 'support' };
  expect((await request('POST', '/api/conversations', wrongPayer, 'alice')).statusCode).toBe(403);
  const changed = { id: 'create-alice', conversationId: 'alice', assistantId: 'team-shared',
    payingGroupId: 'support' };
  expect((await request('POST', '/api/conversations', changed, 'alice')).statusCode).toBe(403);
  const original = await history(nats.store, 'conversation-alice', 'test');
  expect(original[0]?.event.data).toMatchObject({ payingGroupId: 'sales' });
}
it('refuses switching to another authorised payer on a retry', keepsAuthorisedPayerImmutable);

async function ignoresOtherMembersPendingChanges() {
  await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'carol', addedBy: 'owner',
  }, false);
  const transcript = await request('GET', '/api/conversations/alice/messages', undefined, 'alice');
  expect(transcript.statusCode, transcript.body).toBe(200);
  const list = await request('GET', '/api/conversations', undefined, 'alice');
  expect(list.statusCode, list.body).toBe(200);
  expect(list.json()).toMatchObject({ rows: [{ conversationId: 'alice' }] });
  const assistants = await request('GET', '/api/assistants', undefined, 'alice');
  expect(assistants.statusCode, assistants.body).toBe(200);
  const receipt = await request('GET', '/api/assistants/team-shared/changes/create-shared',
    undefined, 'bob');
  expect(receipt.statusCode).toBe(403);
}
it('keeps own sessions and assistant selection available during another member IAM delay',
  ignoresOtherMembersPendingChanges);

async function retriesOwnPendingMembership() {
  if (!chat) throw new Error('Missing chat fixture');
  await append('team-sales', 'team.member_removed', {
    teamId: 'sales', memberId: 'alice', removedBy: 'owner',
  });
  const pending = await append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'alice', addedBy: 'owner',
  }, false);
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const realtime = { feed, binding: auth.binding, chat: { ...chat, feed } };
  const socketApp = buildServer(config, { chat });
  const address = await socketApp.listen({ host: '127.0.0.1', port: 0 });
  const websocketServer = attachWebSocketServer(socketApp.server, socketApp.log, config, realtime);
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
  const messages: string[] = [];
  function collect(raw: Buffer) {
    messages.push(raw.toString());
  }
  function closeServer(resolve: () => void) {
    websocketServer.close(resolve);
  }
  socket.on('message', collect);
  try {
    await once(socket, 'open');
    const transcript = await request('GET', '/api/conversations/alice/messages', undefined, 'alice');
    expect(transcript.statusCode).toBe(503);
    const list = await request('GET', '/api/conversations', undefined, 'alice');
    expect(list.statusCode, list.body).toBe(503);
    const selection = await request('GET', '/api/assistants', undefined, 'alice');
    expect(selection.statusCode).toBe(503);
    const closed = once(socket, 'close');
    const subscription = { type: 'subscribe', topic: 'conversation',
      conversationId: 'alice', since: 0 };
    socket.send(JSON.stringify(subscription));
    expect((await closed)[0]).toBe(1013);
    expect(messages.join(' ')).not.toContain('refused');
  } finally {
    socket.terminate();
    await new Promise<void>(closeServer);
    await socketApp.close();
    await feed.close();
    await auth.handler.handle(pending, pgDb(dbs.queue));
  }
  const applied = await request('GET', '/api/conversations/alice/messages', undefined, 'alice');
  expect(applied.statusCode).toBe(200);
}
it('returns retryable HTTP and socket errors for own membership still being applied',
  retriesOwnPendingMembership);

async function readsAfterPayerRemoval() {
  const input = { ...creation, commandId: 'team-billing-assistant', assistantId: 'team-billing-assistant',
    payingGroupId: 'support' };
  const created = await request('POST', '/api/assistants', input);
  expect(created.statusCode).toBe(200);
  const rows = await history(nats.store, 'assistant-team-billing-assistant', 'test');
  await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
  const claim = lifecycleHandlers(nats.store)[1];
  await claim.handle(rows[0]!.event, pgDb(dbs.queue));
  await runner.run(computers);
  const session = { id: 'billing-session', conversationId: 'billing-session',
    assistantId: 'team-billing-assistant', payingGroupId: 'support' };
  expect((await request('POST', '/api/conversations', session, 'alice')).statusCode).toBe(200);
  const sessions = await history(nats.store, 'conversation-billing-session', 'test');
  await auth.handler.handle(sessions[0]!.event, pgDb(dbs.queue));
  await runner.run(conversations);
  await append('team-support', 'team.member_removed', {
    teamId: 'support', memberId: 'alice', removedBy: 'owner',
  });
  const transcript = await request('GET', '/api/conversations/billing-session/messages',
    undefined, 'alice');
  expect(transcript.statusCode, transcript.body).toBe(200);
  const list = await request('GET', '/api/conversations', undefined, 'alice');
  expect(list.statusCode).toBe(200);
  expect(list.body).toContain('billing-session');
  const assistants = await request('GET', '/api/assistants', undefined, 'alice');
  expect(assistants.statusCode, assistants.body).toBe(200);
  const selection = assistants.json<{
    rows: { assistantId: string; canStartSession: boolean }[];
  }>();
  function isBillingAssistant(row: typeof selection.rows[number]) {
    return row.assistantId === 'team-billing-assistant';
  }
  expect(selection.rows.find(isBillingAssistant)?.canStartSession).toBe(false);
  const post = { id: 'payer-removed-message', text: 'Cannot charge support' };
  expect((await request('POST', '/api/conversations/billing-session/messages', post,
    'alice')).statusCode).toBe(403);
}
it('reads own history after payer removal while refusing new spending', readsAfterPayerRemoval);

// Reuse the payer-removal probe with the real computer channel and a second member.
async function refusesOnlyTheUnpaidTurn() {
  if (!chat) throw new Error('Missing chat fixture');
  await append('team-admission-payer', 'team.created', {
    teamId: 'admission-payer', name: 'Billing', createdBy: 'owner',
  });
  for (const member of ['alice', 'bob']) {
    await append('team-admission-payer', 'team.member_added', {
      teamId: 'admission-payer', memberId: member, addedBy: 'owner',
    });
  }
  const assistantId = 'team-admission';
  const computerId = 'admission-computer';
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, ownerId: 'sales', kind: 'team', payingGroupId: 'admission-payer',
  });
  await append(`computer-${assistantId}`, 'computer.claimed', {
    assistantId, computerId, generation: 1, tokenId: 'token:test',
  });
  await append(`computer-${assistantId}`, 'computer.ready', {
    assistantId, computerId, generation: 1, podUid: 'pod',
  });
  for (const member of ['alice', 'bob']) {
    const conversationId = `admission-${member}`;
    const input = { id: `create-${conversationId}`, conversationId,
      assistantId, payingGroupId: 'admission-payer' };
    expect((await request('POST', '/api/conversations', input, member)).statusCode).toBe(200);
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
    const message = { id: `message-${conversationId}`, text: 'Start work' };
    expect((await request('POST', `/api/conversations/${conversationId}/messages`,
      message, member)).statusCode).toBe(200);
  }
  await append('team-admission-payer', 'team.member_removed', {
    teamId: 'admission-payer', memberId: 'alice', removedBy: 'owner',
  });
  const server = createServer();
  const executedThreads: unknown[] = [];
  let threadCount = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'thread/start') {
      threadCount++;
      return Promise.resolve({ thread: { id: `admission-thread-${threadCount}` } });
    }
    if (method === 'turn/start') executedThreads.push(params['threadId']);
    return Promise.resolve({});
  }
  async function grant() {}
  function credential() {
    return { value: 'test-computer', expiresAt: Date.now() + 120_000 };
  }
  const driver = { rpc, grant, credential, journal: `${directory}/admission-reports` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing computer port');
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyPath = `${directory}/admission-key.pem`;
  await writeFile(keyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: keyPath, issuer: 'https://bridge.test/' });
  const connection = { url: `ws://127.0.0.1:${address.port}/bridge`,
    computerId, assistantId, bearer: 'test-computer' };
  const link = await connectBridge(chat, connection, tokens);
  function send(member: string) {
    const input = { type: 'turn', id: `message-admission-${member}`,
      conversationId: `admission-${member}`, requesterId: member, assistantId,
      text: 'Start work', token: 'preparing', expiresAt: Date.now() + 60_000 };
    link.socket.send(JSON.stringify(input));
  }
  async function aliceFailed() {
    const rows = await history(nats.store, 'conversation-admission-alice', 'test');
    function isFailed(row: typeof rows[number]) {
      return row.event.type === 'agent.turn_failed';
    }
    return rows.some(isFailed) || link.socket.readyState !== WebSocket.OPEN;
  }
  function bobExecuted() {
    return executedThreads.length > 0 || link.socket.readyState !== WebSocket.OPEN;
  }
  try {
    send('alice');
    await until(aliceFailed);
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
    expect(link.rejection).toBeUndefined();
    const stopped = await request('POST', '/api/conversations/admission-alice/messages',
      { id: 'stop-unpaid', stopTurnId: 'message-admission-alice' }, 'alice');
    expect(stopped.statusCode, stopped.body).toBe(200);
    send('bob');
    await until(bobExecuted);
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
    expect(executedThreads).toEqual(['admission-thread-2']);
    const lifecycle = await history(nats.store, `computer-${assistantId}`, 'test');
    function failedAlice(row: typeof lifecycle[number]) {
      const data = z.object({ turnId: z.string().optional(), status: z.string().optional() })
        .parse(row.event.data);
      return data.turnId === 'message-admission-alice' && data.status === 'failed';
    }
    expect(lifecycle.some(failedAlice)).toBe(true);
  } finally {
    link.socket.terminate();
    await link.settled();
    await channel.close();
    server.close();
  }
}
it('refuses an unpaid turn, accepts Stop and admits another member on the same bridge',
  refusesOnlyTheUnpaidTurn);

// Reuse the list probe to bound the work for many sessions on one assistant.
async function listsSixtyTeamSessions() {
  if (!chat) throw new Error('Missing chat fixture');
  for (let index = 0; index < 60; index++) {
    const conversationId = `team-list-${index}`;
    const input = { id: `create-${conversationId}`, conversationId,
      assistantId: 'team-shared', payingGroupId: 'sales' };
    const response = await request('POST', '/api/conversations', input, 'alice');
    expect(response.statusCode, response.body).toBe(200);
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
  }
  await runner.run(conversations);
  const reads = vi.spyOn(nats.store, 'readStream');
  try {
    const started = performance.now();
    const response = await request('GET', '/api/conversations', undefined, 'alice');
    const elapsed = performance.now() - started;
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ rows: { conversationId: string }[] }>();
    function isTeamList(row: typeof result.rows[number]) {
      return row.conversationId.startsWith('team-list-');
    }
    expect(result.rows.filter(isTeamList)).toHaveLength(60);
    expect(elapsed).toBeLessThan(3000);
    expect(reads.mock.calls.length).toBeLessThan(140);
  } finally {
    reads.mockRestore();
  }
}
it('lists 60 private team sessions without repeating each assistant access check',
  listsSixtyTeamSessions, 120_000);

async function refusesRevokedOwnerGroupBeforeIamCatchesUp() {
  await append('team-support', 'team.member_added', {
    teamId: 'support', memberId: 'bob', addedBy: 'owner',
  });
  const record = envelope('test', 'team-sales', 'team.member_removed', {
    teamId: 'sales', memberId: 'bob', removedBy: 'owner',
  });
  expect((await nats.store.append({ event: record,
    expectedSequence: await nats.store.head('team-sales') })).status).toBe('appended');
  const input = { id: 'removed-member', conversationId: 'removed-member', assistantId: 'team-shared',
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
  const first = { ...creation, assistantId: 'team-race', commandId: 'create-race' };
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
  const rows = await history(nats.store, 'assistant-team-race', 'test');
  expect(rows).toHaveLength(1);
  const claim = lifecycleHandlers(nats.store)[1];
  await claim.handle(rows[0]!.event, pgDb(dbs.queue));
  await claim.handle(rows[0]!.event, pgDb(dbs.queue));
  expect(await history(nats.store, 'computer-team-race', 'test')).toHaveLength(1);
  expect((await request('POST', '/api/assistants', {
    ...first, grants: [{ resourceType: 'model', resourceId: 'gpt-6-luna' }],
  })).statusCode).toBe(409);
  expect((await request('POST', '/api/assistants', {
    ...creation, assistantId: 'team-forbidden', commandId: 'member-create',
  }, 'alice')).statusCode).toBe(403);
}
it('racing creation commands cannot claim extra computers and altered retries refuse',
  serialisesRepeatedCreation);

async function validatesCreationInput() {
  for (const changes of [
    { assistantId: 'personal-future-member' },
    { name: 'Sales\0assistant' },
    { payingGroupId: 'missing-group' },
    { grants: [{ resourceType: 'mcp_server', resourceId: 'invalid.server' }] },
  ]) {
    const input = { ...creation, ...changes, commandId: 'invalid-input' };
    const response = await request('POST', '/api/assistants', input);
    expect(response.statusCode).toBe(changes.payingGroupId ? 403 : 400);
  }
}
it('refuses personal ids, NUL names, missing payers and invalid MCP ids', validatesCreationInput);

async function keepsOneRequestDeadline() {
  async function stallIdentityRead() {
    await delay(2100);
  }
  const cases = [
    { url: '/api/assistants', sub: 'owner', subject: 'assistant-team-late-assistant',
      input: { ...creation, commandId: 'team-late-assistant', assistantId: 'team-late-assistant' } },
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
it('late identity resolution cannot restart the assistant creation deadline', keepsOneRequestDeadline);
