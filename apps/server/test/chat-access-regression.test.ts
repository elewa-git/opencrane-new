// Regression probes for turn activity during reads and long agent sessions.
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
import { encodeSession } from '@opencrane/auth';
import { createStore, memberAuthorisation, grantStream } from '@opencrane/authz';
import { databases, openfga, until } from '@opencrane/authz/testing';
import { natsFixture } from '@opencrane/event-store/testing';
import { wireSubject } from '@opencrane/event-store';
import {
  members, computers, conversations, files, pgDb, ProjectionRunner, connectMemberFeed,
} from '@opencrane/projections';
import { createLogger } from '@opencrane/observability';
import { envelope } from '@opencrane/models';
import { chatMessageSchema } from '@opencrane/protocol';
import type { ChatOptions } from '../src/chat/routes.ts';
import { buildServer } from '../src/server.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { Client } from 'minio/dist/esm/minio.mjs';
import { ownConversation, fileCommand } from '../src/files/commands.ts';
import { viewAccess } from '../src/computers/view-access.ts';
import { chatCommand } from '../src/chat/commands.ts';
import { testAuthConfig } from './support/test-auth-config.ts';
import { conversationParticipationReader } from '../src/chat/access.ts';

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
  const objects = new Client({ endPoint: '127.0.0.1' });
  function unusedScan(): Promise<'clean'> {
    throw new Error('Reads must not scan a file');
  }
  const app = buildServer(config, { chat: options, files: { ...options, objects, scan: unusedScan } });
  async function append(subject: string, type: string, data: unknown, iam = true) {
    const event = envelope('test', subject, type, data);
    let actorId = 'alice';
    if (type === 'member.joined') actorId = subject.slice('member-'.length);
    event.principal = { id: actorId, kind: 'human' };
    // Seed saved history, including old participant subjects that commands now refuse.
    const savedHistory = [event];
    await nats.seed(savedHistory);
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
  for (const projection of [members, conversations, computers, files]) {
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

const removalsAfterPermission = [
  { subject: 'member-alice', type: 'member.removed',
    data: { memberId: 'alice', removedBy: 'bob' }, message: 'Active silo membership required' },
  { subject: 'participation-agent', type: 'participant.removed',
    data: { conversationId: 'agent', participantId: 'alice', removedBy: 'bob' },
    message: 'Conversation refused' },
];

async function refusesRemovalAfterPermission(testCase: (typeof removalsAfterPermission)[number]) {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    const read = conversationParticipationReader(context.options, 'alice');
    await read('agent');
    const head = context.nats.store.head.bind(context.nats.store);
    let positionReads = 0;
    async function removeBeforeFinalPosition(subject?: string, deadline?: number) {
      if (subject === testCase.subject) {
        positionReads++;
        if (positionReads === 2) {
          // Save the removal after OpenFGA replies, without updating its old permission.
          await context.append(testCase.subject, testCase.type, testCase.data, false);
        }
      }
      return head(subject, deadline);
    }
    const positions = vi.spyOn(context.nats.store, 'head');
    positions.mockImplementation(removeBeforeFinalPosition);
    try {
      const started = performance.now();
      await expect(read('agent')).rejects.toThrow(testCase.message);
      expect(positionReads).toBe(2);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      positions.mockRestore();
    }
  } finally {
    await context.close();
  }
}
it.each(removalsAfterPermission)(
  'refuses $type after IAM replies when a list reader reuses checked membership',
  refusesRemovalAfterPermission, 30_000);

async function openChatSocket(context: Fixture, conversationId: string, waitReady = true, memberId = 'alice') {
  const received: Array<ReturnType<typeof chatMessageSchema.parse>> = [];
  const address = await context.app.listen({ host: '127.0.0.1', port: 0 });
  const realtime = { feed: context.feed, binding: context.options.binding,
    chat: context.options };
  const wss = attachWebSocketServer(context.app.server, context.app.log, context.config, realtime);
  const connectionOptions = { headers: context.headers(memberId) };
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, connectionOptions);
  function receive(raw: Buffer) {
    received.push(chatMessageSchema.parse(JSON.parse(raw.toString()) as unknown));
  }
  socket.on('message', receive);
  let code: number | undefined;
  function rememberClose(value: number) { code = value; }
  socket.on('close', rememberClose);
  function closeCode() { return code; }
  await once(socket, 'open');
  const subscription = { type: 'subscribe', topic: 'conversation', conversationId, since: 0 };
  socket.send(JSON.stringify(subscription));
  function ready() {
    return received.some(isReady);
  }
  if (waitReady) await until(ready);
  async function close() {
    socket.terminate();
    function closeServer(resolve: () => void) {
      wss.close(resolve);
    }
    await new Promise<void>(closeServer);
  }
  return { socket, received, close, closeCode };
}

