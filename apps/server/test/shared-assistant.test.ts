import { Pool } from 'pg';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tokenIssuer } from '@opencrane/auth';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { WebSocket, WebSocketServer } from 'ws';
import * as modelAuthority from '@opencrane/models';
import { chatCommand } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { watchBridges } from '../src/chat/bridge.ts';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
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
import * as privateHistory from '../src/chat/private-context.ts';
import { turnMessage, type AgentSession } from '../src/chat/bridge-conversation.ts';
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
  // Seed saved history, including old participant subjects that commands now refuse.
  const savedHistory = [record];
  await nats.seed(savedHistory);
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
    threadId: 'alice-thread', status: 'started' as const, executionMode: 'restricted' as const };
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

async function refusesOnlyOneTurn(refusal: string, sharedChild = false) {
  const prefix = sharedChild ? `admission-child-${refusal}` : `admission-${refusal}`;
  if (!chat) throw new Error('Missing chat fixture');
  await append(`team-${prefix}-payer`, 'team.created', {
    teamId: `${prefix}-payer`, name: 'Billing', createdBy: 'owner',
  });
  for (const member of ['alice', 'bob']) {
    await append(`team-${prefix}-payer`, 'team.member_added', {
      teamId: `${prefix}-payer`, memberId: member, addedBy: 'owner',
    });
  }
  const assistantId = `team-${prefix}`;
  const computerId = `${prefix}-computer`;
  await append(`assistant-${assistantId}`, 'assistant.created', {
    assistantId, ownerId: sharedChild ? `${prefix}-payer` : 'sales',
    kind: 'team', payingGroupId: `${prefix}-payer`,
  });
  await append(`computer-${assistantId}`, 'computer.claimed', {
    assistantId, computerId, generation: 1, tokenId: 'token:test',
  });
  await append(`computer-${assistantId}`, 'computer.ready', {
    assistantId, computerId, generation: 1, podUid: 'pod',
  });
  for (const member of ['alice', 'bob']) {
    const conversationId = `${prefix}-${member}`;
    const input = { id: `create-${conversationId}`, conversationId,
      assistantId, payingGroupId: `${prefix}-payer` };
    if (sharedChild && member === 'alice') {
      await seedClosedChildInput(conversationId, assistantId, `${prefix}-payer`);
      continue;
    }
    expect((await request('POST', '/api/conversations', input, member)).statusCode).toBe(200);
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
    const message = { id: `message-${conversationId}`, text: 'Start work' };
    expect((await request('POST', `/api/conversations/${conversationId}/messages`,
      message, member)).statusCode).toBe(200);
  }
  if (refusal === 'payer') {
    await append(`team-${prefix}-payer`, 'team.member_removed', {
      teamId: `${prefix}-payer`, memberId: 'alice', removedBy: 'owner',
    });
  } else {
    await append(`${refusal}-${prefix}-alice`, 'conversation.closed', {
      conversationId: `${prefix}-alice`, closedBy: 'alice',
    });
  }
  const server = createServer();
  const executedThreads: unknown[] = [];
  let threadCount = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'thread/start') {
      threadCount++;
      return Promise.resolve({ thread: { id: `${prefix}-thread-${threadCount}`,
        ephemeral: true, path: null, environments: [] } });
    }
    if (method === 'turn/start') executedThreads.push(params['threadId']);
    return Promise.resolve({});
  }
  async function grant() {}
  function credential() {
    return { value: 'test-computer', expiresAt: Date.now() + 120_000 };
  }
  function privateSession() {
    return Promise.resolve({ rpc, close() {}, closed: new Promise<void>(function pending() {}) });
  }
  const driver = { rpc, privateSession, grant, credential, journal: `${directory}/${prefix}-reports` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing computer port');
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyPath = `${directory}/${prefix}-key.pem`;
  await writeFile(keyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: keyPath, issuer: 'https://bridge.test/' });
  const connection = { url: `ws://127.0.0.1:${address.port}/bridge`,
    computerId, assistantId, bearer: 'test-computer' };
  const link = await connectBridge(chat, connection, tokens);
  const sent = vi.spyOn(link.socket, 'send');
  function acknowledgements() {
    const frames: Record<string, unknown>[] = [];
    for (const call of sent.mock.calls) {
      if (typeof call[0] !== 'string') continue;
      const frame = z.record(z.string(), z.unknown()).parse(JSON.parse(call[0]));
      if (frame['type'] === 'ack') frames.push(frame);
    }
    return frames;
  }
  function send(member: string) {
    const input = { type: 'turn', id: `message-${prefix}-${member}`,
      conversationId: `${prefix}-${member}`, requesterId: member, assistantId,
      executionMode: 'restricted',
      ...(sharedChild && member === 'alice' ? { sharingClass: 'shared_only' } : {}),
      text: 'Start work', token: 'preparing', expiresAt: Date.now() + 60_000 };
    link.socket.send(JSON.stringify(input));
  }
  async function aliceFailed() {
    const rows = await history(nats.store, `conversation-${prefix}-alice`, 'test');
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
    if (sharedChild) {
      function failureAcknowledged() {
        return acknowledgements().length === 2;
      }
      await until(failureAcknowledged);
      expect(acknowledgements()).toEqual([
        { type: 'ack', sequence: 1, refused: 'Conversation is closed' },
        { type: 'ack', sequence: 2 },
      ]);
      const beforeReplay = await nats.store.head();
      link.socket.send(JSON.stringify({ type: 'resume', since: 1 }));
      function replayAcknowledged() {
        return acknowledgements().length === 3;
      }
      await until(replayAcknowledged);
      expect(acknowledgements()[2]).toEqual({ type: 'ack', sequence: 2 });
      expect(await nats.store.head()).toBe(beforeReplay);
      expect(link.socket.readyState).toBe(WebSocket.OPEN);
    }
    if (refusal === 'payer') {
      const stopped = await request('POST', `/api/conversations/${prefix}-alice/messages`,
        { id: 'stop-unpaid', stopTurnId: `message-${prefix}-alice` }, 'alice');
      expect(stopped.statusCode, stopped.body).toBe(200);
    }
    send('bob');
    await until(bobExecuted);
    expect(link.socket.readyState).toBe(WebSocket.OPEN);
    expect(executedThreads).toEqual([`${prefix}-thread-2`]);
    const lifecycle = await history(nats.store, `computer-${assistantId}`, 'test');
    function failedAlice(row: typeof lifecycle[number]) {
      const data = z.object({ turnId: z.string().optional(), status: z.string().optional() })
        .parse(row.event.data);
      return data.turnId === `message-${prefix}-alice` && data.status === 'failed';
    }
    expect(lifecycle.some(failedAlice)).toBe(true);
    if (sharedChild) {
      const failures = lifecycle.filter(failedAlice);
      expect(failures).toHaveLength(1);
      function startedAlice(row: typeof lifecycle[number]) {
        const data = z.record(z.string(), z.unknown()).parse(row.event.data);
        return row.event.type === 'computer.turn_started'
          && data['turnId'] === `message-${prefix}-alice`;
      }
      expect(lifecycle.some(startedAlice)).toBe(false);
    }
  } finally {
    sent.mockRestore();
    link.socket.terminate();
    await link.settled();
    await channel.close();
    server.close();
  }
}
async function seedClosedChildInput(conversationId: string, assistantId: string,
  payingGroupId: string) {
  chat!.keys.provision('test', conversationId);
  const created = { conversationId, assistantId, payingGroupId, createdBy: 'alice',
    mode: 'agent_session', contextKind: 'shared_child',
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
    origin: { parentConversationId: 'parent', sourceMessageId: 'source', sourcePosition: 2,
      intentEventId: 'intent', intentPosition: 3, requestId: conversationId,
      firstInputId: `message-${conversationId}` } };
  await append(`conversation-${conversationId}`, 'conversation.created', created, false);
  const message = { conversationId, authorId: 'alice', authorKind: 'human', contentType: 'text',
    ...chat!.keys.encrypt('test', conversationId, 'Start work') };
  const row = envelope('test', `conversation-${conversationId}`, 'message.posted',
    message, `message-${conversationId}`);
  await nats.seed([row]);
}

