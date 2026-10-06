// Regression probes for turn activity during reads and long agent sessions.
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { wireSubject } from '@opencrane/event-store';
import {
  members, computers, conversations, pgDb, ProjectionRunner, connectMemberFeed,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope, history } from '@opencrane/models';
import { chatMessageSchema } from '@opencrane/protocol';
import type { ChatOptions } from '../src/chat/routes.ts';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand } from '../src/chat/commands.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

async function countedOpenFga(apiUrl: string) {
  let checks = 0;
  const proxy = createServer(forward);
  function forward(incoming: IncomingMessage, outgoing: ServerResponse) {
    if (incoming.url?.endsWith('/check')) checks++;
    const target = new URL(incoming.url ?? '/', apiUrl);
    const options = { method: incoming.method, headers: incoming.headers };
    const forwarded = request(target, options, respond);
    function respond(response: IncomingMessage) {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    }
    function fail() {
      outgoing.writeHead(502);
      outgoing.end();
    }
    forwarded.on('error', fail);
    incoming.pipe(forwarded);
  }
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  function checkCount() {
    return checks;
  }
  async function close() {
    function stop(resolve: () => void) {
      proxy.close(resolve);
      proxy.closeAllConnections();
    }
    await new Promise<void>(stop);
  }
  return { apiUrl: `http://127.0.0.1:${address.port}`, checkCount, close };
}

async function fixture(countChecks = false) {
  const nats = await natsFixture();
  const dbs = await databases();
  const fga = await openfga();
  let fgaProxy: Awaited<ReturnType<typeof countedOpenFga>> | undefined;
  if (countChecks) fgaProxy = await countedOpenFga(fga.apiUrl);
  const directory = await mkdtemp(`${tmpdir()}/review-p4-4-`);
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
  const binding = await createStore(fgaProxy?.apiUrl ?? fga.apiUrl, 'test');
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(binding);
  const keys = conversationKeys(directory);
  const runner = new ProjectionRunner(db, nats.store, createLogger('review'));
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const options: ChatOptions = { silo: 'test', store: nats.store, db, keys, binding, feed };
  const app = buildServer(config, { chat: options });
  async function append(subject: string, type: string, data: unknown, iam = true) {
    const event = envelope('test', subject, type, data);
    let actorId = 'alice';
    if (type === 'member.joined') actorId = subject.slice('member-'.length);
    event.principal = { id: actorId, kind: 'human' };
    const rows = await history(nats.store, subject, 'test');
    const expectedSequence = rows.at(-1)?.sequence ?? 0;
    expect((await nats.store.append({ event, expectedSequence })).status).toBe('appended');
    if (iam) await auth.handler.handle(event, db);
    return event;
  }
  for (const memberId of ['alice', 'bob']) {
    await append(`member-${memberId}`, 'member.invited', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: memberId },
    }, false);
    await append(`member-${memberId}`, 'member.joined', {
      memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
      displayName: memberId, role: 'member',
    });
  }
  await append('assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal',
  });
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
  async function agentSession(conversationId: string) {
    keys.provision('test', conversationId);
    await append(`conversation-${conversationId}`, 'conversation.created', {
      conversationId, createdBy: 'alice', mode: 'agent_session', assistantId: 'assistant',
    });
    const author = { silo: 'test', memberId: 'alice' };
    await chatCommand(nats.store, keys, author, { id: `${conversationId}-turn`, conversationId, text: 'Hello' });
    await runner.run(conversations);
  }
  async function close() {
    await app.close();
    await feed.close();
    await nats.close();
    await dbs.close();
    await fgaProxy?.close();
    await fga.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { app, nats, db, keys, runner, headers, append, agentSession, close,
    config, options, feed, fgaProxy, auth };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function openChatSocket(context: Fixture, conversationId: string) {
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed: context.feed, binding: context.options.binding,
    chat: context.options };
  const wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
  const connectionOptions = { headers: context.headers() };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
  function receive(raw: Buffer) {
    received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
  }
  socket.on('message', receive);
  await once(socket, 'open');
  const subscription = { type: 'subscribe', topic: 'conversation', conversationId, since: 0 };
  socket.send(JSON.stringify(subscription));
  function ready() {
    return received.some(isReady);
  }
  await until(ready);
  async function close() {
    socket.terminate();
    function closeServer(resolve: () => void) {
      wss.close(resolve);
    }
    await new Promise<void>(closeServer);
  }
  return { socket, received, close };
}

