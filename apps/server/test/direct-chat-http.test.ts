import type { ChatOptions } from '../src/chat/routes.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenIssuer } from '@opencrane/auth';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
import { watchBridges } from '../src/chat/bridge.ts';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { until } from '@opencrane/authz/testing';
import { chatMessageSchema } from '@opencrane/protocol';
import { attachWebSocketServer } from '../src/websocket.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers, deleteStoreById } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { wireSubject } from '@opencrane/event-store';
import {
  members, groups, computers, conversations, pgDb, ProjectionRunner, connectMemberFeed,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope, history } from '@opencrane/models';
import { chatListSchema, chatFeedSchema, chatColleaguesSchema, chatChangeSchema,
  chatGroupsSchema, chatGroupSnapshotSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

async function directFixture() {
  const nats = await natsFixture();
  const dbs = await databases();
  const fga = await openfga();
  const directory = await mkdtemp(`${tmpdir()}/direct-http-`);
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
  const binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(binding);
  const keys = conversationKeys(directory);
  const runner = new ProjectionRunner(db, nats.store, createLogger('direct-test'));
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const options: ChatOptions = { silo: 'test', store: nats.store, db, keys, binding, feed };
  const app = buildServer(config, { chat: options });
  async function append(subject: string, type: string, data: unknown, iam = true) {
    const event = envelope('test', subject, type, data);
    event.principal = { id: subject.slice('member-'.length), kind: 'human' };
    // Seed saved history, including old participant subjects that commands now refuse.
    const savedHistory = [event];
    await nats.seed(savedHistory);
    if (iam) await auth.handler.handle(event, db);
    return event;
  }
  for (const memberId of ['alice', 'bob', 'carol']) {
    await append(`member-${memberId}`, 'member.invited', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: memberId },
    }, false);
    await append(`member-${memberId}`, 'member.joined', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      displayName: memberId, role: memberId === 'carol' ? 'owner' : 'member',
    });
  }
  await append('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
  });
  for (const projection of [members, groups, conversations, computers]) {
    await runner.initialise(projection);
    await runner.run(projection);
  }
  function headers(memberId = 'alice') {
    const session = {
      sub: memberId, orgId: 'org-test', roles: [],
      authTime: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
    };
    return {
      origin: new URL(config.redirectUri).origin,
      cookie: `${config.cookieName}=${encodeSession(config, session)}`,
    };
  }
  async function create(mode = 'direct') {
    const directInput = { id: 'create', conversationId: 'direct', mode: 'direct', colleagueId: 'bob' };
    const groupInput = { id: 'create', conversationId: 'direct', mode: 'group',
      participantIds: ['alice', 'bob'] };
    let input: typeof directInput | typeof groupInput = directInput;
    if (mode === 'group') input = groupInput;
    const response = await app.inject({
      method: 'POST', url: '/api/conversations', headers: headers(), payload: input,
    });
    expect(response.statusCode).toBe(200);
    const rows = await history(nats.store, 'conversation-direct', 'test');
    await auth.handler.handle(rows[0]!.event, db);
    await runner.run(conversations);
    return input;
  }
  async function close() {
    await app.close();
    await feed.close();
    await nats.close();
    await dbs.close();
    await fga.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { app, nats, db, auth, runner, headers, append, create, close, config, options, fga, directory, feed };
}

async function saveState(fixture: Awaited<ReturnType<typeof directFixture>>,
  payload: object, memberId = 'alice') {
  const request = { method: 'POST' as const, url: '/api/conversations/direct/state',
    headers: fixture.headers(memberId), payload };
  return fixture.app.inject(request);
}

async function archiveAfterLostReply() {
  const fixture = await directFixture();
  try {
    await fixture.create();
    const input = { id: 'archive', action: 'archive', archived: true,
      joinEventId: 'create', expectedArchivePosition: 0 };
    const append = fixture.nats.store.append.bind(fixture.nats.store);
    async function loseReply(command: Parameters<typeof append>[0]) {
      await append(command);
      return { status: 'unavailable' as const, cause: new Error('Lost reply') };
    }
    const lost = vi.spyOn(fixture.nats.store, 'append');
    lost.mockImplementationOnce(loseReply);
    expect((await saveState(fixture, input)).statusCode).toBe(503);
    lost.mockRestore();
    const statusRequest = { url: '/api/conversations/direct/changes/archive',
      headers: fixture.headers() };
    const status = await fixture.app.inject(statusRequest);
    expect(status.statusCode).toBe(200);
    expect(chatChangeSchema.parse(status.json())).toMatchObject({
      type: 'conversation.archive_set', projection: { content: 'applying', iam: 'current' },
    });
    const retry = await saveState(fixture, input);
    expect(retry.statusCode).toBe(200);
    expect((await history(fixture.nats.store, 'chat-state-alice', 'test'))).toHaveLength(1);
    const changedChoice = { ...input, archived: false };
    expect((await saveState(fixture, changedChoice)).statusCode).toBe(409);
    const changedExpectation = { ...input, expectedArchivePosition: 1 };
    expect((await saveState(fixture, changedExpectation)).statusCode).toBe(409);
    const stale = { ...input, id: 'stale', archived: false };
    expect((await saveState(fixture, stale)).statusCode).toBe(409);
    await fixture.runner.run(conversations);
    const secondDevice = buildServer(fixture.config, { chat: fixture.options });
    try {
      const recent = await secondDevice.inject({ url: '/api/conversations',
        headers: fixture.headers() });
      expect(chatListSchema.parse(recent.json()).rows).toHaveLength(0);
      const archived = await secondDevice.inject({ url: '/api/conversations?section=archived',
        headers: fixture.headers() });
      expect(archived.json<{ rows: unknown[] }>().rows[0]).toMatchObject({
        archived: true, joinEventId: 'create', archivePosition: retry.json<{ sequence: number }>().sequence,
      });
      const bob = await secondDevice.inject({ ...statusRequest, headers: fixture.headers('bob') });
      expect(bob.statusCode).toBe(404);
    } finally {
      await secondDevice.close();
    }
    const foreign = await saveState(fixture, input, 'carol');
    expect(foreign.statusCode).toBe(403);
    const badOrigin = { ...fixture.headers(), origin: 'https://other.example.test' };
    const refused = await fixture.app.inject({ method: 'POST',
      url: '/api/conversations/direct/state', headers: badOrigin, payload: input });
    expect(refused.statusCode).toBe(403);
    expect(refused.headers['cache-control']).toBe('no-store');
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    expect(rows).toHaveLength(1);
    expect(await fixture.nats.store.head()).toBe(rows[0]!.sequence + 1);
  } finally {
    await fixture.close();
  }
}
it('saves archive once after a lost reply and verifies private status before projection',
  archiveAfterLostReply, 120_000);

async function readMaximumAcrossDevices() {
  const fixture = await directFixture();
  try {
    await fixture.create();
    const send = { method: 'POST' as const, url: '/api/conversations/direct/messages',
      headers: fixture.headers('bob'), payload: { id: 'message', text: 'Visible message' } };
    const posted = await fixture.app.inject(send);
    await fixture.runner.run(conversations);
    const throughPosition = posted.json<{ sequence: number }>().sequence;
    const input = { id: 'read', action: 'read', joinEventId: 'create',
      throughPosition, throughEventId: 'message' };
    const wrongId = { ...input, throughEventId: 'wrong' };
    const wrongPosition = { ...input, throughPosition: 1 };
    expect((await saveState(fixture, wrongId)).statusCode).toBe(409);
    expect((await saveState(fixture, wrongPosition)).statusCode).toBe(409);
    const newer = await saveState(fixture, input);
    expect(newer.statusCode).toBe(200);
    expect((await saveState(fixture, input)).body).toBe(newer.body);
    const changedRead = { ...input, throughEventId: 'create' };
    expect((await saveState(fixture, changedRead)).statusCode).toBe(409);
    const creationRows = await history(fixture.nats.store, 'conversation-direct', 'test');
    const older = { ...input, id: 'older-device', throughPosition: creationRows[0]!.sequence,
      throughEventId: 'create' };
    expect((await saveState(fixture, older)).statusCode).toBe(200);
    await fixture.runner.run(conversations);
    await fixture.runner.rebuild(conversations);
    const list = await fixture.app.inject({ url: '/api/conversations', headers: fixture.headers() });
    expect(list.json<{ rows: unknown[] }>().rows[0]).toMatchObject({
      throughPosition, throughEventId: 'message', archived: false,
    });
    const preferences = await history(fixture.nats.store, 'chat-state-alice', 'test');
    expect(preferences).toHaveLength(2);
    expect(await fixture.nats.store.head()).toBe(preferences.at(-1)!.sequence);
    expect(await fixture.nats.store.head('computer-*')).toBe(0);
    expect(await fixture.nats.store.head('budget-*')).toBe(0);
  } finally {
    await fixture.close();
  }
}
it('verifies read references and keeps the maximum across devices and rebuild',
  readMaximumAcrossDevices, 120_000);