async function readsApprovalsDuringToolProgress(type: string) {
  const context = await fixture();
  const originalRead = context.options.store.readStream.bind(context.options.store);
  let injected = false;
  async function* appendAfterMemberRead(...args: Parameters<typeof originalRead>) {
    yield* originalRead(...args);
    if (args[0] !== 'member-alice' || injected) return;
    injected = true;
    const data: Record<string, unknown> = { conversationId: 'tool-chat',
      turnId: 'tool-chat-turn', callId: 'call_1', serverId: 'fixture', toolName: 'write' };
    if (type === 'agent.tool_call_finished') data['status'] = 'completed';
    await context.append('conversation-tool-chat', type, data, false);
  }
  try {
    await context.agentSession('tool-chat');
    context.options.store.readStream = appendAfterMemberRead;
    const request = { url: '/api/conversations/tool-chat/approvals', headers: context.headers() };
    const response = await context.app.inject(request);
    expect(injected).toBe(true);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ cards: [] });
  } finally {
    context.options.store.readStream = originalRead;
    await context.close();
  }
}
it.each(['agent.tool_call_started', 'agent.tool_call_finished'])(
  'keeps approval reads available when %s arrives during the access check',
  readsApprovalsDuringToolProgress, 120_000);

async function openTeamAssistantChat(context: Fixture, conversationId: string) {
  await context.append('team-sales', 'team.created', {
    teamId: 'sales', name: 'Sales', createdBy: 'alice',
  });
  await context.append('team-sales', 'team.member_added', {
    teamId: 'sales', memberId: 'alice', addedBy: 'alice',
  });
  await context.append('assistant-shared', 'assistant.created', {
    assistantId: 'shared', kind: 'team', ownerId: 'sales', payingGroupId: 'sales',
  });
  context.keys.provision('test', conversationId);
  await context.append(`conversation-${conversationId}`, 'conversation.created', {
    conversationId, createdBy: 'alice', mode: 'agent_session',
    assistantId: 'shared', payingGroupId: 'sales',
  });
  await context.runner.run(conversations);
  return openChatSocket(context, conversationId);
}

function countStoreReads(context: Fixture) {
  const originalReadStream = context.options.store.readStream.bind(context.options.store);
  const originalHead = context.options.store.head.bind(context.options.store);
  const counts = { readStream: 0, head: 0 };
  async function* readStream(subject: string, fromSequence?: number, deadline?: number) {
    counts.readStream++;
    yield* originalReadStream(subject, fromSequence, deadline);
  }
  async function head(subject?: string, deadline?: number) {
    counts.head++;
    return originalHead(subject, deadline);
  }
  context.options.store.readStream = readStream;
  context.options.store.head = head;
  return counts;
}

it('refuses participant changes on a direct chat', directChatRejectsParticipants, 120_000);

async function directChatRejectsParticipants() {
  const context = await fixture();
  try {
    context.keys.provision('test', 'direct');
    await context.append('conversation-direct', 'conversation.created', {
      conversationId: 'direct', createdBy: 'alice', mode: 'direct',
      participantIds: ['alice', 'bob'],
    });
    await context.runner.run(conversations);
    await context.append('conversation-direct', 'participant.removed', {
      conversationId: 'direct', participantId: 'alice', removedBy: 'bob',
    }, false);
    await expect(context.runner.run(conversations)).rejects.toThrow(
      'Direct conversation is immutable');
  } finally {
    await context.close();
  }
}

it('does not read conversation streams while a direct chat socket is idle',
  idleDirectChatSocket, 120_000);

async function idleDirectChatSocket() {
  const context = await fixture(true);
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    context.keys.provision('test', 'direct-idle');
    await context.append('conversation-direct-idle', 'conversation.created', {
      conversationId: 'direct-idle', createdBy: 'alice', mode: 'direct',
      participantIds: ['alice', 'bob'],
    });
    await context.runner.run(conversations);
    client = await openChatSocket(context, 'direct-idle');
    const storeReads = countStoreReads(context);
    await delay(2000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(storeReads.readStream).toBe(0);
    expect(storeReads.head).toBeLessThanOrEqual(50);
  } finally {
    await client?.close();
    await context.close();
  }
}