it('rechecks a direct-chat participant removal until OpenFGA has applied it',
  participantRemovalWithDelayedPermissions, 120_000);

async function participantRemovalWithDelayedPermissions() {
  const context = await fixture(true);
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    context.keys.provision('test', 'direct');
    await context.append('conversation-direct', 'conversation.created', {
      conversationId: 'direct', createdBy: 'alice', mode: 'direct',
      participantIds: ['alice', 'bob'],
    });
    await context.runner.run(conversations);
    client = await openChatSocket(context, 'direct');
    const initialChecks = context.fgaProxy!.checkCount();
    await delay(2000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks);
    const encrypted = context.keys.encrypt('test', 'direct', 'Hello from Bob');
    await context.append('conversation-direct', 'message.posted', {
      conversationId: 'direct', authorId: 'bob', authorKind: 'human',
      contentType: 'text', ...encrypted,
    }, false);
    await context.runner.run(conversations);
    function messageDelivered() {
      function isMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
        return message.type === 'event' && message.row?.type === 'message.posted';
      }
      return client!.received.some(isMessage);
    }
    await until(messageDelivered);
    await context.append('member-bob', 'member.removed', {
      memberId: 'bob', removedBy: 'alice',
    }, false);
    await delay(300);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks);
    const removed = await context.append('conversation-direct', 'participant.removed', {
      conversationId: 'direct', participantId: 'alice', removedBy: 'bob',
    }, false);
    await delay(300);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    const closed = once(client.socket, 'close');
    await context.auth.handler.handle(removed, context.db);
    function expired(): never {
      throw new Error('Participant removal did not close the socket');
    }
    const timeout = delay(2000).then(expired);
    const closure: unknown[] = await Promise.race([closed, timeout]);
    expect(closure[0]).toBe(1008);
    expect(client.received.some(isRefused)).toBe(true);
  } finally {
    await client?.close();
    await context.close();
  }
}

it('keeps a team chat idle without OpenFGA calls and closes it when team access is removed',
  teamSocketAccessChanges, 120_000);

async function teamSocketAccessChanges() {
  const context = await fixture(true);
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    await context.append('team-sales', 'team.created', {
      teamId: 'sales', name: 'Sales', createdBy: 'alice',
    });
    await context.append('team-sales', 'team.member_added', {
      teamId: 'sales', memberId: 'alice', addedBy: 'alice',
    });
    await context.append('assistant-shared', 'assistant.created', {
      assistantId: 'shared', kind: 'team', ownerId: 'sales', payingGroupId: 'sales',
    });
    context.keys.provision('test', 'team-chat');
    await context.append('conversation-team-chat', 'conversation.created', {
      conversationId: 'team-chat', createdBy: 'alice', mode: 'agent_session',
      assistantId: 'shared', payingGroupId: 'sales',
    });
    await context.runner.run(conversations);
    client = await openChatSocket(context, 'team-chat');
    const initialChecks = context.fgaProxy!.checkCount();
    await delay(2000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks);
    const closed = once(client.socket, 'close');
    const started = performance.now();
    await context.append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'alice', removedBy: 'bob',
    }, false);
    function expired(): never {
      throw new Error('Team removal did not close the socket within two seconds');
    }
    const timeout = delay(2000).then(expired);
    const closure: unknown[] = await Promise.race([closed, timeout]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
    expect(client.received.some(isRefused)).toBe(true);
  } finally {
    await client?.close();
    await context.close();
  }
}

