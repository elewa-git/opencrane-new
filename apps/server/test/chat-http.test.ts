import type { FastifyInstance } from 'fastify';
import type { EventStore } from '@opencrane/event-store';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { chatMessageSchema, chatFeedSchema } from '@opencrane/protocol';
import { attachWebSocketServer } from '../src/websocket.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { chatRows } from '../src/chat/history.ts';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import type { EventEnvelope } from '@opencrane/events';
import { members, computers, conversations, pgDb, ProjectionRunner, connectMemberFeed } from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope, history } from '@opencrane/models';
import { buildServer } from '../src/server.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

async function refusesRoutineIdentifiers(app: FastifyInstance, store: EventStore,
  headers: Record<string, string>, conversationId: string) {
  const before = await store.head();
  const prefixes = ['routine-session-', 'routine-session-create-'];
  for (const prefix of prefixes) {
    const reserved = `${prefix}future-occurrence`;
    const creations = [
      { id: `create-${reserved}`, conversationId: reserved, assistantId: 'assistant' },
      { id: reserved, conversationId: `ordinary-${reserved}`, assistantId: 'assistant' },
    ];
    for (const payload of creations) {
      const request = { method: 'POST' as const, url: '/api/conversations', headers, payload };
      const reply = await app.inject(request);
      expect(reply.statusCode).toBe(400);
      expect(reply.json()).toEqual({ status: 'refused' });
    }
    const message = { method: 'POST' as const,
      url: `/api/conversations/${conversationId}/messages`, headers,
      payload: { id: reserved, text: 'Must not be appended' } };
    expect((await app.inject(message)).statusCode).toBe(400);
    const paths = ['messages', 'participants', 'origin', 'changes/ordinary-change'];
    for (const path of paths) {
      const request = { url: `/api/conversations/${reserved}/${path}`, headers };
      expect((await app.inject(request)).statusCode).toBe(400);
    }
    const receipt = { url: `/api/conversations/${conversationId}/changes/${reserved}`, headers };
    expect((await app.inject(receipt)).statusCode).toBe(400);
    const commands = [
      { path: 'messages', payload: { id: 'ordinary-message', text: 'Must not be appended' } },
      { path: 'participants', payload: { id: 'ordinary-participant', action: 'leave' } },
      { path: 'state', payload: { id: 'ordinary-state', action: 'archive', archived: true } },
    ];
    for (const command of commands) {
      const request = { method: 'POST' as const,
        url: `/api/conversations/${reserved}/${command.path}`, headers, payload: command.payload };
      expect((await app.inject(request)).statusCode).toBe(400);
    }
  }
  const forged = { method: 'POST' as const, url: '/api/conversations', headers,
    payload: { id: 'forged-binding', conversationId: 'forged-binding', assistantId: 'assistant',
      routinePreparation: { routineId: 'orders', occurrenceId: 'future-occurrence',
        claimId: 'claim', claimPosition: 1, workerId: 'worker' } } };
  expect((await app.inject(forged)).statusCode).toBe(400);
  expect(await store.head()).toBe(before);
}

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
    expect(personal.json()).toMatchObject({
      memberId: 'alice',
      assistantId: 'assistant',
      displayName: 'Alice',
      memoryAdmission: {
        state: 'disabled',
        failing: ['The P4-15 private memory checks have not run yet.'],
      },
    });
    expect((await app.inject({ url: '/api/chat', headers: headers('wrong') })).statusCode).toBe(403);
    // An identity allowed by name keeps access from its own organisation, as at sign-in.
    // Naming someone else does not let Alice in from another organisation.
    for (const [subject, status] of [['alice', 200], ['bob', 403]] as const) {
      const allowed = { ...config, extraIdentities: [{ issuer: config.issuerUrl, subject }] };
      const allowedApp = buildServer(allowed, { chat: { silo: 'test', store: nats.store, db, keys, binding, feed } });
      try {
        expect((await allowedApp.inject({ url: '/api/chat', headers: headers('wrong') })).statusCode).toBe(status);
      } finally { await allowedApp.close(); }
    }
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
    await auth.handler.handle((await history(nats.store, 'conversation-sales', 'test'))[0]!.event, db);
    const conversationId = randomUUID(), create = { id: randomUUID(), conversationId, assistantId: 'assistant' };
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: headers('wrong'), payload: create })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: { ...headers(), origin: 'https://wrong.test' }, payload: create })).statusCode).toBe(403);
    for (const mode of ['direct', 'group']) {
      const response = await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(), payload: { ...create, mode } });
      expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ status: 'refused' });
    }
    expect((await app.inject({ method: 'POST', url: '/api/conversations', headers: headers(), payload: create })).statusCode).toBe(200);
    await auth.handler.handle((await history(nats.store, `conversation-${conversationId}`, 'test'))[0]!.event, db);
    await refusesRoutineIdentifiers(app, nats.store, headers(), conversationId);
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: { id: randomUUID(), text: 'Hello computer' } })).statusCode).toBe(200);
    await runner.run(conversations);
    await runner.run(computers);
    const list = await app.inject({ url: '/api/conversations', headers: headers() });
    expect(list.statusCode).toBe(200); expect(list.body).toContain(conversationId); expect(list.body).toContain('agent_session'); expect(list.json<{ rows: { title: string }[] }>().rows[0]?.title).toBe('hello-computer');
    expect(list.json<{ rows: { assistantKind: string }[] }>().rows[0]?.assistantKind)
      .toBe('personal');
    const teamRow = list.json<{ rows: { conversationId: string; assistantKind: string }[] }>()
      .rows.find(row => row.conversationId === 'sales');
    expect(teamRow?.assistantKind).toBe('team');
    const lifecycleRead = vi.spyOn(nats.store, 'readStream');
    lifecycleRead.mockClear();
    await chatRows({ silo: 'test', store: nats.store, db, keys, binding, feed },
      conversationId, 'agent_session');
    expect(lifecycleRead).not.toHaveBeenCalled();
    lifecycleRead.mockRestore();
    const messages = await app.inject({ url: `/api/conversations/${conversationId}/messages`, headers: headers() });
    expect(messages.statusCode).toBe(200); expect(messages.body).toContain('Hello computer');
    const turnId = messages.json<{ rows: { id: string; type: string }[] }>().rows.find(row => row.type === 'message.posted')!.id;
    for (const outcome of ['saved', 'kept_existing'] as const) {
      const delivery = envelope('test', `conversation-${conversationId}`, 'file.delivered', {
        conversationId, fileId: `file-${outcome}`, computerId: 'computer',
        sha256: 'a'.repeat(64), outcome,
      });
      const expectedSequence = await nats.store.head(`conversation-${conversationId}`);
      const append = { event: delivery, expectedSequence };
      expect((await nats.store.append(append)).status).toBe('appended');
    }
    await runner.run(conversations);
    const uploadReadRequest = {
      url: `/api/conversations/${conversationId}/messages`, headers: headers(),
    };
    const uploadRead = await app.inject(uploadReadRequest);
    expect(uploadRead.statusCode).toBe(200);
    const uploadFeed = chatFeedSchema.parse(uploadRead.json());
    function isDelivery(row: (typeof uploadFeed.rows)[number]) {
      return row.type === 'file.delivered';
    }
    const deliveries = uploadFeed.rows.filter(isDelivery);
    expect(deliveries).toMatchObject([
      { data: { outcome: 'saved' } }, { data: { outcome: 'kept_existing' } },
    ]);
    const stop = { id: randomUUID(), stopTurnId: turnId };
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: stop })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: stop })).statusCode).toBe(200);
    await runner.run(conversations);
    expect((await app.inject({ url: '/api/conversations', headers: headers() })).json<{ rows: { status: string }[] }>().rows[0]?.status).toBe('stopped');
    const stopped = await app.inject({ url: `/api/conversations/${conversationId}/messages`, headers: headers() });
    expect(stopped.json<{ rows: { type: string }[] }>().rows.filter(row => row.type === 'agent.turn_stop_requested')).toHaveLength(1);
    for (const [type, data, state] of [
      ['computer.ready', { assistantId: 'assistant', computerId: 'computer' }, 'ready'],
      ['computer.suspended', { assistantId: 'assistant', computerId: 'computer' }, 'starting'],
      ['computer.resumed', { assistantId: 'assistant', computerId: 'computer', tokenId: 'token:resume' }, 'starting'],
      ['computer.ready', { assistantId: 'assistant', computerId: 'computer' }, 'ready'],
    ] as const) {
      const event = envelope('test', 'computer-assistant', type, data);
      const sequence = (await history(nats.store, 'computer-assistant', 'test')).at(-1)?.sequence ?? 0;
      expect((await nats.store.append({ event, expectedSequence: sequence })).status).toBe('appended');
      await runner.run(computers);
      const response = await app.inject({ url: `/api/conversations/${conversationId}/messages`,
        headers: headers() });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ computerState: state, computerRecovered: false });
    }
    const lost = envelope('test', `conversation-${conversationId}`, 'agent.output_lost', { conversationId, turnId });
    expect((await nats.store.append({ event: lost,
      expectedSequence: (await history(nats.store, `conversation-${conversationId}`, 'test')).at(-1)!.sequence
    })).status).toBe('appended');
    const completed = envelope('test', `conversation-${conversationId}`, 'agent.turn_completed', { conversationId, turnId });
    expect((await nats.store.append({ event: completed,
      expectedSequence: (await history(nats.store, `conversation-${conversationId}`, 'test')).at(-1)!.sequence
    })).status).toBe('appended');
    await runner.run(conversations);
    const lostList = await app.inject({ url: '/api/conversations', headers: headers() });
    expect(lostList.json<{ rows: { status: string }[] }>().rows[0]?.status).toBe('lost');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    let contentQueries = 0;
    const originalQuery = db.query.bind(db);
    const countContentQueries = async <Row extends Record<string, unknown>>(
      sql: string, parameters?: unknown[],
    ) => {
      if (sql.startsWith('SELECT * FROM conversation_feed') ||
          sql.startsWith('SELECT c.status FROM computers')) {
        contentQueries += 1;
      }
      return originalQuery<Row>(sql, parameters);
    };
    db.query = countContentQueries;
    const wss = attachWebSocketServer(app.server, app.log, config, { feed, binding, chat: { silo: 'test', store: nats.store, db, keys, binding, feed } });
    const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
    const connect = async (since: number, generation?: number) => {
      const ws = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers: headers() });
      ws.on('message', raw => received.push(chatMessageSchema.parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as unknown)));
      await once(ws, 'open'); ws.send(JSON.stringify({ type: 'subscribe', topic: 'conversation', conversationId, since, generation })); return ws;
    };
    const evidence: EventEnvelope = {
      id: randomUUID(), commandId: randomUUID(), type: 'agent.memory_context_recorded',
      subject: `conversation-${conversationId}`, silo: 'test', source: 'opencrane-server',
      principal: { kind: 'system', id: 'server' }, time: new Date().toISOString(),
      correlation: {}, data: {
        conversationId, turnId, requesterId: 'alice', assistantId: 'assistant',
        computerId: 'computer', generation: 1, threadId: 'thread',
        inputGeneration: 'context', action: 'prepared', delivery: null,
        callDigest: null, dispatchDigest: null, additions: [], scopePositions: [],
        projectionGeneration: 'projection', byteCount: 0, hasOmissions: false, reason: 'none',
      },
    };
    const evidenceAppend = await nats.store.append({ event: evidence,
      expectedSequence: await nats.store.head(evidence.subject) });
    expect(evidenceAppend.status).toBe('appended');
    await runner.run(conversations);
    const historyWithEvidence = await app.inject({
      url: `/api/conversations/${conversationId}/messages`, headers: headers(),
    });
    expect.soft(historyWithEvidence.statusCode).toBe(200);
    expect.soft(historyWithEvidence.json<{ rows?: { id: string }[] }>().rows ?? [])
      .not.toContainEqual(expect.objectContaining({ id: evidence.id }));
    const publicFeed = await db.query('SELECT event_id FROM conversation_feed WHERE event_id = $1',
      [evidence.id]);
    expect.soft(publicFeed.rows).toEqual([]);
    let socket = await connect(0);
    try {
      const closeCodes: number[] = [];
      function recordClose(code: number) {
        closeCodes.push(code);
      }
      function isReady(message: (typeof received)[number]) {
        return message.type === 'ready';
      }
      function hasReplyOrClose() {
        return received.some(isReady) || closeCodes.length > 0;
      }
      socket.once('close', recordClose);
      await until(hasReplyOrClose);
      expect(closeCodes).toEqual([]);
      expect(received.some(isReady)).toBe(true);
      function isEvidenceMessage(message: (typeof received)[number]) {
        return message.type === 'event' && message.row?.id === evidence.id;
      }
      expect(received.some(isEvidenceMessage)).toBe(false);
      const contentQueriesAfterFirstRead = contentQueries;
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(contentQueries).toBe(contentQueriesAfterFirstRead);
      const liveMessageId = randomUUID();
      await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`,
        headers: headers(), payload: { id: liveMessageId, text: 'Arrives while connected' } });
      await runner.run(conversations);
      await until(() => received.some(r => r.type === 'event' && r.row?.id === liveMessageId));
      const computerReady = envelope('test', 'computer-assistant', 'computer.ready', {
        assistantId: 'assistant', computerId: 'computer', generation: 1,
      });
      const readySequence = (await history(nats.store, 'computer-assistant', 'test')).at(-1)!.sequence;
      expect((await nats.store.append({ event: computerReady, expectedSequence: readySequence })).status)
        .toBe('appended');
      await runner.run(computers);
      await until(() => received.some(r => r.type === 'ready' && r.computerState === 'ready'));
      const cursor = received.at(-1)!; socket.terminate(); await once(socket, 'close'); received.length = 0;
      const id = randomUUID();
      await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/messages`, headers: headers(), payload: { id, text: 'Posted offline' } });
      await runner.run(conversations); socket = await connect(cursor.position, cursor.generation);
      await until(() => received.some(r => r.type === 'ready'));
      expect(received.filter(r => r.type === 'event').map(r => r.row?.id)).toEqual([id]);
      socket.terminate(); await once(socket, 'close'); received.length = 0;
      await runner.rebuild(conversations);
      const rebuiltFeed = await db.query('SELECT event_id FROM conversation_feed WHERE event_id = $1',
        [evidence.id]);
      expect(rebuiltFeed.rows).toEqual([]);
      socket = await connect(cursor.position, cursor.generation);
      await until(() => received.some(r => r.type === 'resync'));
      expect(received[0]).toMatchObject({ type: 'resync', position: 0, generation: cursor.generation + 1 });
    } finally { socket.terminate(); await new Promise<void>(resolve => wss.close(() => resolve())); }

  } finally { await app.close(); await feed.close(); await nats.close(); await dbs.close(); await fga.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
