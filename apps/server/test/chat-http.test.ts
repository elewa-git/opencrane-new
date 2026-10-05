import { WebSocket } from 'ws';
import { once } from 'node:events';
import { chatMessageSchema } from '@opencrane/protocol';
import { attachWebSocketServer } from '../src/websocket.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { members, computers, conversations, pgDb, ProjectionRunner, connectMemberFeed } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope, history } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

it('serves private chat commands and reads to joined members, refusing other organisations and wrong origins', async () => {
  const nats = await natsFixture(), dbs = await databases(), fga = await openfga();
  const directory = await mkdtemp(`${tmpdir()}/chat-http-`);
  const config = { ...testAuthConfig(), expectedOrgId: 'org-test' }, binding = await createStore(fga.apiUrl, 'test');
  const db = pgDb(dbs.queue), auth = memberAuthorisation(binding), keys = conversationKeys(directory);
  const runner = new ProjectionRunner(db, nats.store, createLogger('chat', { level: 'silent' }));
  const feed = await connectMemberFeed(dbs.queue.options.connectionString!);
  const app = buildServer(config, { chat: { silo: 'test', store: nats.store, db, keys, binding, feed } });
  try {
    for (const [subject, type, data] of [
      ['member-alice', 'member.invited', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', invitedBy: 'owner', invitedIdentity: { issuer: config.issuerUrl, sub: 'alice' } }],
      ['member-alice', 'member.joined', { memberId: 'alice', invitationId: 'invite', email: 'a@example.test', role: 'member', displayName: 'Alice' }],
      ['assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }],
    ] as const) {
      const event = envelope('test', subject, type, data); event.principal = { id: 'alice', kind: 'human' };
      expect((await nats.store.append({ event, expectedSequence: (await history(nats.store, subject, 'test')).at(-1)?.sequence ?? 0 })).status).toBe('appended');
      if (type !== 'member.invited') await auth.handler.handle(event, db);
    }
    await runner.initialise(members); await runner.run(members); await runner.initialise(conversations); await runner.initialise(computers); await runner.run(computers);
    const headers = (orgId = 'org-test') => ({ origin: new URL(config.redirectUri).origin,
      cookie: `${config.cookieName}=${encodeSession(config, { sub: 'alice', orgId, roles: [], authTime: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+60 })}` });
    const personal = await app.inject({ url: '/api/chat', headers: headers() });
    expect(personal.statusCode).toBe(200);
    expect(personal.json()).toMatchObject({ memberId: 'alice', assistantId: 'assistant', displayName: 'Alice' });
    expect((await app.inject({ url: '/api/chat', headers: headers('wrong') })).statusCode).toBe(403);
    for (const [subject, type, data] of [
      ['team-sales', 'team.created', { teamId: 'sales', name: 'Sales', createdBy: 'alice' }],
      ['team-sales', 'team.member_added', { teamId: 'sales', memberId: 'alice', addedBy: 'alice' }],
      ['team-finance', 'team.created', { teamId: 'finance', name: 'Finance', createdBy: 'alice' }],
      ['assistant-shared', 'assistant.created', { assistantId: 'shared', ownerId: 'sales', kind: 'team', payingGroupId: 'sales' }],
    ] as const) {
      const event = envelope('test', subject, type, data);
      expect((await nats.store.append({ event, expectedSequence: (await history(nats.store, subject, 'test')).at(-1)?.sequence ?? 0 })).status).toBe('appended');
      await auth.handler.handle(event, db);
    }
    expect((await nats.store.append({ expectedSequence: 0, event: envelope('other', 'team-foreign', 'team.created', {
      teamId: 'foreign', name: 'Other installation', createdBy: 'alice',
    }) })).status).toBe('appended');
    for (const payingGroupId of ['invented', 'foreign', 'finance']) {
      const response = await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(),
        payload: { id: `create-${payingGroupId}`, conversationId: payingGroupId, assistantId: 'shared', payingGroupId } });
      expect(response.statusCode).toBe(403); expect(response.body).toContain('Paying group');
      expect(await history(nats.store, `conversation-${payingGroupId}`, 'test')).toEqual([]);
    }
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(), payload: {
      id: 'create-sales', conversationId: 'sales', assistantId: 'shared', payingGroupId: 'sales',
    } })).statusCode).toBe(200);
    const conversationId = randomUUID(), create = { id: randomUUID(), conversationId, assistantId: 'assistant' };
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: headers('wrong'), payload: create })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: { ...headers(), origin: 'https://wrong.test' }, payload: create })).statusCode).toBe(403);
    for (const mode of ['direct', 'group']) {
      const response = await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(), payload: { ...create, mode } });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ status: 'refused' });
    }
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(), payload: create })).statusCode).toBe(200);
    await auth.handler.handle((await history(nats.store, `conversation-${conversationId}`, 'test'))[0]!.event, db);
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: { id: randomUUID(), text: 'Hello computer' } })).statusCode).toBe(200);
    await runner.run(conversations);
    const list = await app.inject({ url: '/api/conversations', headers: headers() });
    expect(list.statusCode).toBe(200); expect(list.body).toContain(conversationId); expect(list.body).toContain('agent_session'); expect(list.json<{ rows: { title: string }[] }>().rows[0]?.title).toBe('hello-computer');
    const messages = await app.inject({ url: `/api/conversations/${conversationId}/messages`, headers: headers() });
    expect(messages.statusCode).toBe(200); expect(messages.body).toContain('Hello computer');
    const turnId = messages.json<{ rows: { id: string; type: string }[] }>().rows.find(row => row.type === 'message.posted')!.id;
    const stop = { id: randomUUID(), stopTurnId: turnId };
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: stop })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: stop })).statusCode).toBe(200);
    await runner.run(conversations);
    expect((await app.inject({ url: '/api/conversations', headers: headers() })).json<{ rows: { status: string }[] }>().rows[0]?.status).toBe('stopped');
    const stopped = await app.inject({ url: `/api/conversations/${conversationId}/messages`, headers: headers() });
    expect(stopped.json<{ rows: { type: string }[] }>().rows.filter(row => row.type === 'agent.turn_stop_requested')).toHaveLength(1);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const wss = attachWebSocketServer(app.server, app.log, config, { feed, binding, chat: { silo: 'test', store: nats.store, db, keys, binding, feed } });
    const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
    const connect = async (since: number, generation?: number) => {
      const ws = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers: headers() });
      ws.on('message', raw => received.push(chatMessageSchema.parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as unknown)));
      await once(ws, 'open'); ws.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId, since, generation })); return ws;
    };
    let socket = await connect(0);
    try {
      await until(() => received.some(r => r.type === 'ready'));
      const cursor = received.at(-1)!; socket.terminate(); await once(socket, 'close'); received.length = 0;
      const id = randomUUID();
      await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: { id, text: 'Posted offline' } });
      await runner.run(conversations); socket = await connect(cursor.position, cursor.generation);
      await until(() => received.some(r => r.type === 'ready'));
      expect(received.filter(r => r.type === 'event').map(r => r.row?.id)).toEqual([id]);
      socket.terminate(); await once(socket, 'close'); received.length = 0;
      await runner.rebuild(conversations); socket = await connect(cursor.position, cursor.generation);
      await until(() => received.some(r => r.type === 'resync'));
      expect(received[0]).toMatchObject({ type: 'resync', position: 0, generation: cursor.generation + 1 });
    } finally { socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); }

  } finally { await app.close(); await feed.close(); await nats.close(); await dbs.close(); await fga.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