it('keeps an idle chat socket cheap and rechecks access when membership changes',
  idleSocketChecks, 120_000);

async function idleSocketChecks() {
  const context = await fixture(true);
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await context.agentSession('agent');
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = { feed: context.feed, binding: context.options.binding,
      chat: context.options };
    wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
    const connectionOptions = { headers: context.headers() };
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const subscription = { type: 'subscribe', topic: 'conversation',
      conversationId: 'agent', since: 0 };
    const checksBeforeSubscription = context.fgaProxy!.checkCount();
    socket.send(JSON.stringify(subscription));
    function ready() {
      return received.some(isReady);
    }
    await until(ready);
    const initialChecks = context.fgaProxy!.checkCount();
    expect(initialChecks - checksBeforeSubscription).toBe(2);
    await delay(2000);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount() - initialChecks).toBe(0);

    await context.append('conversation-agent', 'agent.turn_started', {
      conversationId: 'agent', turnId: 'agent-turn', assistantId: 'assistant',
    }, false);
    await context.runner.run(conversations);
    await delay(300);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks);

    await context.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob',
    }, false);
    function accessRechecked() {
      return context.fgaProxy!.checkCount() >= initialChecks + 2;
    }
    await until(accessRechecked);
    await delay(300);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks + 2);

    const closed = once(socket, 'close');
    const started = performance.now();
    await context.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'bob',
    }, false);
    function expired(): never {
      throw new Error('Socket removal took more than two seconds');
    }
    const timeout = delay(2000).then(expired);
    const closure: unknown[] = await Promise.race([closed, timeout]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
    expect(received.some(isRefused)).toBe(true);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks + 2);
  } finally {
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await context.close();
  }
}

function pauseFirstHistoryRead(fixture: Fixture) {
  const originalDb = fixture.options.db;
  let paused = false;
  let release!: () => void;
  let started!: () => void;
  function saveRelease(resolve: () => void) {
    release = resolve;
  }
  function saveStarted(resolve: () => void) {
    started = resolve;
  }
  const gate = new Promise<void>(saveRelease);
  const reached = new Promise<void>(saveStarted);
  async function query<Row extends Record<string, unknown>>(sql: string, parameters?: unknown[]) {
    const result = await originalDb.query<Row>(sql, parameters);
    if (!paused && sql.startsWith('SELECT * FROM conversation_feed')) {
      paused = true;
      started();
      await gate;
    }
    return result;
  }
  fixture.options.db = { query };
  return { reached, release };
}

it('HTTP: agent session history read survives the assistant starting a turn',
  historyDuringTurnStart, 120_000);

async function historyDuringTurnStart() {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    const pause = pauseFirstHistoryRead(context);
    const reading = context.app.inject({ url: '/api/conversations/agent/messages', headers: context.headers() });
    await pause.reached;
    await context.append('conversation-agent', 'agent.turn_started', {
      conversationId: 'agent', turnId: 'agent-turn', assistantId: 'assistant',
    }, false);
    pause.release();
    const response = await reading;
    expect(response.statusCode).toBe(200);
  } finally {
    await context.close();
  }
}

it('WS: a slow content read stays open while the assistant completes a turn',
  socketDuringTurnCompletion, 120_000);

async function socketDuringTurnCompletion() {
  const context = await fixture();
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await context.agentSession('agent');
    await context.append('conversation-agent', 'agent.turn_started', {
      conversationId: 'agent', turnId: 'agent-turn', assistantId: 'assistant',
    }, false);
    await context.runner.run(conversations);
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    wss = attachWebSocketServer(context.app.server, context.app.log, context.config,
      { feed: context.feed, binding: context.options.binding, chat: context.options });
    const pause = pauseFirstHistoryRead(context);
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers: context.headers() });
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId: 'agent', since: 0 }));
    await pause.reached;
    await context.append('conversation-agent', 'agent.turn_completed', {
      conversationId: 'agent', turnId: 'agent-turn',
    }, false);
    await delay(2100);
    pause.release();
    function settled() {
      return received.some(isReadyOrRefused);
    }
    await until(settled);
    expect(received.some(isRefused)).toBe(false);
    expect(received.some(isReady)).toBe(true);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await context.close();
  }
}