it('keeps a team chat idle without OpenFGA calls and closes it when team access is removed',
  teamSocketAccessChanges, 120_000);

it('reconnects when OpenFGA does not apply a later team chat change',
  teamSocketReconnectsForUnappliedChange, 120_000);

async function teamSocketReconnectsForUnappliedChange() {
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
    context.keys.provision('test', 'team-chat-timeout');
    await context.append('conversation-team-chat-timeout', 'conversation.created', {
      conversationId: 'team-chat-timeout', createdBy: 'alice', mode: 'agent_session',
      assistantId: 'shared', payingGroupId: 'sales',
    });
    await context.runner.run(conversations);
    client = await openChatSocket(context, 'team-chat-timeout');

    await context.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob',
    }, false);

    const closed = once(client.socket, 'close');
    const closure: unknown[] = await Promise.race([
      closed,
      delay(6500).then(expireUnappliedChange),
    ]);
    expect(closure[0]).toBe(1013);
  } finally {
    await client?.close();
    await context.close();
  }
}

function expireUnappliedChange(): never {
  throw new Error('Socket did not reconnect after OpenFGA left a change unapplied');
}

it('closes for silo removal while a role change is still being applied',
  closesForMemberRemovalDuringApply, 120_000);

async function closesForMemberRemovalDuringApply() {
  const context = await fixture(true);
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    client = await openTeamAssistantChat(context, 'member-remove-during-apply');
    await context.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob',
    }, false);
    const closed = once(client.socket, 'close');
    const started = performance.now();
    await context.append('member-alice', 'member.removed', {
      memberId: 'alice', removedBy: 'bob',
    }, false);
    const closure = await Promise.race([
      closed,
      delay(2000).then(expireRemovalCheck),
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
  } finally {
    await client?.close();
    await context.close();
  }
}

it('closes for team removal while a role change is still being applied',
  closesForTeamRemovalDuringApply, 120_000);

async function closesForTeamRemovalDuringApply() {
  const context = await fixture(true);
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    client = await openTeamAssistantChat(context, 'team-remove-during-apply');
    await context.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob',
    }, false);
    const closed = once(client.socket, 'close');
    const started = performance.now();
    await context.append('team-sales', 'team.member_removed', {
      teamId: 'sales', memberId: 'alice', removedBy: 'bob',
    }, false);
    const closure = await Promise.race([
      closed,
      delay(2000).then(expireRemovalCheck),
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
  } finally {
    await client?.close();
    await context.close();
  }
}

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
    const storeReads = countStoreReads(context);
    await delay(2000);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks);
    expect(storeReads.readStream).toBe(0);
    expect(storeReads.head).toBeLessThanOrEqual(70);
    const roleChange = await context.append('member-alice', 'member.role_changed', {
      memberId: 'alice', previousRole: 'member', newRole: 'admin', changedBy: 'bob',
    }, false);
    await delay(300);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    await context.auth.handler.handle(roleChange, context.db);
    const encrypted = context.keys.encrypt('test', 'team-chat', 'After access catches up');
    await context.append('conversation-team-chat', 'message.posted', {
      conversationId: 'team-chat', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...encrypted,
    }, false);
    await context.runner.run(conversations);
    function deliveredAfterApply() {
      return client!.received.some(hasRecoveredMessage);
    }
    await until(deliveredAfterApply);
    const checksAfterDelivery = context.fgaProxy!.checkCount();
    await delay(500);
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(checksAfterDelivery);
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
    expect(initialChecks - checksBeforeSubscription).toBe(3);
    const storeReads = countStoreReads(context);
    await delay(2000);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount() - initialChecks).toBe(0);
    expect(storeReads.readStream).toBe(0);
    expect(storeReads.head).toBeLessThanOrEqual(50);

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
      return context.fgaProxy!.checkCount() >= initialChecks + 3;
    }
    await until(accessRechecked);
    await delay(300);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks + 3);

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
    expect(context.fgaProxy!.checkCount()).toBe(initialChecks + 3);
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

