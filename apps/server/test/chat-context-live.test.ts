import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sessionCookie } from '@opencrane/auth/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { appendEvent, natsFixture, type AppendEventOptions } from '@opencrane/event-store/testing';
import { computers, members, pgDb, ProjectionRunner, connectMemberFeed } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

const config = testAuthConfig({ expectedOrgId: 'org-test' });
let nats: Awaited<ReturnType<typeof natsFixture>>;
let fga: Awaited<ReturnType<typeof openfga>>;
let dbs: Awaited<ReturnType<typeof databases>>;
let app: ReturnType<typeof buildServer>;
let auth: ReturnType<typeof memberAuthorisation>;
let runner: ProjectionRunner;
let origin: string;
let feed: Awaited<ReturnType<typeof connectMemberFeed>>;
let sockets: ReturnType<typeof attachWebSocketServer>;
const clients: WebSocket[] = [];

async function append(options: Omit<AppendEventOptions, 'silo'>): Promise<void> {
  const saved = await appendEvent(nats.store, { ...options, silo: 'test' });
  if (auth.handler.eventTypes.includes(options.type)) {
    await auth.handler.handle(saved.event, pgDb(dbs.queue));
  }
}
function memberId(_silo: string, _issuer: string, sub: string): Promise<string> {
  return Promise.resolve(sub);
}
async function setup(): Promise<void> {
  nats = await natsFixture();
  fga = await openfga();
  dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  auth = memberAuthorisation(binding);
  const db = pgDb(dbs.queue);
  runner = new ProjectionRunner(db, nats.store, createLogger('context-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(computers);
  await append({ subject: 'member-alice', type: 'member.joined', data: {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member',
  } });
  await runner.run(members);
  feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const chat = { silo: 'test', store: nats.store, db, binding, feed: { memberId } };
  app = buildServer(config, { chat });
  sockets = attachWebSocketServer(app.server, app.log, config, {
    chat, binding, store: nats.store,
    feed,
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
}
beforeAll(setup, 120_000);
async function cleanup(): Promise<void> {
  for (const client of clients) client.terminate();
  for (const socket of sockets?.clients ?? []) socket.terminate();
  sockets?.close();
  await app?.close();
  await feed?.close();
  await nats?.close();
  await dbs?.close();
  await fga?.close();
}
afterAll(cleanup);

async function connect(sub = 'alice', orgId = 'org-test') {
  const cookie = sessionCookie(config, { sub, orgId, roles: [],
    authTime: 1790856000, exp: 2000000000 }).cookie;
  const headers = { cookie, origin: new URL(config.redirectUri).origin };
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/ws', { headers });
  clients.push(socket);
  const messages: unknown[] = [];
  function receive(data: Buffer): void {
    messages.push(JSON.parse(data.toString()));
  }
  socket.on('message', receive);
  await once(socket, 'open');
  const firstOutcome = Promise.race([once(socket, 'close'), once(socket, 'message')]);
  socket.send(JSON.stringify({ type: 'subscribe', topic: 'chat-context' }));
  return { socket, messages, firstOutcome };
}

async function followsProvisioning(): Promise<void> {
  const { socket, messages } = await connect();
  function initialContextReceived(): boolean {
    return messages.length > 0;
  }
  await until(initialContextReceived);
  expect(messages[0]).toMatchObject({ type: 'context', topic: 'chat-context',
    data: { memberId: 'alice', assistantId: null, role: 'member' } });
  await append({ subject: 'assistant-personal', type: 'assistant.created', data: {
    assistantId: 'personal', ownerId: 'alice', kind: 'personal',
  } });
  await runner.run(computers);
  function assignmentReceived(): boolean {
    return messages.length > 1;
  }
  await until(assignmentReceived);
  expect(messages.at(-1)).toMatchObject({ type: 'context', topic: 'chat-context',
    data: { memberId: 'alice', assistantId: 'personal' } });
  const closed = once(socket, 'close');
  await append({ subject: 'member-alice', type: 'member.removed', data: {
    memberId: 'alice', removedBy: 'owner',
  } });
  const result: unknown[] = await closed;
  expect(result[0]).toBe(1008);
}
it('delivers the personal assignment after projection without a conversation, then revokes access',
  followsProvisioning, 30_000);

async function refusesNonMember(): Promise<void> {
  const { messages, firstOutcome } = await connect('outsider');
  const result: unknown[] = await firstOutcome;
  expect(result[0]).toBe(1008);
  expect(messages).toEqual([]);
}
it('never delivers another member context to a signed-in non-member', refusesNonMember);