async function refusesSharedChildWithoutDisconnecting(closeStream: string) {
  await refusesOnlyOneTurn(closeStream, true);
}

async function refusesUnpaidTurn() {
  await refusesOnlyOneTurn('payer');
}
it('refuses an unpaid turn, accepts Stop and admits another member on the same bridge',
  refusesUnpaidTurn);

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
    const rows: { conversationId: string }[] = [];
    let nextCursor: string | null = null;
    do {
      reads.mockClear();
      const started = performance.now();
      let url = '/api/conversations';
      if (nextCursor) url += `?cursor=${encodeURIComponent(nextCursor)}`;
      const response = await request('GET', url, undefined, 'alice');
      const elapsed = performance.now() - started;
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json<{ rows: { conversationId: string }[];
        nextCursor: string | null }>();
      expect(result.rows.length).toBeLessThanOrEqual(20);
      rows.push(...result.rows);
      nextCursor = result.nextCursor;
      expect(elapsed).toBeLessThan(3000);
      expect(reads.mock.calls.length).toBeLessThan(140);
    } while (nextCursor);
    function isTeamList(row: typeof rows[number]) {
      return row.conversationId.startsWith('team-list-');
    }
    const teamRows = rows.filter(isTeamList);
    expect(teamRows).toHaveLength(60);
    function conversationId(row: typeof rows[number]) {
      return row.conversationId;
    }
    const conversationIds = teamRows.map(conversationId);
    expect(new Set(conversationIds).size).toBe(60);
  } finally {
    reads.mockRestore();
  }
}
it('lists 60 private team sessions without repeating each assistant access check',
  listsSixtyTeamSessions, 120_000);

async function refusesClosedPrivateTurn(closeStream: string) {
  await refusesOnlyOneTurn(closeStream);
}
it.each(['conversation', 'participation'])(
  'refuses one member after %s changes and admits another on the same bridge',
  refusesClosedPrivateTurn);

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
  expect(list.json()).toEqual({ rows: [], nextCursor: null });
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