it('catches a member removal written after the access positions were read',
  removalDuringAccessCheck, 120_000);

async function removalDuringAccessCheck() {
  const context = await fixture();
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    await context.agentSession('injected-removal');
    client = await openChatSocket(context, 'injected-removal');
    const realHead = context.options.store.head.bind(context.options.store);
    let armed = true;
    const injected = Promise.withResolvers<void>();
    async function head(subject?: string, deadline?: number) {
      const position = await realHead(subject, deadline);
      if (armed && subject === 'member-alice') {
        armed = false;
        await context.append('member-alice', 'member.removed', {
          memberId: 'alice', removedBy: 'bob',
        }, false);
        injected.resolve();
      }
      return position;
    }
    context.options.store.head = head;
    const closed = once(client.socket, 'close');
    const started = performance.now();
    await injected.promise;
    const closure = await Promise.race([
      closed,
      delay(2000).then(expireRemovalCheck),
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(closure[0]).toBe(1008);
  } finally {
    await client?.close();
    await context.close();
  }
}

function expireRemovalCheck(): never {
  throw new Error('Member removal during the access check did not close the socket');
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

function hasRecoveredMessage(message: ReturnType<typeof chatMessageSchema.parse>) {
  return message.type === 'event' && message.row?.data.text === 'After access catches up';
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


it.each([false, true])('refuses a participation removal before IAM applies (blocked: %s)',
  participationRemoval, 120_000);

async function participationRemoval(blocked: boolean) {
  const context = await fixture();
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await context.agentSession('agent');
    if (blocked) {
      client = await openChatSocket(context, 'agent');
      pause = pauseFirstHistoryRead(context);
      const encrypted = context.keys.encrypt('test', 'agent', 'Never deliver this');
      await context.append('conversation-agent', 'message.posted', {
        conversationId: 'agent', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted,
      }, false);
      await context.runner.run(conversations);
      await pause.reached;
    }
    const started = performance.now();
    await context.append('participation-agent', 'participant.removed', {
      conversationId: 'agent', participantId: 'alice', removedBy: 'bob',
    }, false);
    if (!client) {
      // Subscribe after the append while the old permission still allows this person.
      client = await openChatSocket(context, 'agent', false);
    }
    function closed() {
      return client?.socket.readyState === WebSocket.CLOSED;
    }
    await until(closed, 1900);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(client.closeCode()).toBe(1008);
    expect(client.received.some(isRefused)).toBe(true);
    expect(JSON.stringify(client.received)).not.toContain('Never deliver this');
  } finally {
    pause?.release();
    await client?.close();
    await context.close();
  }
}

it('limits late joins and re-joins to their latest interval, including titles and people',
  lateParticipantHistory, 120_000);

async function lateParticipantHistory() {
  const context = await fixture();
  try {
    context.keys.provision('test', 'group');
    const creation = await context.append('conversation-group', 'conversation.created', {
      conversationId: 'group', mode: 'group', createdBy: 'alice',
      participantIds: ['alice', 'hidden-person'],
    });
    async function message(text: string) {
      const encrypted = context.keys.encrypt('test', 'group', text);
      await context.append('conversation-group', 'message.posted', {
        conversationId: 'group', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted,
      }, false);
    }
    await message('Secret original title');
    await context.append('participation-group', 'participant.removed', {
      conversationId: 'group', participantId: 'hidden-person', removedBy: 'alice',
    });
    await context.append('conversation-group', 'participant.added', {
      conversationId: 'group', participantId: 'bob', addedBy: 'alice',
    });
    await message('Old interval');
    await context.append('participation-group', 'participant.removed', {
      conversationId: 'group', participantId: 'bob', removedBy: 'alice',
    });
    const join = await context.append('participation-group', 'participant.added', {
      conversationId: 'group', participantId: 'bob', addedBy: 'alice',
    }, false);
    await context.runner.run(conversations);
    const request = { url: '/api/conversations/group/messages', headers: context.headers('bob') };
    expect((await context.app.inject(request)).statusCode).toBe(425);
    await context.auth.handler.handle(join, context.db);
    await message('Visible first message');
    await context.append('participation-group', 'participant.added', {
      conversationId: 'group', participantId: 'bob', addedBy: 'alice',
    }, false);
    await context.runner.run(conversations);
    const response = await context.app.inject(request);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain('Visible first message');
    expect(response.body).not.toMatch(/Secret original title|Old interval|hidden-person/);
    const oldStatus = { url: `/api/conversations/group/changes/${creation.id}`,
      headers: context.headers('bob') };
    expect((await context.app.inject(oldStatus)).statusCode).toBe(404);
    const list = await context.app.inject({ url: '/api/conversations',
      headers: context.headers('bob') });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).toContain('visible-first-message');
    expect(list.body).not.toMatch(/Secret original title|hidden-person/);
    const posting = { method: 'POST' as const, url: '/api/conversations/group/messages',
      headers: context.headers('bob'), payload: { id: 'group-post', text: 'Hello from the new interval' } };
    expect((await context.app.inject(posting)).statusCode).toBe(200);
  } finally {
    await context.close();
  }
}

it('refuses approvals, file commands and live view on an unapplied participant removal',
  removedParticipantReaders, 120_000);

async function removedParticipantReaders() {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    await expect(ownConversation(context.nats.store, 'test', 'agent', 'alice', true))
      .resolves.toBeDefined();
    await context.append('computer-assistant', 'computer.claimed', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, tokenId: 'token:test',
    }, false);
    await context.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'fixture',
    }, false);
    await context.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'alice',
    });
    await expect(viewAccess(context.options, 'alice', 'agent')).resolves.toMatchObject({
      computerId: 'desktop',
    });
    await context.append('participation-agent', 'participant.removed', {
      conversationId: 'agent', participantId: 'alice', removedBy: 'bob',
    }, false);
    const approvals = await context.app.inject({ url: '/api/conversations/agent/approvals',
      headers: context.headers() });
    expect(approvals.statusCode, approvals.body).toBe(403);
    await expect(ownConversation(context.nats.store, 'test', 'agent', 'alice', true))
      .rejects.toMatchObject({ kind: 'conversation_refused' });
    const file = { conversationId: 'agent', fileId: 'not-saved', uploadedBy: 'alice',
      name: 'notes.txt', size: 5, sha256: 'a'.repeat(64), mime: 'text/plain',
      objectKey: 'test/agent/not-saved' };
    const before = await context.nats.store.head('conversation-agent');
    const writing = fileCommand(context.nats.store, 'test', 'alice', 'file-command',
      'file.uploaded', file);
    await expect(writing).rejects.toMatchObject({ kind: 'conversation_refused' });
    expect(await context.nats.store.head('conversation-agent')).toBe(before);
    await expect(viewAccess(context.options, 'alice', 'agent')).rejects.toThrow();
  } finally {
    await context.close();
  }
}