async function choicesAfterReaddition() {
  const fixture = await directFixture();
  try {
    await fixture.create('group');
    const archived = { id: 'archive-bob', action: 'archive', archived: true,
      joinEventId: 'create', expectedArchivePosition: 0 };
    expect((await saveState(fixture, archived, 'bob')).statusCode).toBe(200);
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    const read = { id: 'read-bob', action: 'read', joinEventId: 'create',
      throughPosition: rows[0]!.sequence, throughEventId: 'create' };
    expect((await saveState(fixture, read, 'bob')).statusCode).toBe(200);
    await fixture.append('participation-direct', 'participant.removed', {
      conversationId: 'direct', participantId: 'bob', removedBy: 'alice',
    }, false);
    expect((await saveState(fixture, archived, 'bob')).statusCode).toBe(403);
    const status = { url: '/api/conversations/direct/changes/archive-bob',
      headers: fixture.headers('bob') };
    expect((await fixture.app.inject(status)).statusCode).toBe(403);
    const joined = await fixture.append('participation-direct', 'participant.added', {
      conversationId: 'direct', participantId: 'bob', addedBy: 'alice',
    });
    await fixture.runner.run(conversations);
    expect((await saveState(fixture, archived, 'bob')).statusCode).toBe(409);
    expect((await saveState(fixture, read, 'bob')).statusCode).toBe(409);
    expect((await fixture.app.inject(status)).statusCode).toBe(404);
    const list = await fixture.app.inject({ url: '/api/conversations', headers: fixture.headers('bob') });
    expect(list.json<{ rows: unknown[] }>().rows[0]).toMatchObject({
      archived: false, archivePosition: 0, throughPosition: 0, joinEventId: joined.id,
    });
    const preJoin = { ...read, id: 'pre-join', joinEventId: joined.id };
    expect((await saveState(fixture, preJoin, 'bob')).statusCode).toBe(409);
    const fresh = { ...archived, id: 'fresh', joinEventId: joined.id };
    expect((await saveState(fixture, fresh, 'bob')).statusCode).toBe(200);
  } finally {
    await fixture.close();
  }
}
it('refuses removed readers and resets archive and read choices after re-addition',
  choicesAfterReaddition, 120_000);

async function concurrentPreferenceRequests() {
  const fixture = await directFixture();
  try {
    await fixture.create();
    const input = { id: 'same-id', action: 'archive', archived: true,
      joinEventId: 'create', expectedArchivePosition: 0 };
    const retries = [saveState(fixture, input), saveState(fixture, input)];
    const replies = await Promise.all(retries);
    expect(replies[0]!.statusCode).toBe(200);
    expect(replies[1]!.body).toBe(replies[0]!.body);
    const archivePosition = replies[0]!.json<{ sequence: number }>().sequence;
    const changed = { ...input, id: 'raced-id', expectedArchivePosition: archivePosition };
    const opposite = { ...changed, archived: false };
    const races = [saveState(fixture, changed), saveState(fixture, opposite)];
    const outcomes = await Promise.all(races);
    function statusCode(response: (typeof outcomes)[number]) {
      return response.statusCode;
    }
    const codes = outcomes.map(statusCode);
    expect(codes.sort()).toEqual([200, 409]);
    const preferences = await history(fixture.nats.store, 'chat-state-alice', 'test');
    const latestPosition = preferences.at(-1)!.sequence;
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    const read = { id: 'intervening-read', action: 'read', joinEventId: 'create',
      throughPosition: rows[0]!.sequence, throughEventId: 'create' };
    const append = fixture.nats.store.append.bind(fixture.nats.store);
    async function anotherDeviceReads(command: Parameters<typeof append>[0]) {
      expect((await saveState(fixture, read)).statusCode).toBe(200);
      return append(command);
    }
    const concurrent = vi.spyOn(fixture.nats.store, 'append');
    concurrent.mockImplementationOnce(anotherDeviceReads);
    const next = { ...input, id: 'after-read', expectedArchivePosition: latestPosition };
    expect((await saveState(fixture, next)).statusCode).toBe(200);
    concurrent.mockRestore();
    expect((await saveState(fixture, input, 'bob')).statusCode).toBe(200);
    const future = { ...read, id: 'future', throughPosition: 999999 };
    expect((await saveState(fixture, future)).statusCode).toBe(409);
  } finally {
    await fixture.close();
  }
}
it('checks concurrent payloads and retries unrelated preference changes within a bound',
  concurrentPreferenceRequests, 120_000);

async function archiveClosedPersonalSession() {
  const fixture = await directFixture();
  try {
    const created = await fixture.append('conversation-direct', 'conversation.created', {
      conversationId: 'direct', mode: 'agent_session', createdBy: 'alice', assistantId: 'assistant',
    });
    await fixture.append('conversation-direct', 'conversation.closed', {
      conversationId: 'direct', closedBy: 'alice',
    }, false);
    await fixture.runner.run(conversations);
    const before = await fixture.nats.store.head();
    const input = { id: 'personal-archive', action: 'archive', archived: true,
      joinEventId: created.id, expectedArchivePosition: 0 };
    expect((await saveState(fixture, input)).statusCode).toBe(200);
    await fixture.runner.run(conversations);
    const list = await fixture.app.inject({ url: '/api/conversations?section=archived',
      headers: fixture.headers() });
    expect(chatListSchema.parse(list.json()).rows[0]).toMatchObject({ archived: true,
      mode: 'agent_session', status: 'closed' });
    expect(await fixture.nats.store.head()).toBe(before + 1);
    expect(await fixture.nats.store.head('computer-*')).toBe(0);
    expect(await fixture.nats.store.head('budget-*')).toBe(0);
  } finally {
    await fixture.close();
  }
}
it('archives closed personal sessions without spending access or computer activity',
  archiveClosedPersonalSession, 120_000);

it('lets both participants exchange and reload direct messages while keeping owners outside', async () => {
  const fixture = await directFixture();
  const { app, headers, runner } = fixture;
  try {
    const input = await fixture.create();
    const retried = await app.inject({
      method: 'POST', url: '/api/conversations', headers: headers(), payload: input,
    });
    expect(retried.statusCode).toBe(200);
    for (const memberId of ['alice', 'bob']) {
      const response = await app.inject({
        method: 'POST', url: '/api/conversations/direct/messages', headers: headers(memberId),
        payload: { id: `send-${memberId}`, text: `Hello from ${memberId} @agent` },
      });
      expect(response.statusCode).toBe(200);
    }
    await runner.run(conversations);
    for (const memberId of ['alice', 'bob']) {
      const response = await app.inject({
        url: '/api/conversations/direct/messages', headers: headers(memberId),
      });
      expect(response.statusCode).toBe(200);
      const feed = chatFeedSchema.parse(response.json());
      expect(feed.rows).toHaveLength(3);
      expect(feed.rows[2]?.data.text).toBe('Hello from bob @agent');
      const list = await app.inject({ url: '/api/conversations', headers: headers(memberId) });
      const parsed = chatListSchema.parse(list.json());
      expect(parsed.rows[0]).toMatchObject({ mode: 'direct', participantIds: ['alice', 'bob'] });
    }
    const denied = await app.inject({
      url: '/api/conversations/direct/messages', headers: headers('carol'),
    });
    const guessed = await app.inject({
      url: '/api/conversations/guessed/messages', headers: headers('carol'),
    });
    expect(denied.statusCode).toBe(403);
    expect(guessed.statusCode).toBe(403);
    expect(guessed.body).toBe(denied.body);
    const rebuilt = await rebuildMembers(fixture.fga.apiUrl, 'test', fixture.nats.reader, {
      verifyAgainst: fixture.options.binding,
    });
    expect((await rebuilt.conversation('bob', 'direct', 'post')).allowed).toBe(true);
    expect((await rebuilt.conversation('carol', 'direct', 'read')).allowed).toBe(false);
    await deleteStoreById(fixture.fga.apiUrl, rebuilt.binding.storeId);
    await runner.rebuild(conversations);
    const reloaded = await app.inject({
      url: '/api/conversations/direct/messages', headers: headers('bob'),
    });
    expect(chatFeedSchema.parse(reloaded.json()).rows[2]?.data.text).toBe('Hello from bob @agent');
  } finally {
    await fixture.close();
  }
}, 120_000);

