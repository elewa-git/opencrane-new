import { WebSocket } from 'ws';
import { once } from 'node:events';
import { attachWebSocketServer } from '../src/websocket.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope, history } from '@opencrane/models';
import {
  computers, conversations, members, connectMemberFeed, pgDb,
  ProjectionRunner,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
const socketMessageSchema = z.object({
  type: z.string(), row: z.object({ type: z.string() }).optional(),
});
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let directory: string;
let chat: NonNullable<Parameters<typeof buildServer>[1]>['chat'];
let counter = 0;
async function append(subject: string, type: string, data: unknown) {
  const record = envelope('test', subject, type, data, `read-fixture-${++counter}`);
  record.source = 'opencrane-server';
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
function memberId(_silo: string, _issuer: string, sub: string) {
  return Promise.resolve(sub);
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
  directory = await mkdtemp(`${tmpdir()}/chat-reads-`);
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.store, createLogger('chat-reads-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(computers);
  await runner.initialise(conversations);
  await append('member-alice', 'member.invited', {
    memberId: 'alice', role: 'member', email: 'alice@example.test', invitedBy: 'owner',
    invitationId: 'invite-alice', invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' },
  });
  await append('member-alice', 'member.joined', {
    memberId: 'alice', role: 'member', email: 'alice@example.test', displayName: 'Alice',
    invitationId: 'invite-alice',
  });
  await append('assistant-personal', 'assistant.created', {
    assistantId: 'personal', ownerId: 'alice', kind: 'personal',
  });
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

async function listsSixtySessions() {
  for (let index = 0; index < 60; index++) {
    const conversationId = `personal-${index}`;
    const input = { id: `create-${index}`, conversationId, assistantId: 'personal' };
    const response = await request('POST', '/api/conversations', input, 'alice');
    expect(response.statusCode, response.body).toBe(200);
    const rows = await history(nats.store, `conversation-${conversationId}`, 'test');
    await auth.handler.handle(rows[0]!.event, pgDb(dbs.queue));
  }
  await runner.run(conversations);
  const response = await request('GET', '/api/conversations', undefined, 'alice');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<{ rows: unknown[] }>().rows).toHaveLength(60);
}
it('lists 60 personal sessions', listsSixtySessions, 120_000);

async function readsDuringTurnChanges() {
  let stopped = false;
  async function reportTurns() {
    let turn = 0;
    while (!stopped) {
      const turnId = `http-turn-${++turn}`;
      await append('conversation-personal-0', 'agent.turn_started', {
        conversationId: 'personal-0', turnId, assistantId: 'personal',
      });
      await append('conversation-personal-0', 'agent.turn_completed', {
        conversationId: 'personal-0', turnId,
      });
      await delay(5);
    }
  }
  const reporting = reportTurns();
  try {
    for (let index = 0; index < 20; index++) {
      const response = await request('GET', '/api/conversations/personal-0/messages',
        undefined, 'alice');
      expect(response.statusCode, response.body).toBe(200);
    }
  } finally {
    stopped = true;
    await reporting;
  }
}
it('reads a transcript while turns start and end', readsDuringTurnChanges);

async function streamsDuringTurnChanges() {
  if (!chat) throw new Error('Missing chat fixture');
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed, binding: auth.binding, chat: { ...chat, feed } };
  const websocketServer = attachWebSocketServer(app.server, app.log, config, realtime);
  const session = { sub: 'alice', orgId: 'org-test', roles: [],
    authTime: 1790856000, exp: 2000000000 };
  const headers = { origin: 'https://app.example.test',
    cookie: `${config.cookieName}=${encodeSession(config, session)}` };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
  const messages: z.infer<typeof socketMessageSchema>[] = [];
  function collect(raw: Buffer) {
    messages.push(socketMessageSchema.parse(JSON.parse(raw.toString())));
  }
  function closeServer(resolve: () => void) {
    websocketServer.close(resolve);
  }
  function receivedReady() {
    return messages.some(isReady) || socket.readyState === WebSocket.CLOSED;
  }
  function isReady(message: typeof messages[number]) {
    return message.type === 'ready';
  }
  function receivedCompletion() {
    return messages.some(isCompletion) || socket.readyState === WebSocket.CLOSED;
  }
  function isCompletion(message: typeof messages[number]) {
    return message.row?.type === 'agent.turn_completed';
  }
  let stopped = false;
  async function reportTurns() {
    let turn = 0;
    while (!stopped) {
      const turnId = `socket-turn-${++turn}`;
      await append('conversation-personal-1', 'agent.turn_started', {
        conversationId: 'personal-1', turnId, assistantId: 'personal',
      });
      await append('conversation-personal-1', 'agent.turn_completed', {
        conversationId: 'personal-1', turnId,
      });
      await delay(5);
    }
  }
  socket.on('message', collect);
  let reporting: Promise<void> | undefined;
  try {
    await once(socket, 'open');
    const subscription = { type: 'subscribe', topic: 'conversation',
      conversationId: 'personal-1', since: 0 };
    socket.send(JSON.stringify(subscription));
    await until(receivedReady);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    reporting = reportTurns();
    for (let index = 0; index < 4; index++) {
      await delay(100);
      await runner.run(conversations);
    }
    await until(receivedCompletion);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(messages.some(isCompletion)).toBe(true);
  } finally {
    stopped = true;
    await reporting;
    socket.terminate();
    await new Promise<void>(closeServer);
    await feed.close();
  }
}
it('keeps a live transcript socket open while turns start and end', streamsDuringTurnChanges);