it('keeps reads and access checks bounded with 100,000 messages and a busy conversation',
  participationVolume, 600_000);

async function participationVolume() {
  const context = await fixture();
  let stopped = false;
  let streaming: Promise<void> | undefined;
  try {
    await context.agentSession('volume');
    await context.append('computer-assistant', 'computer.claimed', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, tokenId: 'token:test',
    }, false);
    await context.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'fixture',
    }, false);
    await context.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'alice',
    });
    const encrypted = context.keys.encrypt('test', 'volume', 'Saved history');
    const previousHead = await context.nats.store.head();
    for (let offset = 0; offset < 100_000; offset += 100) {
      const batch = [];
      for (let index = offset; index < offset + 100; index++) {
        const data = { conversationId: 'volume', authorId: 'alice', authorKind: 'human',
          contentType: 'text', ...encrypted };
        batch.push(envelope('test', 'conversation-volume', 'message.posted', data,
          `volume-${index}`));
      }
      await context.nats.seed(batch);
    }
    expect(await context.nats.store.head()).toBe(previousHead + 100_000);
    const savedMessage = { conversationId: 'volume', authorId: 'alice', authorKind: 'human',
      contentType: 'text', ...encrypted };
    // Seed the matching read table in one batch so this measures reads, not replay speed.
    await context.db.query(`INSERT INTO conversation_feed
      SELECT 'test', 'volume', $1::bigint + position, 'volume-' || (position - 1)::text,
        'message.posted', $2::jsonb, '2026-10-01T00:00:00Z'
      FROM generate_series(1, 100000) AS fixture(position)`,
    [previousHead, JSON.stringify(savedMessage)]);
    const checkpointSql = "UPDATE projection_checkpoints SET sequence = $1" +
      " WHERE name = 'conversations'";
    await context.db.query(checkpointSql,
      [previousHead + 100_000]);
    async function stream() {
      while (!stopped) {
        await context.append('conversation-volume', 'agent.turn_started', {
          conversationId: 'volume', turnId: 'busy-turn', assistantId: 'assistant',
        }, false);
        await delay(20);
      }
    }
    streaming = stream();
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      const response = await context.app.inject({
        url: '/api/conversations/volume/messages', headers: context.headers(),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain('Hello');
      expect(performance.now() - started).toBeLessThan(1500);
      await expect(viewAccess(context.options, 'alice', 'volume')).resolves.toMatchObject({
        computerId: 'desktop',
      });
      const fileRead = { url: '/api/conversations/volume/files', headers: context.headers() };
      const fileResponse = await context.app.inject(fileRead);
      expect(fileResponse.statusCode, fileResponse.body).toBe(200);
    }
  } finally {
    stopped = true;
    await streaming;
    await context.close();
  }
}

