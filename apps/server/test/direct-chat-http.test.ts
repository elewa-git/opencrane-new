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
import { expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, rebuildMembers, deleteStoreById } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import {
  members, computers, conversations, pgDb, ProjectionRunner, connectMemberFeed,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope, history } from '@opencrane/models';
import { chatListSchema, chatFeedSchema, chatColleaguesSchema, chatChangeSchema } from '@opencrane/protocol';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand } from '../src/chat/commands.ts';
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
    const rows = await history(nats.store, subject, 'test');
    const expectedSequence = rows.at(-1)?.sequence ?? 0;
    expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
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
  for (const projection of [members, conversations, computers]) {
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
  async function create() {
    const input = { id: 'create', conversationId: 'direct', mode: 'direct', colleagueId: 'bob' };
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
    expect(received.at(-1)?.type).toBe('refused');
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
    const send = await fixture.app.inject({
      url: '/api/conversations/direct/changes/sent', headers: fixture.headers('bob'),
    });
    expect(send.statusCode).toBe(200);
    expect(chatChangeSchema.parse(send.json())).toMatchObject({
      status: 'appended', commandId: 'sent', type: 'message.posted',
      projection: { content: 'applying', iam: 'current' },
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
    await fixture.append('conversation-direct', 'conversation.closed', closedData, false);
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
    const author = { silo: 'test', memberId: 'alice' };
    // Seed the paging fixture through the command seam; HTTP send admission has separate coverage.
    for (let index = 0; index < 101; index++) {
      const input = { id: `page-${index}`, conversationId: 'direct', text: `Message ${index}` };
      const result = await chatCommand(fixture.nats.store, fixture.options.keys, author, input);
      expect(result.status).toBe('appended');
    }
    await fixture.runner.run(conversations);
    const first = await fixture.app.inject({
      url: '/api/conversations/direct/messages', headers: fixture.headers('bob'),
    });
    const page = chatFeedSchema.parse(first.json());
    expect(page.rows).toHaveLength(100);
    const cursor = page.rows.at(-1)!.position;
    const second = await fixture.app.inject({
      url: `/api/conversations/direct/messages?since=${cursor}`, headers: fixture.headers('bob'),
    });
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

function rowId(row: ReturnType<typeof chatFeedSchema.parse>['rows'][number]) {

  return row.id;

}

it('keeps human messages out of the bridge, computer, approval and budget paths', async () => {
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
    await fixture.create();
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

it('refuses a list when access to an earlier row ends while a later summary is loading', async () => {
  const fixture = await directFixture();
  try {
    for (const conversationId of ['two', 'one']) {
      fixture.options.keys.provision('test', conversationId);
      await fixture.append(`conversation-${conversationId}`, 'conversation.created', {
        conversationId, createdBy: 'alice', mode: 'agent_session', assistantId: 'assistant',
      });
      const encrypted = fixture.options.keys.encrypt('test', conversationId, 'Protected title');
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
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('protected-title');
  } finally {
    await fixture.close();
  }
}, 120_000);