it('reconnects in position order and revokes a socket within two seconds before IAM catches up', async () => {
  const fixture = await directFixture();
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await fixture.create();
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = {
      feed: fixture.feed, binding: fixture.options.binding, chat: fixture.options,
    };
    wss = attachWebSocketServer(fixture.app.server, fixture.app.log, fixture.config, realtime);
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    async function connect(since: number, generation?: number) {
      const connectionOptions = { headers: fixture.headers('bob') };
      const connection = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
      connection.on('message', receive);
      await once(connection, 'open');
      const subscription = {
        type: 'subscribe', topic: 'conversation', conversationId: 'direct', since, generation,
      };
      connection.send(JSON.stringify(subscription));
      return connection;
    }
    function isReady() {
      return received.some(isReadyMessage);
    }
    socket = await connect(0);
    await until(isReady);
    const cursor = received.at(-1)!;
    socket.terminate();
    await once(socket, 'close');
    received.length = 0;
    await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(),
      payload: { id: 'offline', text: 'While you were offline' },
    });
    await fixture.runner.run(conversations);
    socket = await connect(cursor.position, cursor.generation);
    await until(isReady);
    const delivered = received.filter(isEventMessage);
    expect(delivered.map(messageId)).toEqual(['offline']);
    const closed = once(socket, 'close');
    const started = performance.now();
    await fixture.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'carol',
    }, false);
    await Promise.race([closed, removalDeadline()]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(received.some(isRefusedMessage)).toBe(true);
    const response = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers('bob'),
    });
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('offline');
  } finally {
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await fixture.close();
  }
}, 120_000);

function isReadyMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'ready';
}
function isEventMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'event';
}
function messageId(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.row?.id;
}

async function readsModeBeforeContentProjection() {
  const fixture = await directFixture();
  try {
    const input = { id: 'create', conversationId: 'direct', mode: 'direct', colleagueId: 'bob' };
    const creationRequest = {
      method: 'POST' as const, url: '/api/conversations', headers: fixture.headers(), payload: input,
    };
    const created = await fixture.app.inject(creationRequest);
    expect(created.statusCode).toBe(200);
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    await fixture.auth.handler.handle(rows[0]!.event, fixture.db);
    const historyRequest = {
      url: '/api/conversations/direct/messages', headers: fixture.headers(),
    };
    const response = await fixture.app.inject(historyRequest);
    expect(response.statusCode).toBe(200);
    expect(chatFeedSchema.parse(response.json())).toMatchObject({
      rows: [], computerState: 'not_applicable',
    });
  } finally {
    await fixture.close();
  }
}

it('reads recorded direct mode before its content projection catches up',
  readsModeBeforeContentProjection, 120_000);

async function removalDeadline() {
  await new Promise(resolve => setTimeout(resolve, 2000));
  throw new Error('Removal did not close the socket within two seconds');
}

it('supplies active colleagues and reconciles the original creation and send without posting again', async () => {
  const fixture = await directFixture();
  try {
    const candidates = await fixture.app.inject({
      url: '/api/chat/colleagues?limit=1', headers: fixture.headers(),
    });
    expect(candidates.statusCode).toBe(200);
    expect(chatColleaguesSchema.parse(candidates.json())).toEqual({
      rows: [{ memberId: 'bob', displayName: 'bob' }], next: 'bob',
    });
    await fixture.create();
    const creation = await fixture.app.inject({
      url: '/api/conversations/direct/changes/create', headers: fixture.headers(),
    });
    expect(creation.statusCode).toBe(200);
    expect(chatChangeSchema.parse(creation.json())).toMatchObject({
      status: 'appended', conversationId: 'direct', commandId: 'create', type: 'conversation.created',
      projection: { content: 'current', iam: 'current' },
    });
    await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(),
      payload: { id: 'sent', text: 'One message' },
    });
    const head = await fixture.nats.store.head();
    const applying = await fixture.app.inject({
      url: '/api/conversations/direct/changes/sent', headers: fixture.headers('bob'),
    });
    expect(applying.statusCode).toBe(404);
    await fixture.runner.run(conversations);
    const send = await fixture.app.inject({
      url: '/api/conversations/direct/changes/sent', headers: fixture.headers('bob'),
    });
    expect(send.statusCode).toBe(200);
    expect(chatChangeSchema.parse(send.json())).toMatchObject({
      status: 'appended', commandId: 'sent', type: 'message.posted',
      projection: { content: 'current', iam: 'current' },
    });
    expect(await fixture.nats.store.head()).toBe(head);
    const unknown = await fixture.app.inject({
      url: '/api/conversations/direct/changes/unknown', headers: fixture.headers(),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ status: 'not_found' });
  } finally {
    await fixture.close();
  }
}, 120_000);

it('refuses invalid audiences, altered commands, mode edits, closed sends and stale membership', async () => {
  const fixture = await directFixture();
  try {
    const input = await fixture.create();
    const invalidBodies = [
      { ...input, id: 'assistant', assistantId: 'assistant' },
      { ...input, id: 'third', participantIds: ['alice', 'bob', 'carol'] },
      { ...input, id: 'self', colleagueId: 'alice' },
      { ...input, id: 'spoof', createdBy: 'carol', silo: 'other' },
    ];
    for (const payload of invalidBodies) {
      const response = await fixture.app.inject({
        method: 'POST', url: '/api/conversations', headers: fixture.headers(), payload,
      });
      expect(response.statusCode).toBe(400);
    }
    const changed = await fixture.app.inject({
      method: 'POST', url: '/api/conversations', headers: fixture.headers(),
      payload: { ...input, colleagueId: 'carol' },
    });
    expect(changed.statusCode).toBe(409);
    const invalidMessages = [
      { id: 'mode-edit', mode: 'agent_session', assistantId: 'assistant' },
      { id: 'stop', stopTurnId: 'message' },
      { id: 'participant', participantId: 'carol' },
    ];
    for (const payload of invalidMessages) {
      const response = await fixture.app.inject({
        method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(), payload,
      });
      expect([400, 409]).toContain(response.statusCode);
    }
    const outsider = await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers('carol'),
      payload: { id: 'outsider', text: 'Not a participant' },
    });
    expect(outsider.statusCode).toBe(403);
    const closedData = { conversationId: 'direct', closedBy: 'alice' };
    await fixture.append('participation-direct', 'conversation.closed', closedData, false);
    const closed = await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(),
      payload: { id: 'after-close', text: 'Must refuse' },
    });
    expect(closed.statusCode).toBe(409);
    await fixture.append('member-bob', 'member.removed', { memberId: 'bob', removedBy: 'carol' }, false);
    const originalRequest = {
      method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers(), payload: input,
    };
    const original = await fixture.app.inject(originalRequest);
    expect(original.statusCode).toBe(200);
    const originalRows = await history(fixture.nats.store, 'conversation-direct', 'test');
    expect(original.json()).toEqual({ status: 'appended', sequence: originalRows[0]!.sequence });
    const removed = await fixture.app.inject({
      method: 'POST', url: '/api/conversations', headers: fixture.headers(),
      payload: { ...input, id: 'new', conversationId: 'new' },
    });
    expect(removed.statusCode).toBe(403);
    const candidates = await fixture.app.inject({
      url: '/api/chat/colleagues', headers: fixture.headers(),
    });
    expect(chatColleaguesSchema.parse(candidates.json())).toEqual({ rows: [{ memberId: 'carol', displayName: 'carol' }], next: null });
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    expect(rows.map(eventType)).toEqual(['conversation.created', 'conversation.closed']);
  } finally {
    await fixture.close();
  }
}, 120_000);

function eventType(row: Awaited<ReturnType<typeof history>>[number]) {
  return row.event.type;
}

it('pages authoritative history and fails closed when IAM is unavailable', async () => {
  const fixture = await directFixture();
  let paused = false;
  try {
    await fixture.create();
    await seedPagingMessages(fixture);
    await fixture.runner.run(conversations);
    const first = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers('bob'),
    });
    expect(first.statusCode).toBe(200);
    const page = chatFeedSchema.parse(first.json());
    expect(page.rows).toHaveLength(100);
    const cursor = page.rows.at(-1)!.position;
    const second = await fixture.app.inject({
      url: `/api/conversations/direct/messages?since=${cursor}`, headers: fixture.headers('bob'),
    });
    expect(second.statusCode).toBe(200);
    const remaining = chatFeedSchema.parse(second.json());
    expect(remaining.rows.map(rowId)).toEqual(['page-99', 'page-100']);
    await fixture.fga.pause();
    paused = true;
    const refused = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers(),
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.body).not.toContain('Message');
  } finally {
    // Do not hide an earlier assertion failure by trying to resume a running fixture.
    try {
      if (paused) await fixture.fga.resume();
    } finally {
      await fixture.close();
    }
  }
}, 120_000);