async function privateServerFixture(name: string, personal = false) {
  if (!chat) throw new Error('Missing chat fixture');
  const assistantId = `team-private-${name}`;
  const computerId = `private-${name}`;
  const group = `private-${name}`;
  await append(`team-${group}`, 'team.created', { teamId: group, name: group, createdBy: 'owner' });
  for (const member of ['alice', 'bob']) {
    await append(`team-${group}`, 'team.member_added', { teamId: group, memberId: member, addedBy: 'owner' });
  }
  await append(`assistant-${assistantId}`, 'assistant.created', { assistantId,
    ownerId: personal ? 'alice' : group, kind: personal ? 'personal' : 'team', payingGroupId: group });
  await append(`computer-${assistantId}`, 'computer.claimed', {
    assistantId, computerId, generation: 1, tokenId: 'token:test' });
  await append(`computer-${assistantId}`, 'computer.ready', {
    assistantId, computerId, generation: 1, podUid: 'pod' });
  for (const member of ['alice', 'bob']) {
    const conversationId = `${name}-${member}`;
    chat.keys.provision('test', conversationId);
    await append(`conversation-${conversationId}`, 'conversation.created', {
      conversationId, assistantId, createdBy: member, mode: 'agent_session', payingGroupId: group });
  }
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyPath = `${directory}/${name}-key.pem`;
  await writeFile(keyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: keyPath, issuer: 'https://bridge.test/' });
  const context = { silo: 'test', assistantId, computerId, binding: auth.binding };
  async function post(member: string, id: string, text = id, memoryFree = false) {
    const result = await chatCommand(nats.store, chat!.keys, { silo: 'test', memberId: member },
      { id, text, conversationId: `${name}-${member}`,
        ...(memoryFree ? { executionMode: 'memory_free' as const } : {}) });
    expect(result.status).toBe('appended');
  }
  const server = createServer();
  const websocketServer = new WebSocketServer({ server });
  let computerSocket!: WebSocket;
  const frames: Record<string, unknown>[] = [];
  function collect(raw: Buffer) {
    frames.push(z.record(z.string(), z.unknown()).parse(JSON.parse(raw.toString())));
  }
  function connected(socket: WebSocket) {
    computerSocket = socket;
    socket.on('message', collect);
  }
  websocketServer.on('connection', connected);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  const link = await connectBridge(chat, { ...context, bearer: 'test',
    url: `ws://127.0.0.1:${address.port}/bridge` }, tokens);
  let sequence = 0;
  const previous = new Map<string, number>();
  async function report(member: string, turnId: string, type: string, extra: Record<string, unknown> = {}) {
    const conversationId = z.string().parse(extra['conversationId'] ?? `${name}-${member}`);
    const value = { sequence: ++sequence, previousSequence: previous.get(conversationId) ?? 0,
      conversationId, turnId, assistantId, requesterId: member, type, ...extra };
    previous.set(conversationId, sequence);
    computerSocket.send(JSON.stringify(value));
    await until(function acknowledged() {
      return frames.some(function matches(frame) {
        return frame['sequence'] === sequence;
      })
        || link.socket.readyState !== WebSocket.OPEN;
    }, 65_000);
    return frames.find(function matches(frame) {
      return frame['sequence'] === sequence;
    });
  }
  async function closeFixture() {
    computerSocket.terminate();
    link.socket.terminate();
    await link.settled();
    websocketServer.close();
    server.close();
  }
  return { context, post, report, frames, link, close: closeFixture, tokens, server, computerSocket };
}

const refusesMismatchedTeamModeBeforeAccessCheck = async (mode: string | undefined) => {
  const test = await privateServerFixture(`mode-${String(mode)}`);
  const fence = vi.spyOn(modelAuthority, 'authorityFence');
  try {
    await test.post('alice', `wrong-mode-${mode}`);
    await test.post('bob', `right-mode-${mode}`);
    fence.mockClear();
    const extra = { threadId: 'wrong-mode-thread', ...(mode ? { executionMode: mode } : {}) };
    const refused = await test.report('alice', `wrong-mode-${mode}`, 'agent.turn_started', extra);
    expect(refused).toMatchObject({ refused: 'Execution mode mismatch' });
    expect(refused).not.toHaveProperty('token');
    expect(refused).not.toHaveProperty('context');
    expect(fence).not.toHaveBeenCalled();
    const rows = await history(nats.store, `computer-${test.context.assistantId}`, 'test');
    expect(rows.at(-1)?.event.data).toMatchObject({ status: 'failed' });
    const admitted = await test.report('bob', `right-mode-${mode}`, 'agent.turn_started', {
      threadId: 'right-mode-thread', executionMode: 'restricted' });
    expect(admitted).toHaveProperty('token');
    await test.report('bob', `right-mode-${mode}`, 'agent.turn_completed');
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    fence.mockRestore();
    await test.close();
  }
};
it.each(['memory_free', undefined])(
  'refuses a team start reported as %s before opening access, without closing the bridge',
  refusesMismatchedTeamModeBeforeAccessCheck
);

const refusesPrivateThreadReuseByTheSameRequester = async () => {
  const test = await privateServerFixture('thread-reuse');
  try {
    await test.post('alice', 'thread-first');
    await test.post('alice', 'thread-second');
    await test.post('bob', 'thread-bob');
    await test.report('alice', 'thread-first', 'agent.turn_started', {
      threadId: 'reused-private', executionMode: 'restricted' });
    await test.report('alice', 'thread-first', 'agent.turn_completed');
    const refused = await test.report('alice', 'thread-second', 'agent.turn_started', {
      threadId: 'reused-private', executionMode: 'restricted' });
    expect(refused).toMatchObject({ refused: 'Private thread reused' });
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
    await expect(turnCommand(nats.store, test.context, { conversationId: 'thread-reuse-bob',
      turnId: 'thread-bob', threadId: 'reused-private', status: 'started',
      executionMode: 'restricted' })).rejects.toThrow('another requester');
    const closed = once(test.link.socket, 'close');
    const reusedThread = { threadId: 'reused-private', executionMode: 'restricted' };
    await test.report('bob', 'thread-bob', 'agent.turn_started', reusedThread);
    expect((await closed)[0]).toBe(1008);
  } finally {
    await test.close();
  }
};
it(
  'refuses private thread reuse by the same requester and retains the cross-requester refusal',
  refusesPrivateThreadReuseByTheSameRequester
);