async function refusesCloseBeforeBufferedReport() {
  const context = await fixture();
  try {
    await context.agentSession('agent');
    await context.append('computer-assistant', 'computer.claimed', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, tokenId: 'token:test',
    }, false);
    await context.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'desktop', generation: 1, podUid: 'fixture',
    }, false);
    await context.append(grantStream('shared_desktop', 'desktop'), 'grant.given', {
      resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
      granteeKind: 'member', grantedBy: 'alice',
    });
    await context.runner.run(conversations);
    await context.append('conversation-agent', 'conversation.closed', {
      conversationId: 'agent', closedBy: 'alice',
    }, false);
    await context.append('conversation-agent', 'agent.turn_completed', {
      conversationId: 'agent', turnId: 'agent-turn',
    }, false);
    const response = await context.app.inject({ url: '/api/conversations/agent/files',
      headers: context.headers() });
    expect.soft(response.statusCode, response.body).toBe(403);
    await expect(viewAccess(context.options, 'alice', 'agent')).rejects.toThrow();
  } finally {
    await context.close();
  }
}
it('refuses files and desktop leases after an unprojected close followed by a report',
  refusesCloseBeforeBufferedReport, 120_000);

async function retainsVerifiedLegacyParticipation() {
  const context = await fixture();
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  try {
    await context.agentSession('agent');
    const legacy = await context.append('conversation-agent', 'participant.added', {
      conversationId: 'agent', participantId: 'bob', addedBy: 'alice',
    });
    for (let index = 0; index < 20; index++) {
      await context.append('participation-agent', 'participant.removed', {
        conversationId: 'agent', participantId: 'bob', removedBy: 'alice',
      }, false);
      await context.append('participation-agent', 'participant.added', {
        conversationId: 'agent', participantId: 'bob', addedBy: 'alice',
      }, false);
    }
    await context.runner.run(conversations);
    const read = vi.spyOn(context.nats.store, 'readEvent');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await context.app.inject({ url: '/api/conversations/agent/messages',
          headers: context.headers() });
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(read).toHaveBeenCalledTimes(1);
      const saved = await context.nats.store.readEvent(read.mock.calls[0]![0]);
      expect(saved.event.id).toBe(legacy.id);
      client = await openChatSocket(context, 'agent');
      const started = performance.now();
      await context.append('participation-agent', 'participant.removed', {
        conversationId: 'agent', participantId: 'alice', removedBy: 'bob',
      }, false);
      const response = await context.app.inject({ url: '/api/conversations/agent/messages',
        headers: context.headers() });
      expect(response.statusCode, response.body).toBe(403);
      function closed() {
        return client?.socket.readyState === WebSocket.CLOSED;
      }
      await until(closed, 1900);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(client.closeCode()).toBe(1008);
    } finally {
      read.mockRestore();
    }
  } finally {
    await client?.close();
    await context.close();
  }
}
it('checks legacy participation once and skips modern events during repeated churn reads',
  retainsVerifiedLegacyParticipation, 120_000);

async function createParticipantGroup(context: Fixture, participantIds = ['alice', 'bob']) {
  context.keys.provision('test', 'participants');
  await context.append('conversation-participants', 'conversation.created', {
    conversationId: 'participants', mode: 'group', createdBy: 'alice', participantIds,
  });
  await context.runner.run(conversations);
}