it('keeps history, list and socket fast on a session with 1,502 events',
  longAgentSession, 600_000);

async function longAgentSession() {
  const context = await fixture();
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    await context.agentSession('long');
    const count = 1500;
    const previousHead = await context.nats.store.head();
    const encrypted = context.keys.encrypt('test', 'long', 'delta');
    for (let index = 0; index < count; index++) {
      const event = envelope('test', 'conversation-long', 'agent.message_delta', {
        conversationId: 'long', turnId: 'long-turn', messageId: 'reply', contentType: 'text', ...encrypted,
      });
      await context.nats.connection.request(wireSubject(event.subject), JSON.stringify(event));
    }
    expect(await context.nats.store.head()).toBe(previousHead + count);
    await context.runner.run(conversations);
    let started = performance.now();
    const read = await context.app.inject({ url: '/api/conversations/long/messages', headers: context.headers() });
    const readMs = performance.now() - started;
    started = performance.now();
    const list = await context.app.inject({ url: '/api/conversations', headers: context.headers() });
    const listMs = performance.now() - started;
    expect(read.statusCode, 'Long-session history').toBe(200);
    expect(list.statusCode, 'Long-session list').toBe(200);
    expect(readMs).toBeLessThan(1500);
    expect(listMs).toBeLessThan(1500);
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = { feed: context.feed, binding: context.options.binding, chat: context.options };
    wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
    const connectionOptions = { headers: context.headers() };
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const subscription = {
      type: 'subscribe', topic: 'conversation', conversationId: 'long', since: 0,
    };
    started = performance.now();
    socket.send(JSON.stringify(subscription));
    function ready() {
      return received.some(isReady);
    }
    await until(ready);
    const socketMs = performance.now() - started;
    expect(socketMs).toBeLessThan(1500);
    await delay(350);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(received.some(isRefused)).toBe(false);
    socket.terminate();
    const sendRequest = {
      method: 'POST' as const, url: '/api/conversations/long/messages',
      headers: context.headers(), payload: { id: 'long-send', text: 'Next question' },
    };
    const sent = await context.app.inject(sendRequest);
    expect(sent.statusCode, 'Long-session send').toBe(200);
    const retried = await context.app.inject(sendRequest);
    expect(retried.statusCode, 'Long-session retry').toBe(200);
    expect(retried.body).toBe(sent.body);
    await context.runner.run(conversations);
    const status = await context.app.inject({
      url: '/api/conversations/long/changes/long-send', headers: context.headers(),
    });
    expect(status.statusCode, 'Long-session status').toBe(200);
    expect(status.json()).toMatchObject({ status: 'appended', commandId: 'long-send' });
    console.log(`1,502 events: history ${readMs.toFixed(0)} ms; list ${listMs.toFixed(0)} ms; ` +
      `socket ready ${socketMs.toFixed(0)} ms`);
  } finally {
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await context.close();
  }
}

function isReady(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'ready';
}
function isRefused(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'refused';
}
function isReadyOrRefused(message: ReturnType<typeof chatMessageSchema.parse>) {
  return isReady(message) || isRefused(message);
}