const sendsOnlyAliceSCompletedExchangeAfterAdmission = async () => {
  const test = await privateServerFixture('context');
  try {
    await test.post('alice', 'context-first', 'alice-request-canary');
    await test.report('alice', 'context-first', 'agent.turn_started', {
      threadId: 'context-first-thread', executionMode: 'restricted' });
    await test.report('alice', 'context-first', 'agent.message_delta', { messageId: 'reply', text: 'delta-only-canary' });
    await test.report('alice', 'context-first', 'agent.reasoning_summarised', { text: 'reasoning-canary' });
    await test.report('alice', 'context-first', 'agent.command_ran', { commandDigest: 'a'.repeat(64), exitCode: 0 });
    await test.report('alice', 'context-first', 'agent.message_completed', { messageId: 'reply', text: 'alice-reply-canary' });
    await test.report('alice', 'context-first', 'agent.turn_completed');
    await test.post('alice', 'context-next');
    const ack = await test.report('alice', 'context-next', 'agent.turn_started', {
      threadId: 'context-next-thread', executionMode: 'restricted' });
    expect(ack).toHaveProperty('context');
    const text = JSON.stringify(ack);
    expect(text).toContain('alice-request-canary');
    expect(text).toContain('alice-reply-canary');
    expect(text).not.toMatch(/delta-only-canary|reasoning-canary|commandDigest/u);
    await test.post('bob', 'context-bob');
    const bob = await test.report('bob', 'context-bob', 'agent.turn_started', {
      threadId: 'context-bob-thread', executionMode: 'restricted' });
    expect(JSON.stringify(bob)).not.toContain('alice-');
    await test.post('alice', 'context-tools', 'tools', true);
    const tools = await test.report('alice', 'context-tools', 'agent.turn_started', {
      threadId: 'context-tools-thread', executionMode: 'memory_free' });
    expect(tools).toHaveProperty('token');
    expect(tools).not.toHaveProperty('context');
  } finally {
    await test.close();
  }
};
it(
  'sends only Alice’s completed exchange after admission and no private context to Bob or memory-free work',
  sendsOnlyAliceSCompletedExchangeAfterAdmission
);

const readsLongPrivateContextOnlyAfterTheTurn = async () => {
  const test = await privateServerFixture('long-context');
  try {
    await test.post('alice', 'long-first');
    const content = chat!.keys.encrypt('test', 'long-context-alice', 'delta');
    const events = [];
    for (let index = 0; index < 400; index++) {
      const event = envelope('test', 'conversation-long-context-alice', 'agent.message_delta', {
        conversationId: 'long-context-alice', turnId: 'long-first', messageId: 'reply',
        contentType: 'text', ...content }, `long-delta-${index}`);
      events.push(event);
    }
    await nats.seed(events);
    const nextContent = chat!.keys.encrypt('test', 'long-context-alice', 'next message');
    const nextMessage = envelope('test', 'conversation-long-context-alice', 'message.posted', {
      conversationId: 'long-context-alice', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...nextContent,
    }, 'long-next');
    await nats.seed([nextMessage]);
    const reads = vi.spyOn(nats.store, 'readStream');
    const appends = vi.spyOn(nats.store, 'append');
    const fence = vi.spyOn(modelAuthority, 'authorityFence');
    try {
      const ack = await test.report('alice', 'long-next', 'agent.turn_started', {
        threadId: 'long-thread', executionMode: 'restricted' });
      expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
      expect(ack).toHaveProperty('context');
      expect(ack).toHaveProperty('token');
      expect(fence.mock.calls[0]?.[2]).toEqual(['member-alice', `assistant-${test.context.assistantId}`,
        'team-private-long-context', 'team-private-long-context']);
      const opened = fence.mock.invocationCallOrder[0]!;
      const turnAppendIndex = appends.mock.calls.findIndex(function isTurnAppend(call) {
        return z.object({ type: z.string() }).parse(call[0].event).type === 'computer.turn_started';
      });
      const saved = appends.mock.invocationCallOrder[turnAppendIndex]!;
      const contextReads: number[] = [];
      for (const [index, call] of reads.mock.calls.entries()) {
        if (call[0] === 'conversation-long-context-alice') contextReads.push(reads.mock.invocationCallOrder[index]!);
      }
      expect(contextReads.some(function during(order) {
        return order > opened && order < saved;
      })).toBe(false);
      expect(contextReads.some(function after(order) {
        return order > saved;
      })).toBe(true);
    } finally {
      reads.mockRestore();
      appends.mockRestore();
      fence.mockRestore();
    }
  } finally {
    await test.close();
  }
};
it(
  'reads long private context only after the turn append and keeps the four small access streams',
  readsLongPrivateContextOnlyAfterTheTurn,
  120_000
);