async function joinParticipantMember(context: Fixture, memberId: string) {
  await context.append(`member-${memberId}`, 'member.joined', {
    memberId, invitationId: `invite-${memberId}`, email: `${memberId}@example.test`,
    displayName: memberId, role: 'member',
  });
  await context.runner.run(members);
}

async function participantRequest(context: Fixture, payload?: unknown, memberId = 'alice') {
  const request = { method: payload ? 'POST' as const : 'GET' as const,
    url: '/api/conversations/participants/participants', headers: context.headers(memberId),
    ...(payload ? { payload } : {}) };
  return context.app.inject(request);
}

async function participantPosition(context: Fixture) {
  const response = await participantRequest(context);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ accessPosition: number }>().accessPosition;
}

async function managesGroupParticipants() {
  const context = await fixture();
  try {
    await createParticipantGroup(context);
    await joinParticipantMember(context, 'ext:jane');
    const expectedAccessPosition = await participantPosition(context);
    const add = { id: 'add-jane', action: 'add', participantId: 'ext:jane',
      expectedAccessPosition };
    const denied = await participantRequest(context, add, 'bob');
    expect(denied.statusCode).toBe(403);
    const creatorLeave = { id: 'creator-leave', action: 'leave', expectedAccessPosition };
    expect((await participantRequest(context, creatorLeave)).statusCode).toBe(403);
    const invalid = { ...add, expectedAccessPosition: undefined };
    expect((await participantRequest(context, invalid)).statusCode).toBe(400);
    const oversized = { ...add, id: 'a'.repeat(5000) };
    expect((await participantRequest(context, oversized)).statusCode).toBe(413);
    const added = await participantRequest(context, add);
    expect(added.statusCode, added.body).toBe(200);
    const saved = added.json<{ sequence: number }>();
    await context.runner.run(conversations);
    const statusRequest = { url: '/api/conversations/participants/changes/add-jane',
      headers: context.headers() };
    const applying = await context.app.inject(statusRequest);
    expect(applying.json()).toMatchObject({ projection: { iam: 'applying' } });
    const row = await context.nats.store.readEvent(saved.sequence);
    expect(row.event.subject).toBe('participation-participants');
    await context.auth.handler.handle(row.event, context.db);
    const current = await context.app.inject(statusRequest);
    expect(current.json()).toMatchObject({ projection: { iam: 'current' } });
    const people = await participantRequest(context, undefined, 'ext:jane');
    expect(people.json()).toMatchObject({ canManage: false, canLeave: true,
      joinPosition: saved.sequence, accessPosition: saved.sequence });
    expect(people.body).toContain('ext:jane');
    const remove = { id: 'remove-jane', action: 'remove', participantId: 'ext:jane',
      expectedAccessPosition: saved.sequence };
    await context.append('member-ext:jane', 'member.removed', {
      memberId: 'ext:jane', removedBy: 'alice',
    }, false);
    expect((await participantRequest(context, remove)).statusCode).toBe(200);
    const before = await context.nats.store.head('participation-participants');
    const retry = await participantRequest(context, add);
    expect(retry.json()).toMatchObject(saved);
    expect(await context.nats.store.head('participation-participants')).toBe(before);
    const changed = { ...add, participantId: 'bob' };
    expect((await participantRequest(context, changed)).statusCode).toBe(409);
    await context.append('conversation-participants', 'conversation.closed', {
      conversationId: 'participants', closedBy: 'alice',
    }, false);
    expect((await participantRequest(context, add)).statusCode).toBe(200);
    const newEdit = { id: 'closed-edit', action: 'remove', participantId: 'bob',
      expectedAccessPosition: before };
    expect((await participantRequest(context, newEdit)).statusCode).toBe(409);
    expect((await participantRequest(context, undefined, 'ext:jane')).statusCode).toBe(403);
  } finally {
    await context.close();
  }
}
it('checks creator rights, saved retries, departed targets, closure and IAM receipts',
  managesGroupParticipants, 120_000);