async function seedPagingMessages(fixture: Awaited<ReturnType<typeof directFixture>>) {
  const previousHead = await fixture.nats.store.head();
  // Paging tests content reads; command admission and retries have separate coverage.
  for (let index = 0; index < 101; index++) {
    const encrypted = fixture.options.keys.encrypt('test', 'direct', `Message ${index}`);
    const data = {
      conversationId: 'direct', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...encrypted,
    };
    const event = envelope('test', 'conversation-direct', 'message.posted', data, `page-${index}`);
    event.principal = { kind: 'human', id: 'alice' };
    await fixture.nats.connection.request(wireSubject(event.subject), JSON.stringify(event));
  }
  expect(await fixture.nats.store.head()).toBe(previousHead + 101);
}

function rowId(row: ReturnType<typeof chatFeedSchema.parse>['rows'][number]) {
  return row.id;
}

it.each(['direct', 'group'])(
  'keeps %s messages out of the bridge, computer, approval and budget paths',
  async (mode) => {
  const fixture = await directFixture();
  let requests = 0;
  function recordRequest(request: IncomingMessage, response: ServerResponse) {
    requests++;
    request.resume();
    response.writeHead(500);
    response.end();
  }
  const upstream = createServer(recordRequest);
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  try {
    await fixture.create(mode);
    await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(),
      payload: { id: 'human', text: 'Ordinary text @agent' },
    });
    await fixture.runner.run(conversations);
    const head = await fixture.nats.store.head();
    const keyOptions = { namedCurve: 'P-256' };
    const keyPair = generateKeyPairSync('ec', keyOptions);
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const privateKeyPath = `${fixture.directory}/issuer.pem`;
    await writeFile(privateKeyPath, privateKey);
    const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://direct.test/' });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const address = upstream.address();
    if (!address || typeof address === 'string') throw new Error('Missing upstream port');
    const kube = new SandboxClient('/unused-direct-kubeconfig', 'test');
    work = watchBridges(fixture.options, tokens, kube, `http://127.0.0.1:${address.port}`, stop.signal);
    await delay(800);
    stop.abort();
    await work;
    expect(requests).toBe(0);
    expect(await fixture.nats.store.head()).toBe(head);
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    expect(rows.map(eventType)).toEqual(['conversation.created', 'message.posted']);
  } finally {
    stop.abort();
    await work;
    upstream.close();
    await fixture.close();
  }
}, 120_000);

it.each(['http', 'websocket'])(
  'keeps %s authorised when the other participant posts during a history drain', sendDuringRead, 120_000,
);

async function sendDuringRead(transport: string) {
  const fixture = await directFixture();
  let releaseRead!: () => void;
  let readStarted!: () => void;
  function saveRelease(resolve: () => void) {
    releaseRead = resolve;
  }
  function saveStarted(resolve: () => void) {
    readStarted = resolve;
  }
  const gate = new Promise<void>(saveRelease);
  const started = new Promise<void>(saveStarted);
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await fixture.create();
    const originalDb = fixture.options.db;
    let paused = false;
    async function pauseHistory<Row extends Record<string, unknown>>(
      sql: string, parameters?: unknown[],
    ): Promise<{ rows: Row[] }> {
      const result = await originalDb.query<Row>(sql, parameters);
      if (!paused && sql.startsWith('SELECT * FROM conversation_feed')) {
        paused = true;
        readStarted();
        await gate;
      }
      return result;
    }
    fixture.options.db = { query: pauseHistory };
    let reading: Promise<{ statusCode: number }> | undefined;
    if (transport === 'http') {
      reading = fixture.app.inject({
        url: '/api/conversations/direct/messages', headers: fixture.headers(),
      });
    } else {
      const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
      const realtime = {
        feed: fixture.feed, binding: fixture.options.binding, chat: fixture.options,
      };
      wss = attachWebSocketServer(fixture.app.server, fixture.app.log, fixture.config, realtime);
      const connectionOptions = { headers: fixture.headers() };
      socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
      function receive(raw: Buffer) {
        received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
      }
      socket.on('message', receive);
      await once(socket, 'open');
      const subscription = {
        type: 'subscribe', topic: 'conversation', conversationId: 'direct', since: 0,
      };
      socket.send(JSON.stringify(subscription));
    }
    await started;
    const sent = await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers('bob'),
      payload: { id: 'concurrent', text: 'During the read' },
    });
    expect(sent.statusCode).toBe(200);
    releaseRead();
    if (reading) {
      expect((await reading).statusCode).toBe(200);
    } else {
      await fixture.runner.run(conversations);
      function delivered() {
        return received.some(isConcurrentMessage);
      }
      await until(delivered);
      expect(socket?.readyState).toBe(WebSocket.OPEN);
      expect(received.some(isRefusedMessage)).toBe(false);
    }
  } finally {
    releaseRead();
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await fixture.close();
  }
}

function isConcurrentMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.row?.id === 'concurrent';
}
function isRefusedMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'refused';
}

it('returns list rows checked before access changes during their summaries', async () => {
  const fixture = await directFixture();
  try {
    for (const conversationId of ['two', 'one']) {
      fixture.options.keys.provision('test', conversationId);
      await fixture.append(`conversation-${conversationId}`, 'conversation.created', {
        conversationId, createdBy: 'alice', mode: 'agent_session', assistantId: 'assistant',
      });
      const encrypted = fixture.options.keys.encrypt('test', conversationId, `${conversationId} title`);
      const message = {
        conversationId, authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted,
      };
      await fixture.append(`conversation-${conversationId}`, 'message.posted', message, false);
    }
    await fixture.runner.run(conversations);
    const originalDb = fixture.options.db;
    let removed = false;
    async function removeDuringSummary<Row extends Record<string, unknown>>(
      sql: string, parameters?: unknown[],
    ): Promise<{ rows: Row[] }> {
      if (!removed && sql.includes('SELECT type, data FROM conversation_feed') && parameters?.[1] === 'two') {
        removed = true;
        const removal = { conversationId: 'one', participantId: 'alice', removedBy: 'carol' };
        await fixture.append('conversation-one', 'participant.removed', removal, false);
      }
      return originalDb.query<Row>(sql, parameters);
    }
    fixture.options.db = { query: removeDuringSummary };
    const response = await fixture.app.inject({ url: '/api/conversations', headers: fixture.headers() });
    expect(response.statusCode).toBe(200);
    expect(chatListSchema.parse(response.json()).rows).toHaveLength(2);
    expect(response.body).toContain('one-title');
  } finally {
    await fixture.close();
  }
}, 120_000);

it('refuses new posts after the other participant leaves but keeps history readable', async () => {
  const fixture = await directFixture();
  try {
    await fixture.create();
    await fixture.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'carol',
    }, false);
    const response = await fixture.app.inject({
      method: 'POST', url: '/api/conversations/direct/messages', headers: fixture.headers(),
      payload: { id: 'after-removal', text: 'Must not reach a departed recipient' },
    });
    expect(response.statusCode).toBe(409);
    const read = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers(),
    });
    expect(read.statusCode).toBe(200);
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    expect(rows.map(eventType)).toEqual(['conversation.created']);
  } finally {
    await fixture.close();
  }
}, 120_000);

it('keeps a closed direct chat readable', async () => {
  const fixture = await directFixture();
  try {
    await fixture.create();
    await fixture.append('participation-direct', 'conversation.closed', {
      conversationId: 'direct', closedBy: 'alice',
    }, false);
    await fixture.runner.run(conversations);
    const response = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers('bob'),
    });
    expect(response.statusCode).toBe(200);
    const feed = chatFeedSchema.parse(response.json());
    expect(feed.rows.map(feedEventType)).toEqual(['conversation.created', 'conversation.closed']);
  } finally {
    await fixture.close();
  }
}, 120_000);

function feedEventType(row: ReturnType<typeof chatFeedSchema.parse>['rows'][number]) {
  return row.type;
}