const storesLostOutputAcceptsReplayOverTextAnd = async () => {
  const test = await privateServerFixture('output-lost');
  try {
    await test.post('alice', 'output-turn');
    const base = { conversationId: 'output-lost-alice', turnId: 'output-turn',
      assistantId: test.context.assistantId, requesterId: 'alice' };
    const output = { ...base, sequence: 1, previousSequence: 0, type: 'agent.message_completed',
      messageId: 'reply', text: 'output-canary' };
    expect(await recordReport(nats.store, chat!.keys, test.context, output)).toBe('recorded');
    expect(await recordReport(nats.store, chat!.keys, test.context,
      { ...base, sequence: 1, previousSequence: 0, type: 'agent.output_lost' })).toBe('duplicate');
    expect(await recordReport(nats.store, chat!.keys, test.context,
      { ...base, sequence: 2, previousSequence: 1, type: 'agent.output_lost' })).toBe('recorded');
    await recordReport(nats.store, chat!.keys, test.context,
      { ...base, sequence: 3, previousSequence: 2, type: 'agent.turn_started', threadId: 'lost-thread' });
    await expect(recordReport(nats.store, chat!.keys, test.context,
      { ...base, sequence: 3, previousSequence: 2, type: 'agent.output_lost' })).rejects.toThrow('Report sequence reused');
    const rows = await history(nats.store, 'conversation-output-lost-alice', 'test');
    expect(rows.at(-2)?.event.type).toBe('agent.output_lost');
  } finally {
    await test.close();
  }
};
it(
  'stores lost output, accepts replay over text, and rejects replay over a start report',
  storesLostOutputAcceptsReplayOverTextAnd
);

const storesTheMemoryFreeRequestAndRefusesChanged = async () => {
  const test = await privateServerFixture('request-mode');
  try {
    const url = '/api/conversations/request-mode-alice/messages';
    const posted = await request('POST', url, { id: 'requested-tools', text: 'tools',
      executionMode: 'memory_free' }, 'alice');
    expect(posted.statusCode, posted.body).toBe(200);
    expect((await request('POST', url, { id: 'requested-tools', text: 'tools' }, 'alice')).statusCode).toBe(409);
    for (const executionMode of ['restricted', 'other']) {
      expect((await request('POST', url, { id: 'invalid-mode', text: 'tools', executionMode }, 'alice')).statusCode).toBe(400);
    }
    const rows = await history(nats.store, 'conversation-request-mode-alice', 'test');
    expect(rows.at(-1)?.event.data).toMatchObject({ executionMode: 'memory_free' });
  } finally {
    await test.close();
  }
};
it(
  'stores the memory-free request and refuses changed retries and other modes',
  storesTheMemoryFreeRequestAndRefusesChanged
);

