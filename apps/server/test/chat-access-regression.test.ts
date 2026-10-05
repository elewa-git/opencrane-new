// Regression probes for turn activity during reads and long agent sessions.
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
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

async function fixture() {
  const nats = await natsFixture();
  const dbs = await databases();
  const fga = await openfga();
  const directory = await mkdtemp(`${tmpdir()}/review-p4-4-`);
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test' };
  const binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue);
  const auth = memberAuthorisation(binding);
  const keys = conversationKeys(directory);
  const runner = new ProjectionRunner(db, nats.store, createLogger('review'));
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const options: ChatOptions = { silo: 'test', store: nats.store, db, keys, binding, feed };
  const app = buildServer(config, { chat: options });
  async function append(subject: string, type: string, data: unknown, iam = true) {
    const event = envelope('test', subject, type, data);
    event.principal = { id: 'alice', kind: 'human' };
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
    await fga.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { app, nats, db, keys, runner, headers, append, agentSession, close, config, options, feed };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

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

it('WS: agent session live view survives the assistant completing a turn',
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
    pause.release();
    function settled() {
      return received.some(isReadyOrRefused);
    }
    await until(settled);
    expect(received.some(isRefused)).toBe(false);
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
    expect(read.statusCode).toBe(200);
    expect(list.statusCode).toBe(200);
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
it.each(changedAccessEvents)('returns retryable 503 when $type changes a read fence',
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
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    expect(response.body).not.toContain('Hello');
  } finally {
    pause?.release();
    await context.close();
  }
}

it('returns retryable 503 when a history read outlives its fence', expiredRead, 120_000);

async function expiredRead() {
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
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
  } finally {
    pause?.release();
    await context.close();
  }
}

it('gives a send its command budget when reading beyond creation takes more than two seconds',
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
          await delay(2100);
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