it("refuses an owner who subscribes to another pair's direct chat", async () => {
  const fixture = await directFixture();
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await fixture.create();
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = { feed: fixture.feed, binding: fixture.options.binding, chat: fixture.options };
    wss = attachWebSocketServer(fixture.app.server, fixture.app.log, fixture.config, realtime);
    const connectionOptions = { headers: fixture.headers('carol') };
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const subscription = {
      type: 'subscribe', topic: 'conversation', conversationId: 'direct', since: 0,
    };
    socket.send(JSON.stringify(subscription));
    const closeResult: unknown[] = await closed;
    expect(closeResult[0]).toBe(1008);
    expect(received.map(messageType)).toEqual(['refused']);
  } finally {
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await fixture.close();
  }
}, 120_000);

function messageType(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type;
}

it('omits a departed colleague before OpenFGA applies the removal',
  colleagueRemovedBeforeSearch, 120_000);

async function colleagueRemovedBeforeSearch() {
  const fixture = await directFixture();
  try {
    await fixture.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'carol',
    }, false);
    const request = { url: '/api/chat/colleagues', headers: fixture.headers() };
    const response = await fixture.app.inject(request);
    expect(response.statusCode).toBe(200);
    const colleagues = chatColleaguesSchema.parse(response.json());
    expect(colleagues.rows).toEqual([{ memberId: 'carol', displayName: 'carol' }]);
  } finally {
    await fixture.close();
  }
}

it('offers a colleague whose role change has not reached OpenFGA yet',
  colleagueWithPendingRole, 120_000);

async function colleagueWithPendingRole() {
  const fixture = await directFixture();
  try {
    await fixture.append('member-bob', 'member.role_changed', {
      memberId: 'bob', previousRole: 'member', newRole: 'admin', changedBy: 'carol',
    }, false);
    const response = await fixture.app.inject({
      url: '/api/chat/colleagues', headers: fixture.headers(),
    });
    expect(response.statusCode).toBe(200);
    const colleagues = chatColleaguesSchema.parse(response.json());
    expect(colleagues.rows).toContainEqual({ memberId: 'bob', displayName: 'bob' });
    await fixture.create();
  } finally {
    await fixture.close();
  }
}

it('refuses session creation with an unknown assistant', unknownAssistant, 120_000);

async function unknownAssistant() {
  const fixture = await directFixture();
  try {
    const payload = { id: 'unknown-assistant', conversationId: 'unknown-assistant',
      assistantId: 'missing-assistant' };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers(), payload };
    const response = await fixture.app.inject(request);
    expect(response.statusCode).toBe(403);
  } finally {
    await fixture.close();
  }
}

async function reportsDirectAccessApplying() {
  const fixture = await directFixture();
  try {
    const input = { id: 'create', conversationId: 'direct', mode: 'direct', colleagueId: 'bob' };
    const creation = {
      method: 'POST' as const, url: '/api/conversations', headers: fixture.headers(), payload: input,
    };
    expect((await fixture.app.inject(creation)).statusCode).toBe(200);
    const read = { url: '/api/conversations/direct/messages', headers: fixture.headers() };
    const send = { ...read, method: 'POST' as const, payload: { id: 'first', text: 'Hello' } };
    for (const request of [read, send]) {
      const result = await fixture.app.inject(request);
      expect(result.statusCode).toBe(425);
      expect(result.json()).toEqual({ status: 'access_applying' });
    }
    const outsider = { ...read, headers: fixture.headers('carol') };
    const unknown = { ...read, url: '/api/conversations/unknown/messages' };
    for (const request of [outsider, unknown]) {
      const result = await fixture.app.inject(request);
      expect(result.statusCode).toBe(403);
      expect(result.json()).toEqual({ status: 'refused' });
    }
    const rows = await history(fixture.nats.store, 'conversation-direct', 'test');
    await fixture.auth.handler.handle(rows[0]!.event, fixture.db);
    expect((await fixture.app.inject(read)).statusCode).toBe(200);
    expect((await fixture.app.inject(send)).statusCode).toBe(200);
  } finally {
    await fixture.close();
  }
}

it('reports direct access still applying separately from a real refusal',
  reportsDirectAccessApplying, 120_000);

async function refusesRemovedMemberBeforeCreationPermissions() {
  const fixture = await directFixture();
  try {
    const creation = {
      method: 'POST' as const, url: '/api/conversations', headers: fixture.headers(),
      payload: { id: 'create', conversationId: 'direct', mode: 'direct', colleagueId: 'bob' },
    };
    expect((await fixture.app.inject(creation)).statusCode).toBe(200);
    await fixture.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'carol',
    }, false);
    const read = { url: '/api/conversations/direct/messages', headers: fixture.headers() };
    const result = await fixture.app.inject(read);
    expect(result.statusCode).toBe(403);
    expect(result.json()).toEqual({ status: 'refused' });
  } finally {
    await fixture.close();
  }
}

it('still refuses a removed member while creation permissions are applying',
  refusesRemovedMemberBeforeCreationPermissions, 120_000);


async function seedChatGroup(fixture: Awaited<ReturnType<typeof directFixture>>) {
  await fixture.append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'carol',
  });
  for (const memberId of ['alice', 'bob']) {
    await fixture.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId, addedBy: 'carol',
    });
  }
  await fixture.runner.run(groups);
  const response = await fixture.app.inject({
    url: '/api/chat/groups/sales', headers: fixture.headers('bob'),
  });
  expect(response.statusCode).toBe(200);
  return chatGroupSnapshotSchema.parse(response.json());
}

async function offersOwnGroups() {
  const fixture = await directFixture();
  try {
    const snapshot = await seedChatGroup(fixture);
    const defaults = await fixture.app.inject({
      url: '/api/chat/groups', headers: fixture.headers('bob'),
    });
    expect(defaults.statusCode).toBe(200);
    const foreign = envelope('other', 'team-foreign', 'team.created',
      { teamId: 'foreign', name: 'Private group', createdBy: 'carol' });
    await fixture.nats.seed([foreign]);
    const hidden = await fixture.app.inject({
      url: '/api/chat/groups/foreign', headers: fixture.headers('bob'),
    });
    expect(hidden.statusCode).toBe(403);
    expect(hidden.body).not.toContain('Private group');
    expect(snapshot.members).toEqual([
      { memberId: 'alice', displayName: 'alice' }, { memberId: 'bob', displayName: 'bob' },
    ]);
    const list = await fixture.app.inject({
      url: '/api/chat/groups?q=Sales&limit=50', headers: fixture.headers('bob'),
    });
    expect(list.statusCode).toBe(200);
    expect(chatGroupsSchema.parse(list.json())).toEqual({ rows: [{ groupId: 'sales', name: 'Sales' }], next: null });
    const outsider = await fixture.app.inject({
      url: '/api/chat/groups/sales', headers: fixture.headers('carol'),
    });
    expect(outsider.statusCode).toBe(403);
    expect(outsider.body).not.toContain('alice');
    const input = { id: 'group-create', conversationId: 'group', mode: 'group',
      participantIds: ['alice', 'bob'], groupId: 'sales', groupSnapshotPosition: snapshot.position };
    const invalidBodies = [
      { ...input, participantIds: ['bob', 'bob'] },
      { ...input, participantIds: ['alice', 'carol'] },
      { ...input, groupSnapshotPosition: undefined },
      { ...input, assistantId: 'assistant' },
      { ...input, participantIds: Array.from({ length: 98 }, participantIdAt) },
    ];
    for (const payload of invalidBodies) {
      const invalid = { method: 'POST' as const, url: '/api/conversations',
        headers: fixture.headers('bob'), payload };
      expect((await fixture.app.inject(invalid)).statusCode).toBe(400);
    }
    const creation = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('carol'), payload: { ...input, participantIds: ['bob', 'carol'] } };
    expect((await fixture.app.inject(creation)).statusCode).toBe(403);
    await fixture.append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'alice', removedBy: 'carol',
    }, false);
    const stale = { ...creation, headers: fixture.headers('bob'), payload: input };
    expect((await fixture.app.inject(stale)).statusCode).toBe(409);
    expect(await fixture.nats.store.head('conversation-group')).toBe(0);
    const removed = await fixture.app.inject({
      url: '/api/chat/groups/sales', headers: fixture.headers(),
    });
    expect(removed.statusCode).toBe(403);
    const invalid = await fixture.app.inject({
      url: '/api/chat/groups?limit=51', headers: fixture.headers('bob'),
    });
    expect(invalid.statusCode).toBe(400);
  } finally {
    await fixture.close();
  }
}
it('offers only own groups and denies stale or foreign reviewed snapshots',
  offersOwnGroups, 120_000);