const dispatchesRequiredExecutionModes = async (personal: boolean) => {
  const test = await privateServerFixture(`dispatch-${String(personal)}`, personal);
  const stop = new AbortController();
  const watcherPool = new Pool({ connectionString: await dbs.postgres() });
  const watcherDb = pgDb(watcherPool);
  const watcherLogger = createLogger('dispatch-fixture');
  const watcherProjection = new ProjectionRunner(watcherDb, nats.store, watcherLogger);
  await watcherProjection.initialise(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials').mockResolvedValue(undefined);
  function rewrite(request: { url?: string }) {
    request.url = '/bridge';
  }
  test.server.on('upgrade', rewrite);
  const address = test.server.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  let work: Promise<void> | undefined;
  try {
    await test.post('alice', `dispatch-first-${personal}`);
    await test.post('bob', `dispatch-tools-${personal}`, 'tools', true);
    for (const member of ['alice', 'bob']) {
      const rows = await history(nats.store, `conversation-dispatch-${personal}-${member}`, 'test');
      const created = rows[0]!;
      await conversations.apply(watcherDb, created.event, created.sequence);
    }
    work = watchBridges({ ...chat!, db: watcherDb }, test.tokens, kube, `http://127.0.0.1:${address.port}`, stop.signal);
    await until(function dispatched() {
      return test.frames.some(function first(frame) {
        return frame['id'] === `dispatch-first-${personal}`;
      })
        && test.frames.some(function tools(frame) {
          return frame['id'] === `dispatch-tools-${personal}`;
        });
    });
    await delay(300);
    const expected = personal ? 'memory_free' : 'restricted';
    expect(test.frames).toContainEqual(expect.objectContaining({ type: 'turn',
      id: `dispatch-first-${personal}`, executionMode: expected }));
    expect(test.frames).toContainEqual(expect.objectContaining({ type: 'turn',
      id: `dispatch-tools-${personal}`, executionMode: 'memory_free' }));
  } finally {
    stop.abort();
    await work;
    credentials.mockRestore();
    await test.close();
    await conversations.drop(watcherDb);
    await watcherPool.end();
  }
};
it.each([false, true])(
  'dispatches required execution modes, personal=%s',
  dispatchesRequiredExecutionModes
);

async function refusesOnlyTheTurnWhenPrivateContextIsUnavailable() {
  const test = await privateServerFixture('context-unavailable');
  await test.post('alice', 'context-unavailable-turn');
  await test.post('bob', 'context-available-turn');
  const readStream = nats.store.readStream.bind(nats.store);
  const appendEvent = nats.store.append.bind(nats.store);
  let admitted = false;
  let failureInjected = false;
  async function rememberAdmission(...args: Parameters<typeof appendEvent>) {
    const result = await appendEvent(...args);
    const event = z.object({ type: z.string() }).parse(args[0].event);
    if (event.type === 'computer.turn_started') admitted = true;
    return result;
  }
  const appends = vi.spyOn(nats.store, 'append').mockImplementation(rememberAdmission);
  async function* readWithContextFailure(...args: Parameters<typeof readStream>) {
    if (args[0] === 'conversation-context-unavailable-alice' && admitted && !failureInjected) {
      failureInjected = true;
      throw new Error('Context fixture unavailable');
    }
    yield* readStream(...args);
  }
  const reads = vi.spyOn(nats.store, 'readStream').mockImplementation(readWithContextFailure);
  try {
    const ack = await test.report('alice', 'context-unavailable-turn', 'agent.turn_started', {
      threadId: 'context-unavailable-thread', executionMode: 'restricted' });
    expect(ack).toMatchObject({ refused: 'Private context unavailable' });
    expect(ack).not.toHaveProperty('token');
    expect(ack).not.toHaveProperty('context');
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
    const rows = await history(nats.store, `computer-${test.context.assistantId}`, 'test');
    expect(rows.at(-1)?.event).toMatchObject({ type: 'computer.turn_closed',
      data: { turnId: 'context-unavailable-turn', status: 'failed' } });
    const bob = await test.report('bob', 'context-available-turn', 'agent.turn_started', {
      threadId: 'context-available-thread', executionMode: 'restricted' });
    expect(bob).toHaveProperty('token');
  } finally {
    reads.mockRestore();
    appends.mockRestore();
    await test.close();
  }
}
it('refuses only the private turn when context is unavailable and keeps other members connected',
  refusesOnlyTheTurnWhenPrivateContextIsUnavailable);

const removedBridgeCases = [
  { personal: true, repeat: false },
  { personal: true, repeat: true },
  { personal: false, repeat: false },
  { personal: false, repeat: true },
];
async function refusesRemovedBridgeRequester(testCase: typeof removedBridgeCases[number]) {
  const name = `removed-${testCase.personal}-${testCase.repeat}`;
  const turnId = `queued-${name}`;
  const test = await privateServerFixture(name, testCase.personal);
  try {
    await append('budget-test', 'budget.ceiling_set', {
      scope: 'global', dailyCeilingCents: 2000, ceilingCents: 20000,
      setBy: 'owner', defaultPayingGroupId: 'sales',
    });
    await test.post('alice', turnId);
    const start = { threadId: 'removed-thread',
      executionMode: testCase.personal ? 'memory_free' : 'restricted' };
    if (testCase.repeat) {
      const first = await test.report('alice', turnId, 'agent.turn_started', start);
      expect(first).toHaveProperty('token');
    }
    await append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'owner',
    }, false);
    await append('member-alice', 'member.invited', {
      memberId: 'alice', invitationId: 'later-invite', role: 'member',
      email: 'alice@example.test', invitedBy: 'owner',
      invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' },
    }, false);
    expect(await auth.check('alice', 'member')).toMatchObject({ allowed: true });
    const refused = await test.report('alice', turnId, 'agent.turn_started', start);
    expect(test.link.rejection).toBeUndefined();
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
    expect(refused).toMatchObject({ refused: 'Active silo membership required' });
    expect(refused).not.toHaveProperty('token');
    expect(refused).not.toHaveProperty('context');
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    vi.restoreAllMocks();
    await test.close();
    await restoreAliceMembership();
  }
}
it.each(removedBridgeCases)(
  'refuses bridge tokens after removal with old SQL and IAM, personal=$personal repeat=$repeat',
  refusesRemovedBridgeRequester);

async function refusesRemovalDuringPrivateHistory() {
  const test = await privateServerFixture('removed-context');
  const readStream = nats.store.readStream.bind(nats.store);
  let removed = false;
  async function* removeDuringHistory(subject: string, from?: number, deadline?: number) {
    if (subject === 'conversation-removed-context-alice') {
      const rows = await history(nats.store, `computer-${test.context.assistantId}`, 'test');
      function isStarted(row: typeof rows[number]) {
        return row.event.type === 'computer.turn_started';
      }
      if (!removed && rows.some(isStarted)) {
        removed = true;
        await append('member-alice', 'member.removed', {
          memberId: 'alice', removedBy: 'owner',
        }, false);
      }
    }
    yield* readStream(subject, from, deadline);
  }
  try {
    await test.post('alice', 'private-turn');
    const reads = vi.spyOn(nats.store, 'readStream');
    reads.mockImplementation(removeDuringHistory);
    const start = { threadId: 'private-thread', executionMode: 'restricted' };
    const refused = await test.report('alice', 'private-turn', 'agent.turn_started', start);
    expect(test.link.rejection).toBeUndefined();
    expect(removed).toBe(true);
    expect(test.link.rejection).toBeUndefined();
    expect(test.link.socket.readyState).toBe(WebSocket.OPEN);
    expect(refused).toMatchObject({ refused: 'Active silo membership required' });
    expect(refused).not.toHaveProperty('token');
    expect(refused).not.toHaveProperty('context');
    reads.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await test.close();
    await restoreAliceMembership();
  }
}
it('refuses credentials and private context when removal arrives during the history read',
  refusesRemovalDuringPrivateHistory);

async function restoreAliceMembership() {
  const rows = await history(nats.store, 'member-alice', 'test');
  for (const row of rows) {
    if (auth.handler.eventTypes.includes(row.event.type)) {
      await auth.handler.handle(row.event, pgDb(dbs.queue));
    }
  }
  await append('member-alice', 'member.joined', {
    memberId: 'alice', invitationId: 'later-invite', role: 'member',
    email: 'alice@example.test', displayName: 'Alice',
  });
}