const unchangedAccessEvents = [
  { subject: 'conversation-agent', type: 'agent.turn_completed',
    data: { conversationId: 'agent', turnId: 'agent-turn' } },
  { subject: 'conversation-agent', type: 'agent.turn_failed',
    data: { conversationId: 'agent', turnId: 'agent-turn', reason: 'unavailable' } },
  { subject: 'conversation-agent', type: 'conversation.closed',
    data: { conversationId: 'agent', closedBy: 'alice' } },
  { subject: 'conversation-agent', type: 'file.uploaded', data: {
    conversationId: 'agent', fileId: 'file', uploadedBy: 'alice', name: 'notes.txt',
    size: 5, sha256: 'a'.repeat(64), mime: 'text/plain', objectKey: 'test/agent/file',
  } },
  { subject: 'conversation-agent', type: 'file.delivered', data: {
    conversationId: 'agent', fileId: 'file', computerId: 'computer', sha256: 'a'.repeat(64),
  } },
  { subject: 'member-alice', type: 'member.invited', data: {
    memberId: 'alice', invitationId: 'next', email: 'alice@example.test',
    role: 'member', invitedBy: 'owner',
  } },
  { subject: 'ownership-test', type: 'ownership.seeded', data: { ownerIds: ['alice'] } },
];

type AccessEvent = { subject: string; type: string; data: unknown };
it.each(unchangedAccessEvents)('keeps HTTP reads authorised during $type', readDuringActivity, 120_000);

async function readDuringActivity(event: AccessEvent) {
  const context = await fixture();
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await context.agentSession('agent');
    pause = pauseFirstHistoryRead(context);
    const request = { url: '/api/conversations/agent/messages', headers: context.headers() };
    const reading = context.app.inject(request);
    await pause.reached;
    await context.append(event.subject, event.type, event.data, false);
    pause.release();
    expect((await reading).statusCode).toBe(200);
  } finally {
    pause?.release();
    await context.close();
  }
}

const changedAccessEvents = [
  { subject: 'conversation-agent', type: 'participant.added',
    data: { conversationId: 'agent', participantId: 'bob', addedBy: 'alice' } },
  { subject: 'conversation-agent', type: 'participant.removed',
    data: { conversationId: 'agent', participantId: 'alice', removedBy: 'bob' } },
  { subject: 'member-alice', type: 'member.removed',
    data: { memberId: 'alice', removedBy: 'bob' } },
  { subject: 'member-alice', type: 'member.role_changed',
    data: { memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob' } },
];
it.each(changedAccessEvents)('returns history authorised before $type was recorded',
  readDuringAccessChange, 120_000);

async function readDuringAccessChange(event: AccessEvent) {
  const context = await fixture();
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await context.agentSession('agent');
    pause = pauseFirstHistoryRead(context);
    const request = { url: '/api/conversations/agent/messages', headers: context.headers() };
    const reading = context.app.inject(request);
    await pause.reached;
    await context.append(event.subject, event.type, event.data, false);
    pause.release();
    const response = await reading;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Hello');
  } finally {
    pause?.release();
    await context.close();
  }
}

it('returns history when its content read takes more than two seconds', slowHistoryRead, 120_000);

async function slowHistoryRead() {
  const context = await fixture();
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await context.agentSession('agent');
    pause = pauseFirstHistoryRead(context);
    const request = { url: '/api/conversations/agent/messages', headers: context.headers() };
    const reading = context.app.inject(request);
    await pause.reached;
    await delay(2100);
    pause.release();
    const response = await reading;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Hello');
  } finally {
    pause?.release();
    await context.close();
  }
}

it('reports a committed send when its history reads together exceed ten seconds',
  sendWithSlowHistory, 120_000);

async function sendWithSlowHistory() {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    const originalRead = context.options.store.readStream.bind(context.options.store);
    async function* slowMessages(subject: string, fromSequence?: number, deadline?: number) {
      for await (const row of originalRead(subject, fromSequence, deadline)) {
        yield row;
        // Access stops at creation. Only command history reads need this delayed continuation.
        if (subject === 'conversation-agent' && row.event.type === 'conversation.created') {
          await delay(5500);
        }
      }
    }
    context.options.store.readStream = slowMessages;
    const request = {
      method: 'POST' as const, url: '/api/conversations/agent/messages', headers: context.headers(),
      payload: { id: 'slow-history-send', text: 'Still has its own budget' },
    };
    const response = await context.app.inject(request);
    expect(response.statusCode).toBe(200);
    const retried = await context.app.inject(request);
    expect(retried.statusCode).toBe(200);
    expect(retried.body).toBe(response.body);
  } finally {
    await context.close();
  }
}

