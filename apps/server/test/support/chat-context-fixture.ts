import { once } from 'node:events';
import { objectId, TupleClient } from '../../../../libs/authz/src/client.ts';
import { WebSocket } from 'ws';
import type { AuthConfig } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import type { ChatOptions } from '../../src/chat/access.ts';
import { sessionCookie } from '@opencrane/auth/testing';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga } from '@opencrane/authz/testing';
import { appendEvent, event, natsFixture, type AppendEventOptions }
  from '@opencrane/event-store/testing';
import { computers, members, pgDb, ProjectionRunner, connectMemberFeed, type Query }
  from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { buildServer } from '../../src/server.ts';
import { attachWebSocketServer } from '../../src/websocket.ts';
import { testAuthConfig } from './test-auth-config.ts';

export async function chatContextFixture() {
  const config = testAuthConfig({ expectedOrgId: 'org-test' });
  const nats = await natsFixture();
  const fga = await openfga();
  const dbs = await databases();
  const binding = await createStore(fga.apiUrl, 'test');
  const auth = memberAuthorisation(binding);
  const database = pgDb(dbs.queue);
  const runner = new ProjectionRunner(database, nats.store,
    createLogger('context-test', { level: 'silent' }));
  await runner.initialise(members);
  await runner.initialise(computers);
  const reads = contextReads(database);
  const feed = await connectMemberFeed(String(dbs.queue.options.connectionString));
  const chat = { silo: 'test', store: nats.store, db: reads.db, binding, feed };
  const server = await contextServer(config, chat, feed);
  const events = contextEvents(nats.store, auth, database, runner, config.issuerUrl);
  async function permitAssistant(memberId: string, assistantId: string, silo = 'test') {
    const client = new TupleClient({ ...binding, silo });
    await client.write([{ user: objectId('person', silo, memberId), relation: 'acts_for',
      object: objectId('assistant', silo, assistantId) }], []);
  }
  const foreignAssistant = otherSiloContext.bind(null, database, chat);
  async function close() {
    reads.release();
    await server.close();
    await feed.close();
    await nats.close();
    await dbs.close();
    await fga.close();
  }
  await events.join('alice', 'identity-alice');
  await events.join('bob', 'identity-bob');
  return { config, chat, reads, ...events, connect: server.connect,
    permitAssistant, foreignAssistant, close };
}

function contextReads(database: Query) {
  let count = 0;
  let pending: Promise<void> | undefined;
  let releaseRead: (() => void) | undefined;
  let enteredRead: (() => void) | undefined;
  async function query<Row extends Record<string, unknown>>(
    sql: string, parameters?: unknown[], options?: { deadline: number },
  ) {
    if (sql.startsWith('SELECT assistant_id FROM computers')) {
      count++;
      enteredRead?.();
      await pending;
    }
    return database.query<Row>(sql, parameters, options);
  }
  function saveRelease(resolve: () => void): void {
    releaseRead = resolve;
  }
  function saveEntered(resolve: () => void): void {
    enteredRead = resolve;
  }
  function hold() {
    pending = new Promise<void>(saveRelease);
    return new Promise<void>(saveEntered);
  }

  function release(): void {
    releaseRead?.();
    pending = undefined;
    enteredRead = undefined;
  }
  function readCount(): number {
    return count;
  }
  return { db: { query }, hold, release, count: readCount };
}

function contextEvents(store: EventStore, auth: ReturnType<typeof memberAuthorisation>,
  database: Query, runner: ProjectionRunner, issuer: string) {
  async function append(options: Omit<AppendEventOptions, 'silo'>, authorise = true) {
    const saved = await appendEvent(store, { ...options, silo: 'test' });
    if (authorise && auth.handler.eventTypes.includes(options.type)) {
      await auth.handler.handle(saved.event, database);
    }
    await runner.run(members);
    await runner.run(computers);
  }
  async function join(memberId: string, sub: string) {
    await append({ subject: `member-${memberId}`, type: 'member.joined',
      principal: { kind: 'human', id: sub }, data: {
        memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
        displayName: memberId, role: 'member',
        identity: { issuer, sub },
      } });
  }
  async function assistant(assistantId: string, ownerId: string, authorise = true) {
    await append({ subject: `assistant-${assistantId}`, type: 'assistant.created',
      data: { assistantId, ownerId, kind: 'personal' } }, authorise);
  }
  async function remove(memberId: string) {
    await append({ subject: `member-${memberId}`, type: 'member.removed',
      data: { memberId, removedBy: 'owner' } });
  }
  return { join, assistant, remove };
}

async function contextServer(config: AuthConfig, chat: ChatOptions,
  feed: Awaited<ReturnType<typeof connectMemberFeed>>) {
  const app = buildServer(config, { chat });
  const sockets = attachWebSocketServer(app.server, app.log, config, {
    chat, binding: chat.binding, store: chat.store, feed,
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const clients: WebSocket[] = [];
  async function connect(sub = 'identity-alice') {
    const cookie = sessionCookie(config, { sub, orgId: 'org-test', roles: [],
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
  async function close() {
    for (const client of clients) client.terminate();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    await app.close();
  }
  return { connect, close };
}

async function otherSiloContext(database: Query, chat: ChatOptions) {
  const binding = { ...chat.binding, silo: 'other' };
  const member = event('foreign-member', 'member-alice', 'member.joined');
  const joined = { ...member, silo: 'other', data: {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Other Alice', role: 'member',
  } };
  await members.apply(database, joined, 1);
  await memberAuthorisation(binding).handler.handle(joined, database);
  const created = event('foreign-assistant', 'assistant-foreign', 'assistant.created');
  const record = { ...created, silo: 'other', data: {
    assistantId: 'foreign', ownerId: 'alice', kind: 'personal',
  } };
  await computers.apply(database, record, 1);
  return { ...chat, silo: 'other', binding };
}