async function recoversGroupCreation() {
  const fixture = await directFixture();
  try {
    const snapshot = await seedChatGroup(fixture);
    const input = { id: 'group-create', conversationId: 'group', mode: 'group',
      participantIds: ['alice', 'bob'], groupId: 'sales', groupSnapshotPosition: snapshot.position };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('bob'), payload: input };
    const append = fixture.options.store.append.bind(fixture.options.store);
    async function loseReply(command: Parameters<typeof append>[0]): Promise<never> {
      await append(command);
      throw new Error('Lost reply');
    }
    fixture.options.store.append = loseReply;
    expect((await fixture.app.inject(request)).statusCode).toBe(503);
    fixture.options.store.append = append;
    const rows = await history(fixture.nats.store, 'conversation-group', 'test');
    expect(rows).toHaveLength(1);
    await fixture.auth.handler.handle(rows[0]!.event, fixture.db);
    await fixture.append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'bob', removedBy: 'carol',
    });
    await fixture.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: 'carol', addedBy: 'carol',
    });
    const retry = { ...request, payload: { ...input, participantIds: ['bob', 'alice'] } };
    const response = await fixture.app.inject(retry);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'appended', sequence: rows[0]!.sequence });
    const changed = { ...request, payload: { ...input, participantIds: ['bob', 'carol'] } };
    expect((await fixture.app.inject(changed)).statusCode).toBe(409);
    const send = { method: 'POST' as const, url: '/api/conversations/group/messages',
      headers: fixture.headers('bob'), payload: { id: 'human-group', text: 'Hello @agent' } };
    expect((await fixture.app.inject(send)).statusCode).toBe(200);
    const stop = { ...send, payload: { id: 'stop-group', stopTurnId: 'human-group' } };
    expect((await fixture.app.inject(stop)).statusCode).toBe(409);
    const execution = { ...send,
      payload: { id: 'execution-group', text: 'Hello', executionMode: 'memory_free' } };
    expect((await fixture.app.inject(execution)).statusCode).toBe(409);
    await fixture.runner.run(conversations);
    const feed = await fixture.app.inject({
      url: '/api/conversations/group/messages', headers: fixture.headers('bob'),
    });
    expect(feed.statusCode).toBe(200);
    expect(chatFeedSchema.parse(feed.json()).computerState).toBe('not_applicable');
    const list = await fixture.app.inject({
      url: '/api/conversations', headers: fixture.headers('bob'),
    });
    expect(chatListSchema.parse(list.json()).rows).toMatchObject([
      { mode: 'group', participantIds: ['alice', 'bob'], createdBy: 'bob' },
    ]);
    const outsider = await fixture.app.inject({
      url: '/api/conversations/group/messages', headers: fixture.headers('carol'),
    });
    expect(outsider.statusCode).toBe(403);
    const saved = await history(fixture.nats.store, 'conversation-group', 'test');
    expect(saved.map(eventType)).toEqual(['conversation.created', 'message.posted']);
  } finally {
    await fixture.close();
  }
}
it('keeps a lost creation reply tied to the reviewed audience for a member without an assistant',
  recoversGroupCreation, 120_000);

function participantIdAt(_value: unknown, index: number) {
  return `person-${index}`;
}

async function refusesForeignAndUnknownGroupMembers() {
  const fixture = await directFixture();
  try {
    const foreignMember = envelope('other', 'member-foreign', 'member.joined', {
      memberId: 'foreign', invitationId: 'invite-foreign', email: 'foreign@example.test',
      displayName: 'Foreign member', role: 'member',
    });
    await fixture.nats.seed([foreignMember]);
    await fixture.append('member-carol', 'member.removed', {
      memberId: 'carol', removedBy: 'alice',
    }, false);
    for (const memberId of ['missing', 'foreign', 'carol']) {
      const conversationId = `refused-${memberId}`;
      const payload = { id: conversationId, conversationId, mode: 'group',
        participantIds: ['alice', memberId] };
      const request = { method: 'POST' as const, url: '/api/conversations',
        headers: fixture.headers(), payload };
      const response = await fixture.app.inject(request);
      const saved = await history(fixture.nats.store, `conversation-${conversationId}`, 'test');
      expect(saved).toEqual([]);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ status: 'refused' });
    }
  } finally {
    await fixture.close();
  }
}
it('gives foreign, unknown and removed group members the same generic refusal',
  refusesForeignAndUnknownGroupMembers, 120_000);

async function refusesDepartedGroupParticipant() {
  const fixture = await directFixture();
  try {
    // Leave IAM unchanged to prove that saved removal events decide membership.
    await fixture.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'carol',
    }, false);
    const payload = { id: 'departed', conversationId: 'departed', mode: 'group',
      participantIds: ['alice', 'bob'] };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers(), payload };
    const response = await fixture.app.inject(request);
    const saved = await history(fixture.nats.store, 'conversation-departed', 'test');
    expect(saved).toEqual([]);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    await fixture.close();
  }
}
it('refuses a departed selected member when group creation has no group association',
  refusesDepartedGroupParticipant, 120_000);

async function refusesChangedSnapshotPosition() {
  const fixture = await directFixture();
  try {
    const snapshot = await seedChatGroup(fixture);
    await fixture.append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'alice', removedBy: 'carol',
    });
    await fixture.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: 'alice', addedBy: 'carol',
    });
    const current = await readCurrentSnapshot();
    expect(current.members).toEqual(snapshot.members);
    expect(current.position).toBeGreaterThan(snapshot.position);
    const payload = { id: 'position-only', conversationId: 'position-only', mode: 'group',
      participantIds: ['alice', 'bob'], groupId: 'sales',
      groupSnapshotPosition: snapshot.position };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('bob'), payload };
    const response = await fixture.app.inject(request);
    const saved = await history(fixture.nats.store, 'conversation-position-only', 'test');
    expect(saved).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    await fixture.close();
  }

  async function readCurrentSnapshot() {
    const request = { url: '/api/chat/groups/sales', headers: fixture.headers('bob') };
    const response = await fixture.app.inject(request);
    expect(response.statusCode).toBe(200);
    return chatGroupSnapshotSchema.parse(response.json());
  }
}
it('refuses a changed snapshot position even when the reviewed audience is unchanged',
  refusesChangedSnapshotPosition, 120_000);

async function refusesChangedSnapshotAudience() {
  const fixture = await directFixture();
  try {
    const snapshot = await seedChatGroup(fixture);
    const payload = { id: 'audience-only', conversationId: 'audience-only', mode: 'group',
      participantIds: ['bob', 'carol'], groupId: 'sales',
      groupSnapshotPosition: snapshot.position };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('bob'), payload };
    const response = await fixture.app.inject(request);
    const saved = await history(fixture.nats.store, 'conversation-audience-only', 'test');
    expect(saved).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    await fixture.close();
  }
}
it('refuses a changed reviewed audience even when the snapshot position matches',
  refusesChangedSnapshotAudience, 120_000);

async function refusesGroupChangeBeforeWriteCheck() {
  const fixture = await directFixture();
  const originalHead = fixture.options.store.head.bind(fixture.options.store);
  let changed = false;
  async function changeBeforeWriteCheck(subject?: string, deadline?: number) {
    if (subject === undefined && !changed) {
      changed = true;
      // Change the group after its snapshot read but before the write check starts.
      await fixture.append('team-sales', 'team.member_removed', {
        teamId: 'sales', memberId: 'alice', removedBy: 'carol',
      }, false);
    }
    return originalHead(subject, deadline);
  }
  try {
    const snapshot = await seedChatGroup(fixture);
    fixture.options.store.head = changeBeforeWriteCheck;
    const payload = { id: 'snapshot-race', conversationId: 'snapshot-race', mode: 'group',
      participantIds: ['alice', 'bob'], groupId: 'sales',
      groupSnapshotPosition: snapshot.position };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('bob'), payload };
    const response = await fixture.app.inject(request);
    expect(changed).toBe(true);
    const saved = await history(fixture.nats.store, 'conversation-snapshot-race', 'test');
    expect(saved).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    fixture.options.store.head = originalHead;
    await fixture.close();
  }
}
it('refuses a group change between the creation snapshot read and the write check',
  refusesGroupChangeBeforeWriteCheck, 120_000);