it('keeps chat readable while an ownership appointment is waiting for its IAM receipt',
  readDuringPendingOwnership, 120_000);

async function readDuringPendingOwnership() {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    await context.append('member-bob', 'member.role_changed', {
      memberId: 'bob', previousRole: 'member', newRole: 'owner', changedBy: 'owner',
    });
    await context.append('ownership-test', 'ownership.seeded', { ownerIds: ['bob'] });
    await context.append('ownership-test', 'ownership.transferred', {
      memberId: 'alice', transferredBy: 'bob',
    }, false);
    const request = { url: '/api/conversations/agent/messages', headers: context.headers() };
    const response = await context.app.inject(request);
    expect(response.statusCode).toBe(200);
  } finally {
    await context.close();
  }
}

it('lists 160 conversations quickly when most belong to other people',
  manyConversations, 600_000);

async function manyConversations() {
  const context = await fixture();
  try {
    for (let index = 0; index < 160; index++) {
      const conversationId = `session-${index}`;
      const owner = index < 30 ? 'alice' : 'bob';
      context.keys.provision('test', conversationId);
      let data: unknown = {
        conversationId, createdBy: owner, mode: 'agent_session', assistantId: 'assistant',
      };
      if (index >= 120) {
        data = {
          conversationId, createdBy: 'bob', mode: 'direct', participantIds: ['bob', 'carol'],
        };
      }
      await context.append(`conversation-${conversationId}`, 'conversation.created', data);
      const encrypted = context.keys.encrypt('test', conversationId, 'Private title');
      const message = {
        conversationId, authorId: owner, authorKind: 'human', contentType: 'text', ...encrypted,
      };
      await context.append(`conversation-${conversationId}`, 'message.posted', message, false);
    }
    await context.runner.run(conversations);
    const started = performance.now();
    const response = await context.app.inject({
      url: '/api/conversations', headers: context.headers(),
    });
    const elapsed = performance.now() - started;
    expect(response.statusCode).toBe(200);
    expect(response.json<{ rows: unknown[] }>().rows).toHaveLength(30);
    expect(elapsed).toBeLessThan(1500);
  } finally {
    await context.close();
  }
}

it('checks the first and last send on a direct chat with 1,500 messages',
  longDirectChatStatus, 600_000);

async function longDirectChatStatus() {
  const context = await fixture();
  try {
    context.keys.provision('test', 'pair');
    await context.append('conversation-pair', 'conversation.created', {
      conversationId: 'pair', createdBy: 'alice', mode: 'direct',
      participantIds: ['alice', 'bob'],
    });
    const encrypted = context.keys.encrypt('test', 'pair', 'Hello');
    for (let index = 0; index < 1500; index++) {
      const data = {
        conversationId: 'pair', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted,
      };
      const event = envelope('test', 'conversation-pair', 'message.posted', data);
      event.id = `message-${index}`;
      event.commandId = event.id;
      event.principal = { id: 'alice', kind: 'human' };
      await context.nats.connection.request(wireSubject(event.subject), JSON.stringify(event));
    }
    await context.runner.run(conversations);
    for (const commandId of ['message-0', 'message-1499']) {
      const started = performance.now();
      const response = await context.app.inject({
        url: `/api/conversations/pair/changes/${commandId}`, headers: context.headers(),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        status: 'appended', commandId, type: 'message.posted',
        projection: { content: 'current', iam: 'current' },
      });
      expect(performance.now() - started).toBeLessThan(1500);
    }
  } finally {
    await context.close();
  }
}

// Reuse the verifier's 30 visible sessions and 120 other sessions with three busy replies.
it('lists conversations while three caller sessions stream every 20 ms',
  listDuringStreaming, 120_000);