async function serialisesParticipantEdits() {
  const context = await fixture();
  try {
    await createParticipantGroup(context);
    await joinParticipantMember(context, 'carol');
    await joinParticipantMember(context, 'dave');
    const expectedAccessPosition = await participantPosition(context);
    const first = { id: 'add-carol', action: 'add', participantId: 'carol',
      expectedAccessPosition };
    const second = { id: 'add-dave', action: 'add', participantId: 'dave',
      expectedAccessPosition };
    const writes = [participantRequest(context, first), participantRequest(context, second)];
    const responses = await Promise.all(writes);
    function statusCode(response: typeof responses[number]) { return response.statusCode; }
    const codes = responses.map(statusCode);
    codes.sort();
    expect(codes).toEqual([200, 409]);
    expect((await participantRequest(context, first)).statusCode).toBe(responses[0]!.statusCode);
    const rows = [];
    for await (const row of context.nats.store.readStream('participation-participants')) {
      rows.push(row);
    }
    expect(rows).toHaveLength(1);
    const people = await participantRequest(context);
    expect(people.json()).toMatchObject({ canManage: true, canLeave: false });
    const invalidTarget = { id: 'absent', action: 'add', participantId: 'foreign',
      expectedAccessPosition: rows[0]!.sequence };
    expect((await participantRequest(context, invalidTarget)).statusCode).toBe(403);
  } finally {
    await context.close();
  }
}
it('allows one concurrent edit and refuses stale or foreign additions',
  serialisesParticipantEdits, 120_000);

async function capsGroupParticipants() {
  const context = await fixture();
  try {
    const participantIds = ['alice', 'bob'];
    for (let index = 0; index < 95; index++) participantIds.push(`person-${index}`);
    await createParticipantGroup(context, participantIds);
    const expectedAccessPosition = await participantPosition(context);
    const add = { id: 'too-many', action: 'add', participantId: 'carol',
      expectedAccessPosition };
    expect((await participantRequest(context, add)).statusCode).toBe(409);
    expect(await context.nats.store.head('participation-participants')).toBe(0);
  } finally {
    await context.close();
  }
}
it('refuses a 98th current participant', capsGroupParticipants, 120_000);

async function leavesGroupAndRevokesReaders(blocked: boolean) {
  const context = await fixture();
  let client: Awaited<ReturnType<typeof openChatSocket>> | undefined;
  let pause: ReturnType<typeof pauseFirstHistoryRead> | undefined;
  try {
    await createParticipantGroup(context);
    const expectedAccessPosition = await participantPosition(context);
    client = await openChatSocket(context, 'participants', true, 'bob');
    if (blocked) {
      pause = pauseFirstHistoryRead(context);
      const encrypted = context.keys.encrypt('test', 'participants', 'Never deliver this');
      await context.append('conversation-participants', 'message.posted', {
        conversationId: 'participants', authorId: 'alice', authorKind: 'human',
        contentType: 'text', ...encrypted,
      }, false);
      await context.runner.run(conversations);
      await pause.reached;
    }
    const leave = { id: 'leave-alice', action: 'remove', participantId: 'alice',
      expectedAccessPosition };
    expect((await participantRequest(context, leave, 'bob')).statusCode).toBe(403);
    const ownLeave = { id: 'leave-bob', action: 'leave', expectedAccessPosition };
    const started = performance.now();
    const closed = once(client.socket, 'close');
    const left = await participantRequest(context, ownLeave, 'bob');
    function socketClosed() { return client?.socket.readyState === WebSocket.CLOSED; }
    await until(socketClosed, 1900);
    await closed;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(client.closeCode()).toBe(1008);
    expect(left.statusCode, left.body).toBe(200);
    expect((await participantRequest(context, ownLeave, 'bob')).statusCode).toBe(403);
    // Keep the group readable with one person. Removal does not change its mode.
    expect((await participantRequest(context)).statusCode).toBe(200);
    for (const path of ['messages', 'files', 'approvals', 'changes/leave-bob', 'participants']) {
      const response = await context.app.inject({
        url: `/api/conversations/participants/${path}`, headers: context.headers('bob'),
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    const send = { method: 'POST' as const, url: '/api/conversations/participants/messages',
      headers: context.headers('bob'), payload: { id: 'removed-send', text: 'Forbidden' } };
    expect((await context.app.inject(send)).statusCode).toBe(403);
    await expect(viewAccess(context.options, 'bob', 'participants')).rejects.toThrow();
    expect(client.received.some(isRefused)).toBe(true);
    expect(JSON.stringify(client.received)).not.toContain('Never deliver this');
  } finally {
    pause?.release();
    await client?.close();
    await context.close();
  }
}
it.each([false, true])('revokes every read path after self-leave (blocked socket: %s)',
  leavesGroupAndRevokesReaders, 120_000);