async function refusesGroupChangeDuringWriteCheck() {
  const fixture = await directFixture();
  const originalHead = fixture.options.store.head.bind(fixture.options.store);
  let changed = false;
  async function changeAfterPositionRead(subject?: string, deadline?: number) {
    const position = await originalHead(subject, deadline);
    if (subject === 'team-sales' && !changed) {
      changed = true;
      // Return the old position so the last access check must catch the change.
      await fixture.append('team-sales', 'team.member_removed', {
        teamId: 'sales', memberId: 'alice', removedBy: 'carol',
      }, false);
    }
    return position;
  }
  try {
    const snapshot = await seedChatGroup(fixture);
    fixture.options.store.head = changeAfterPositionRead;
    const payload = { id: 'write-race', conversationId: 'write-race', mode: 'group',
      participantIds: ['alice', 'bob'], groupId: 'sales',
      groupSnapshotPosition: snapshot.position };
    const request = { method: 'POST' as const, url: '/api/conversations',
      headers: fixture.headers('bob'), payload };
    const response = await fixture.app.inject(request);
    expect(changed).toBe(true);
    const saved = await history(fixture.nats.store, 'conversation-write-race', 'test');
    expect(saved).toEqual([]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ status: 'refused' });
  } finally {
    fixture.options.store.head = originalHead;
    await fixture.close();
  }
}
it('refuses a group change after its position was read during the write check',
  refusesGroupChangeDuringWriteCheck, 120_000);

type ListFixture = Awaited<ReturnType<typeof directFixture>>;
async function seedListChat(fixture: ListFixture, conversationId: string, iam = true,
  participantIds = ['alice', 'bob']) {
  fixture.options.keys.provision('test', conversationId);
  const data = { conversationId, mode: 'group', createdBy: 'alice', participantIds };
  return fixture.append(`conversation-${conversationId}`, 'conversation.created', data, iam);
}
async function seedListMessage(fixture: ListFixture, conversationId: string, text: string) {
  const encrypted = fixture.options.keys.encrypt('test', conversationId, text);
  const data = { conversationId, authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...encrypted };
  await fixture.append(`conversation-${conversationId}`, 'message.posted', data, false);
}
async function listPage(fixture: ListFixture, query = '', memberId = 'bob') {
  const response = await fixture.app.inject({
    url: `/api/conversations${query}`, headers: fixture.headers(memberId),
  });
  expect(response.statusCode).toBe(200);
  const parsed = chatListSchema.parse(response.json());
  const continuation = response.json<{ nextCursor: string | null }>();
  return { rows: parsed.rows, nextCursor: continuation.nextCursor };
}
async function seedListPreference(fixture: ListFixture, conversationId: string,
  joinEventId: string, fields: object = { archived: true }) {
  const data = { conversationId, memberId: 'bob', joinEventId, ...fields };
  let type = 'conversation.archive_set';
  if (!('archived' in fields)) type = 'conversation.read_advanced';
  const base = envelope('test', `conversation-${conversationId}`, 'conversation.closed',
    { conversationId, closedBy: 'bob' });
  const event = { ...base, subject: 'chat-state-bob', type, data,
    principal: { kind: 'human' as const, id: 'bob' } };
  await fixture.nats.seed([event]);
  await fixture.runner.run(conversations);
}

async function ordersVisibleListActivity() {
  const fixture = await directFixture();
  try {
    await seedListChat(fixture, 'older');
    await seedListMessage(fixture, 'older', 'Older visible title');
    await seedListChat(fixture, 'newer');
    await seedListMessage(fixture, 'older', 'Recent message');
    await fixture.runner.run(conversations);
    const page = await listPage(fixture, '?limit=1');
    expect(page.rows.map(conversationIdOf)).toEqual(['older']);
    expect(page.nextCursor).toBeTruthy();
    const next = await listPage(fixture, `?limit=1&cursor=${page.nextCursor}`);
    expect(next.rows.map(conversationIdOf)).toEqual(['newer']);
    await fixture.append('conversation-personal', 'conversation.created', {
      conversationId: 'personal', mode: 'agent_session', createdBy: 'alice',
      assistantId: 'assistant',
    });
    await fixture.runner.run(conversations);
    const personal = await listPage(fixture, '', 'alice');
    expect(personal.rows[0]).toMatchObject({ conversationId: 'personal', mode: 'agent_session' });
  } finally {
    await fixture.close();
  }
}
it('pages by visible activity and keeps personal sessions in the list', ordersVisibleListActivity);

function conversationIdOf(row: { conversationId: string }) {
  return row.conversationId;
}
async function protectsListMetadata() {
  const fixture = await directFixture();
  try {
    const archived = await seedListChat(fixture, 'archived');
    await seedListMessage(fixture, 'archived', 'Archived title');
    await seedListChat(fixture, 'late', true, ['alice', 'carol']);
    await seedListMessage(fixture, 'late', 'Secret before joining');
    await seedListChat(fixture, 'visible');
    await seedListMessage(fixture, 'visible', 'Visible title');
    await fixture.append('participation-late', 'participant.added', {
      conversationId: 'late', participantId: 'bob', addedBy: 'alice',
    });
    await seedListChat(fixture, 'denied', false);
    await seedListMessage(fixture, 'denied', 'Denied title');
    await fixture.runner.run(conversations);
    await seedListPreference(fixture, 'archived', archived.id);
    const recent = await listPage(fixture);
    expect(recent.rows.map(conversationIdOf)).toEqual(['visible', 'late']);
    expect(JSON.stringify(recent)).not.toMatch(/Secret|Denied|Archived/u);
    expect(await listPage(fixture, '?q=secret')).toMatchObject({ rows: [], nextCursor: null });
    const saved = await listPage(fixture, '?section=archived&q=ARCHIVED');
    expect(saved.rows.map(conversationIdOf)).toEqual(['archived']);
    expect((await listPage(fixture, '?q=visible')).rows.map(conversationIdOf)).toEqual(['visible']);
    await fixture.append('participation-archived', 'participant.removed', {
      conversationId: 'archived', participantId: 'bob', removedBy: 'alice',
    });
    await fixture.append('participation-archived', 'participant.added', {
      conversationId: 'archived', participantId: 'bob', addedBy: 'alice',
    });
    await fixture.runner.run(conversations);
    expect((await listPage(fixture, '?section=archived')).rows).toEqual([]);
    const rejoined = await listPage(fixture, '?q=Archived');
    expect(rejoined.rows).toEqual([]);
  } finally {
    await fixture.close();
  }
}
it('searches only authorised visible titles and separates archived choices', protectsListMetadata);

async function boundsDeniedListScan() {
  const fixture = await directFixture();
  try {
    await seedListChat(fixture, 'allowed');
    for (let index = 0; index < 101; index++) {
      await seedListChat(fixture, `denied-${index}`, false);
    }
    await fixture.runner.run(conversations);
    const reads = vi.spyOn(fixture.options.store, 'readStream');
    const response = await fixture.app.inject({
      url: '/api/conversations', headers: fixture.headers('bob'),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'list_incomplete' });
    expect(reads.mock.calls.length).toBeLessThanOrEqual(202);
    reads.mockRestore();
  } finally {
    await fixture.close();
  }
}
it('bounds denied candidates without returning their positions or an empty continuation', boundsDeniedListScan, 120_000);

async function resetsChangedListPages() {
  const fixture = await directFixture();
  try {
    const firstJoin = await seedListChat(fixture, 'first');
    await seedListChat(fixture, 'second');
    await seedListChat(fixture, 'third');
    await fixture.runner.run(conversations);
    async function cursor() {
      return (await listPage(fixture, '?limit=1')).nextCursor;
    }
    async function refused(saved: string | null, suffix = '', memberId = 'bob') {
      const response = await fixture.app.inject({
        url: `/api/conversations?limit=1&cursor=${saved}${suffix}`,
        headers: fixture.headers(memberId),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ status: 'list_changed' });
    }
    const original = await cursor();
    await refused(original, '&q=changed');
    await refused(original, '&section=archived');
    await refused(original, '', 'alice');
    await refused(`${original}x`);
    const throughPosition = await fixture.nats.store.head('conversation-first');
    await seedListPreference(fixture, 'first', firstJoin.id, {
      throughPosition, throughEventId: firstJoin.id,
    });
    const afterRead = await listPage(fixture, `?limit=1&cursor=${original}`);
    expect(afterRead.rows.map(conversationIdOf)).toEqual(['second']);
    await seedListMessage(fixture, 'first', 'Ordering changed');
    await fixture.runner.run(conversations);
    await refused(original);
    const beforeArchive = await cursor();
    await seedListPreference(fixture, 'first', firstJoin.id);
    await refused(beforeArchive);
    const beforeParticipation = await cursor();
    await fixture.append('participation-second', 'participant.added', {
      conversationId: 'second', participantId: 'carol', addedBy: 'alice',
    });
    await fixture.runner.run(conversations);
    await refused(beforeParticipation);
    const beforeRebuild = await cursor();
    await fixture.runner.rebuild(conversations);
    await refused(beforeRebuild);
  } finally {
    await fixture.close();
  }
}
it('resets pages after changes or rebuild and binds cursors to the caller and filters',
  resetsChangedListPages);