async function seedStreamingList(context: Fixture) {
  for (let index = 0; index < 150; index++) {
    const conversationId = `session-${index}`;
    const owner = index < 30 ? 'alice' : 'bob';
    context.keys.provision('test', conversationId);
    const creation = { conversationId, createdBy: owner,
      mode: 'agent_session', assistantId: 'assistant' };
    await context.append(`conversation-${conversationId}`, 'conversation.created', creation);
    const encrypted = context.keys.encrypt('test', conversationId, `Secret ${conversationId}`);
    const message = { conversationId, authorId: owner, authorKind: 'human',
      contentType: 'text', ...encrypted };
    await context.append(`conversation-${conversationId}`, 'message.posted', message, false);
  }
  await context.runner.run(conversations);
}

function streamReplies(context: Fixture) {
  let running = true;
  let sent = 0;
  async function pump(conversationId: string) {
    const encrypted = context.keys.encrypt('test', conversationId, 'delta');
    while (running) {
      const data = { conversationId, turnId: 'turn', messageId: 'reply',
        contentType: 'text', ...encrypted };
      const event = envelope('test', `conversation-${conversationId}`, 'agent.message_delta', data);
      await context.nats.connection.request(wireSubject(event.subject), JSON.stringify(event));
      sent++;
      await delay(20);
    }
  }
  const conversationIds = ['session-0', 'session-1', 'session-2'];
  const pumps = conversationIds.map(pump);
  async function stop() {
    running = false;
    await Promise.all(pumps);
    return sent;
  }
  return { stop };
}

async function listDuringStreaming() {
  const context = await fixture();
  let streaming: ReturnType<typeof streamReplies> | undefined;
  try {
    await seedStreamingList(context);
    streaming = streamReplies(context);
    await delay(300);
    for (let attempt = 0; attempt < 4; attempt++) {
      const request = { url: '/api/conversations', headers: context.headers() };
      const response = await context.app.inject(request);
      expect(response.statusCode).toBe(200);
      const rows = response.json<{ rows: { conversationId: string }[] }>().rows;
      expect(rows).toHaveLength(30);
      for (const row of rows) {
        const sessionIndex = Number(row.conversationId.slice('session-'.length));
        expect(sessionIndex).toBeLessThan(30);
      }
      expect(response.body).not.toContain('Secret session-30');
    }
    expect(await streaming.stop()).toBeGreaterThan(0);
    streaming = undefined;
  } finally {
    await streaming?.stop();
    await context.close();
  }
}

it('revokes a socket within two seconds while its content read is waiting',
  removalDuringSlowSocketRead, 120_000);

async function removalDuringSlowSocketRead() {
  const context = await fixture();
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  let socket: WebSocket | undefined;
  let wss: ReturnType<typeof attachWebSocketServer> | undefined;
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await context.agentSession('agent');
    const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const realtime = { feed: context.feed, binding: context.options.binding,
      chat: context.options };
    wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
    pause = pauseFirstHistoryRead(context);
    const connectionOptions = { headers: context.headers() };
    socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
    }
    socket.on('message', receive);
    await once(socket, 'open');
    const subscription = { type: 'subscribe', topic: 'conversation',
      conversationId: 'agent', since: 0 };
    socket.send(JSON.stringify(subscription));
    await pause.reached;
    const closed = once(socket, 'close');
    const started = performance.now();
    await context.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'bob',
    }, false);
    function expired(): never {
      throw new Error('Socket removal took more than two seconds');
    }
    const timeout = delay(2000).then(expired);
    const closure: unknown[] = await Promise.race([closed, timeout]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    expect(received.some(isRefused)).toBe(true);
    expect(received.some(isReady)).toBe(false);
  } finally {
    pause?.release();
    socket?.terminate();
    if (wss) {
      function closeServer(resolve: () => void) {
        wss!.close(resolve);
      }
      await new Promise<void>(closeServer);
    }
    await context.close();
  }
}