async function refusesAllAssistantRoutesAfterRemoval() {
  const test = await privateServerFixture('removed-assistant-routes');
  try {
    const assistantId = test.context.assistantId;
    const routes = [
      '/api/assistants',
      `/api/assistants/${assistantId}`,
      `/api/assistants/${assistantId}/changes/create-shared`,
    ];
    expect((await request('GET', routes[0]!, undefined, 'alice')).statusCode).toBe(200);
    await append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'owner',
    });
    await append('member-alice', 'member.removed', { memberId: 'alice', removedBy: 'owner' }, false);
    await append('member-alice', 'member.invited', {
      memberId: 'alice', role: 'admin', invitationId: 'assistant-later-invite',
      email: 'alice@example.test', invitedBy: 'owner',
    }, false);
    expect(await auth.check('alice', 'admin')).toMatchObject({ allowed: true });
    for (const url of routes) {
      const response = await request('GET', url, undefined, 'alice');
      expect(response.statusCode, `${url}: ${response.body}`).toBe(403);
    }
    const before = await nats.store.head('assistant-team-removed-write');
    const payload = { ...creation, commandId: 'removed-create', assistantId: 'team-removed-write' };
    const response = await request('POST', '/api/assistants', payload, 'alice');
    expect(response.statusCode, response.body).toBe(403);
    expect(await nats.store.head('assistant-team-removed-write')).toBe(before);
  } finally {
    await test.close();
    await restoreAliceMembership();
  }
}
it('refuses every assistant administration route after removal with old SQL and IAM',
  refusesAllAssistantRoutesAfterRemoval);

async function childHistoryFixture(name: string) {
  const test = await privateServerFixture(name);
  const conversationId = `${name}-child`;
  const parentId = `${name}-parent`;
  chat!.keys.provision('test', conversationId);
  chat!.keys.provision('test', parentId);
  const created = { conversationId, createdBy: 'alice', mode: 'agent_session' as const,
    contextKind: 'shared_child' as const, assistantId: test.context.assistantId,
    payingGroupId: `private-${name}`,
    initialJoins: [{ participantId: 'alice', parentJoinEventId: 'join', parentJoinPosition: 1 }],
    origin: { parentConversationId: parentId, sourceMessageId: 'source', sourcePosition: 2,
      intentEventId: 'intent', intentPosition: 3, requestId: name, firstInputId: `${name}-first` } };
  await append(`conversation-${conversationId}`, 'conversation.created', created, false);
  async function message(id: string, authorId: string, text: string, target = conversationId) {
    const content = chat!.keys.encrypt('test', target, text);
    const data = { conversationId: target, authorId, authorKind: 'human',
      contentType: 'text', ...content };
    await nats.seed([envelope('test', `conversation-${target}`, 'message.posted', data, id)]);
  }
  async function report(member: string, turnId: string, type: string) {
    const extra = { conversationId, threadId: `${turnId}-thread`, executionMode: 'restricted',
      ...(type === 'agent.turn_started' ? { sharingClass: 'shared_only' } : {}),
      ...(type === 'agent.message_completed' ? { messageId: 'reply', text: 'Shared answer' } : {}) };
    return test.report(member, turnId, type, extra);
  }
  return { ...test, conversationId, parentId, created, message, childReport: report };
}

async function sharesOnlyChildHistory() {
  const test = await childHistoryFixture('shared-history');
  const privateReader = vi.spyOn(privateHistory, 'privateContext');
  try {
    await test.post('alice', 'private-alice', 'alice-private-canary');
    await test.post('bob', 'private-bob', 'bob-private-canary');
    await test.message('source', 'alice', 'Reviewed source', test.parentId);
    await test.message('other-source-author', 'alice', 'parent-author-canary', test.parentId);
    await test.message('other-parent', 'bob', 'parent-other-canary', test.parentId);
    const firstId = test.created.origin.firstInputId;
    await test.message(firstId, 'alice', 'Reviewed source');
    const reads = vi.spyOn(nats.store, 'readStream');
    const appends = vi.spyOn(nats.store, 'append');
    const first = await test.childReport('alice', firstId, 'agent.turn_started');
    expect(first).toHaveProperty('token');
    expect(first).not.toHaveProperty('context');
    function isStart(call: Parameters<typeof nats.store.append>) {
      return z.object({ type: z.string() }).parse(call[0].event).type === 'computer.turn_started';
    }
    const saved = appends.mock.invocationCallOrder[appends.mock.calls.findIndex(isStart)]!;
    let historyAfterAdmission = false;
    for (const [index, call] of reads.mock.calls.entries()) {
      if (call[0].startsWith('conversation-')) {
        expect(call[0]).toBe(`conversation-${test.conversationId}`);
      }
      if (call[0] === `conversation-${test.conversationId}`
        && reads.mock.invocationCallOrder[index]! > saved) {
        historyAfterAdmission = true;
        expect(call[2]).toBeGreaterThan(performance.now());
        expect(call[2]).toBeLessThanOrEqual(performance.now() + 10_000);
      }
    }
    expect(historyAfterAdmission).toBe(true);
    await test.childReport('alice', firstId, 'agent.message_completed');
    await test.childReport('alice', firstId, 'agent.turn_completed');
    await test.message('shared-next', 'bob', 'Next question');
    const next = await test.childReport('bob', 'shared-next', 'agent.turn_started');
    expect(next).toHaveProperty('token');
    expect(next).toMatchObject({ context: { exchanges: [{ member: 'Reviewed source',
      assistant: ['Shared answer'] }], omittedExchanges: 0 } });
    const retry = await test.childReport('bob', 'shared-next', 'agent.turn_started');
    expect(retry?.['context']).toEqual(next?.['context']);
    expect(privateReader).not.toHaveBeenCalled();
    const rows = await history(nats.store, `conversation-${test.conversationId}`, 'test');
    function isFirstInput(row: typeof rows[number]) {
      return row.event.id === firstId;
    }
    const firstMessage = rows.find(isFirstInput)!;
    const conversation: AgentSession = { ...test.created,
      createdAt: firstMessage.event.time, assistantKind: 'team' };
    const frame = turnMessage(chat!, conversation, rows, [], firstMessage, 'restricted');
    expect(frame).toMatchObject({ text: 'Reviewed source', sharingClass: 'shared_only' });
    const savedText: string[] = [];
    for (const row of rows) {
      if (['message.posted', 'agent.message_completed'].includes(row.event.type)) {
        savedText.push(chat!.keys.decrypt('test', test.conversationId, row.event.data));
      }
    }
    const exposed = JSON.stringify([test.frames, frame, rows, savedText]);
    expect(exposed).not.toMatch(/private-canary|parent-author-canary|parent-other-canary/u);
    expect(JSON.stringify(next?.['context'])).not.toMatch(/alice|bob|example.test/u);
  } finally {
    vi.restoreAllMocks();
    await test.close();
  }
}
it('delivers only child exchanges across senders after admission without reading the parent',
  sharesOnlyChildHistory);