async function capsListPages() {
  const fixture = await directFixture();
  try {
    for (let index = 0; index < 51; index++) {
      await seedListChat(fixture, `chat-${index}`);
    }
    await fixture.runner.run(conversations);
    expect((await listPage(fixture)).rows).toHaveLength(20);
    const maximum = await listPage(fixture, '?limit=50');
    expect(maximum.rows).toHaveLength(50);
    const last = await listPage(fixture, `?limit=50&cursor=${maximum.nextCursor}`);
    expect(last.rows.map(conversationIdOf)).toEqual(['chat-0']);
    expect(last.nextCursor).toBeNull();
    const invalidQueries = ['limit=0', 'limit=51', 'section=other', 'extra=1', `q=${'a'.repeat(101)}`];
    for (const query of invalidQueries) {
      const response = await fixture.app.inject({
        url: `/api/conversations?${query}`, headers: fixture.headers('bob'),
      });
      expect(response.statusCode).toBe(400);
    }
  } finally {
    await fixture.close();
  }
}
it('caps default and maximum pages and refuses invalid list queries', capsListPages, 120_000);

async function keepsPrivateActivityOutOfListRevision() {
  const fixture = await directFixture();
  try {
    await seedListChat(fixture, 'first');
    await seedListChat(fixture, 'second');
    await seedListChat(fixture, 'denied', false);
    await fixture.runner.run(conversations);
    const original = await listPage(fixture, '?limit=1');
    const queries = vi.spyOn(fixture.options.db, 'query');
    await seedListChat(fixture, 'private', true, ['alice', 'carol']);
    await seedListMessage(fixture, 'private', 'Private activity');
    await seedListMessage(fixture, 'denied', 'Denied activity');
    await fixture.runner.run(conversations);
    const after = await listPage(fixture, '?limit=1');
    expect(after).toEqual(original);
    const next = await listPage(fixture, `?limit=1&cursor=${original.nextCursor}`);
    expect(next.rows.map(conversationIdOf)).toEqual(['first']);
    for (const [sql] of queries.mock.calls) {
      expect(sql).not.toMatch(/SELECT max\((latest_activity|join_position|end_position)/u);
    }
    queries.mockRestore();
  } finally {
    await fixture.close();
  }
}
it('keeps private and IAM-denied activity out of cursors without silo-wide revision scans',
  keepsPrivateActivityOutOfListRevision);

async function putsOnlyVisiblePositionsInCursor() {
  const fixture = await directFixture();
  try {
    await seedListChat(fixture, 'denied-old', false);
    await seedListChat(fixture, 'first');
    await seedListChat(fixture, 'second');
    await seedListChat(fixture, 'denied', false);
    await fixture.runner.run(conversations);
    const page = await listPage(fixture, '?limit=1');
    expect(page.rows.map(conversationIdOf)).toEqual(['second']);
    expect(page.nextCursor).toBeTruthy();
    const encoded = page.nextCursor!.split('.')[0]!;
    const payload: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const visible = await fixture.options.db.query<{ latest_activity: string;
      join_position: string }>(`SELECT latest_activity, join_position
      FROM conversation_participants WHERE conversation_id='second' AND participant_id='bob'`);
    const row = visible.rows[0]!;
    expect(payload).toEqual([expect.any(String), Number(row.latest_activity),
      Number(row.join_position)]);
    const last = await listPage(fixture, `?limit=1&cursor=${page.nextCursor}`);
    expect(last.rows.map(conversationIdOf)).toEqual(['first']);
    expect(last.nextCursor).toBeNull();
  } finally {
    await fixture.close();
  }
}
it('uses only visible rows for continuation positions and page existence',
  putsOnlyVisiblePositionsInCursor);

async function hidesPreJoinCreationTime() {
  const fixture = await directFixture();
  try {
    const createdAt = new Date('2026-10-05T10:00:00.000Z');
    const joinedAt = new Date('2026-10-09T10:00:00.000Z');
    const created = envelope('test', 'conversation-late-time', 'conversation.created', {
      conversationId: 'late-time', mode: 'group', createdBy: 'alice',
      participantIds: ['alice', 'carol'], groupId: 'original-team',
      groupSnapshotPosition: 1,
    }, 'created-late-time', createdAt);
    const joined = envelope('test', 'participation-late-time', 'participant.added', {
      conversationId: 'late-time', participantId: 'bob', addedBy: 'alice',
    }, 'joined-late-time', joinedAt);
    await fixture.nats.seed([created, joined]);
    await fixture.auth.handler.handle(created, fixture.options.db);
    await fixture.auth.handler.handle(joined, fixture.options.db);
    await fixture.runner.run(conversations);
    const page = await listPage(fixture);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ conversationId: 'late-time',
      createdAt: joinedAt.toISOString() });
    expect(JSON.stringify(page)).not.toContain(createdAt.toISOString());
    expect(page.rows[0]).not.toHaveProperty('createdBy');
    expect(page.rows[0]).not.toHaveProperty('groupId');
    expect(page.rows[0]).not.toHaveProperty('groupSnapshotPosition');
    const original = await listPage(fixture, '', 'alice');
    expect(original.rows[0]).toMatchObject({ createdBy: 'alice',
      createdAt: createdAt.toISOString(), groupId: 'original-team', groupSnapshotPosition: 1 });
  } finally {
    await fixture.close();
  }
}
it('shows the join time to ordinary late joiners instead of the original creation time',
  hidesPreJoinCreationTime);

async function hidesPersonalSessionHistoryBeforeJoin() {
  const fixture = await directFixture();
  try {
    const createdAt = new Date('2026-10-05T10:00:00.000Z');
    const messageAt = new Date('2026-10-06T10:00:00.000Z');
    const joinedAt = new Date('2026-10-09T10:00:00.000Z');
    const conversationId = 'personal-late-time';
    fixture.options.keys.provision('test', conversationId);
    const created = envelope('test', `conversation-${conversationId}`, 'conversation.created', {
      conversationId, mode: 'agent_session', createdBy: 'alice', assistantId: 'assistant',
    }, 'created-personal-late-time', createdAt);
    const encrypted = fixture.options.keys.encrypt('test', conversationId, 'Secret before joining');
    const message = envelope('test', `conversation-${conversationId}`, 'message.posted', {
      conversationId, authorId: 'alice', authorKind: 'human', contentType: 'text', ...encrypted,
    }, 'message-personal-late-time', messageAt);
    const joined = envelope('test', `participation-${conversationId}`, 'participant.added', {
      conversationId, participantId: 'bob', addedBy: 'alice',
    }, 'joined-personal-late-time', joinedAt);
    await fixture.nats.seed([created, message, joined]);
    await fixture.auth.handler.handle(created, fixture.options.db);
    await fixture.auth.handler.handle(joined, fixture.options.db);
    await fixture.runner.run(conversations);

    const request = { url: '/api/conversations', headers: fixture.headers('bob') };
    const response = await fixture.app.inject(request);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [{
      conversationId, mode: 'agent_session', createdBy: 'alice', assistantId: 'assistant',
      assistantKind: 'personal',
      createdAt: joinedAt.toISOString(), title: 'New session', status: 'open',
      joinEventId: joined.id, archived: false, archivePosition: 0, throughPosition: 0,
    }], nextCursor: null });
    expect(response.body).not.toContain(createdAt.toISOString());
    expect(response.body).not.toContain(messageAt.toISOString());
    expect(response.body).not.toMatch(/secret|count|snippet/iu);
    expect(await listPage(fixture, '?q=secret')).toEqual({ rows: [], nextCursor: null });

    await seedListMessage(fixture, conversationId, 'Visible after joining');
    await fixture.runner.run(conversations);
    const later = await listPage(fixture);
    expect(later.rows[0]).toMatchObject({ createdAt: joinedAt.toISOString(),
      title: 'visible-after-joining' });
    expect(JSON.stringify(later)).not.toContain(createdAt.toISOString());
    const original = await listPage(fixture, '', 'alice');
    expect(original.rows[0]).toMatchObject({ createdAt: createdAt.toISOString(),
      title: 'secret-before-joining' });
  } finally {
    await fixture.close();
  }
}
it('hides pre-join timestamps, counts and snippets from ordinary personal-session participants',
  hidesPersonalSessionHistoryBeforeJoin);