async function refusesMismatchedSharedHistory(sharedCreation: boolean) {
  const name = `history-mismatch-${sharedCreation}`;
  const test = await childHistoryFixture(name);
  const conversationId = sharedCreation ? test.conversationId : `${name}-alice`;
  const turnId = test.created.origin.firstInputId;
  const privateReader = vi.spyOn(privateHistory, 'privateContext');
  try {
    await test.message(turnId, 'alice', 'Input', conversationId);
    const binding = { assistantId: test.context.assistantId, computerId: test.context.computerId,
      conversationId, turnId, requesterId: 'alice',
      threadId: `${turnId}-thread`, task: 'chat_turn', payingGroupId: `private-${name}`,
      executionMode: 'restricted', ...(sharedCreation ? {} : { sharingClass: 'shared_only' }) };
    await append(`computer-${test.context.assistantId}`, 'computer.turn_started', binding, false);
    const extra = { conversationId, threadId: binding.threadId, executionMode: 'restricted',
      ...(sharedCreation ? { sharingClass: 'shared_only' } : {}) };
    const ack = await test.report('alice', turnId, 'agent.turn_started', extra);
    expect(ack).toMatchObject({ refused: 'Turn context mismatch' });
    expect(ack).not.toHaveProperty('token');
    expect(ack).not.toHaveProperty('context');
    expect(privateReader).not.toHaveBeenCalled();
    const rows = await history(nats.store, `computer-${test.context.assistantId}`, 'test');
    expect(rows.at(-1)?.event).toMatchObject({ type: 'computer.turn_closed',
      data: { turnId, status: 'failed' } });
  } finally {
    vi.restoreAllMocks();
    await test.close();
  }
}
it.each([true, false])('fails a saved class mismatch without a private fallback, child=%s',
  refusesMismatchedSharedHistory);

const refusedChildReports = [
  { type: 'agent.message_delta', extra: { messageId: 'reply', text: 'Must not be saved' } },
  { type: 'agent.message_completed', extra: { messageId: 'reply', text: 'Must not be saved' } },
  { type: 'agent.output_lost', extra: {} },
  { type: 'agent.turn_completed', extra: {} },
  { type: 'agent.turn_failed', extra: { previousSequence: 0 } },
];
async function rejectsOutputForRefusedChild(testCase: typeof refusedChildReports[number]) {
  const name = `refused-child-${testCase.type.replaceAll('.', '-')}`;
  const test = await childHistoryFixture(name);
  const turnId = `${name}-input`;
  try {
    await test.message(turnId, 'alice', 'Question');
    await append(`conversation-${test.conversationId}`, 'conversation.closed', {
      conversationId: test.conversationId, closedBy: 'alice' });
    const refused = await test.childReport('alice', turnId, 'agent.turn_started');
    expect(refused).toEqual({ type: 'ack', sequence: 1, refused: 'Conversation is closed' });
    const beforeReport = await nats.store.head();
    const closed = once(test.link.socket, 'close');
    const extra = { conversationId: test.conversationId, threadId: `${turnId}-thread`,
      executionMode: 'restricted', ...testCase.extra };
    expect(await test.report('alice', turnId, testCase.type, extra)).toBeUndefined();
    expect((await closed)[0]).toBe(1008);
    expect(await nats.store.head()).toBe(beforeReport);
  } finally {
    await test.close();
  }
}
it.each(refusedChildReports)(
  'rejects $type with invalid output or sequence after a shared child refusal',
  rejectsOutputForRefusedChild);

it.each(['conversation', 'participation'])(
  'accepts a refused shared child failure and replay after %s closure on the real channel',
  refusesSharedChildWithoutDisconnecting);
