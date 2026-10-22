import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { encodeSession } from '@opencrane/auth';
import { until } from '@opencrane/authz/testing';
import { BudgetActor } from '@opencrane/models';
import { conversations } from '@opencrane/projections';
import { chatFeedSchema, chatMessageSchema } from '@opencrane/protocol';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { bridgeChannel } from '../../computer/test/server.ts';
import { history } from '../../ops/test/server.ts';
import { connectBridge } from '../src/chat/bridge.ts';
import { reportPosition } from '../src/chat/reports.ts';
import { attachWebSocketServer } from '../src/websocket.ts';
import { viewFixture } from './support/view-fixture.ts';

function noDesktop(): Promise<never> {
  return Promise.reject(new Error('No desktop is needed'));
}

async function prepareTeam(view: Awaited<ReturnType<typeof viewFixture>>) {
  const team = { teamId: 'team', name: 'Team', createdBy: 'alice' };
  await view.append('team-team', 'team.created', team, true);
  const member = { teamId: 'team', memberId: 'alice', addedBy: 'alice' };
  await view.append('team-team', 'team.member_added', member, true);
  const assistant = { assistantId: 'shared', ownerId: 'team', kind: 'team',
    payingGroupId: 'team' };
  await view.append('assistant-shared', 'assistant.created', assistant, true);
  const computer = { assistantId: 'shared', computerId: 'computer', generation: 1 };
  await view.append('computer-shared', 'computer.claimed', { ...computer, tokenId: 'token:test' });
  await view.append('computer-shared', 'computer.ready', computer);
  const conversation = { conversationId: 'private', assistantId: 'shared',
    createdBy: 'alice', mode: 'agent_session', payingGroupId: 'team' };
  await view.append('conversation-private', 'conversation.created', conversation, true);
  view.keys.provision('test', 'private');
  const content = view.keys.encrypt('test', 'private', 'Please continue');
  const message = { conversationId: 'private', authorId: 'alice', authorKind: 'human',
    contentType: 'text', ...content };
  return view.append('conversation-private', 'message.posted', message);
}

async function recoversNoticeAfterComputerRestart() {
  const view = await viewFixture(noDesktop);
  const directory = await mkdtemp(`${tmpdir()}/budget-restart-`);
  const server = createServer();
  const privateClosed = Promise.withResolvers<void>();
  function rpc(method: string) {
    if (method !== 'thread/start') throw new Error('Refused work must never execute');
    const thread = { id: 'private-thread', ephemeral: true, path: null, environments: [] };
    return Promise.resolve({ thread });
  }
  function closePrivate() {
    privateClosed.resolve();
  }
  function privateSession() {
    return Promise.resolve({ rpc, close: closePrivate, closed: privateClosed.promise });
  }
  function credential() {
    return { value: 'computer-pass', expiresAt: Date.now() + 60_000 };
  }
  const grants: string[] = [];
  function grant(_thread: string, _conversation: string, token: string) {
    if (token) grants.push(token);
    return Promise.resolve();
  }
  const driver = { rpc, privateSession, credential, grant, journal: `${directory}/reports` };
  let channel = bridgeChannel(server, driver);
  let link: Awaited<ReturnType<typeof connectBridge>> | undefined;
  let memberSocket: WebSocket | undefined;
  let sockets: ReturnType<typeof attachWebSocketServer> | undefined;
  try {
    const actor = new BudgetActor(view.nats.store, 'test');
    await actor.start(2000, 20000, 'team');
    const ceiling = { scope: 'paying_group' as const, scopeId: 'team',
      ceilingCents: 0, setBy: 'alice' };
    await actor.configure(ceiling);
    const message = await prepareTeam(view);
    await view.runner.run(conversations);
    const session = { sub: 'alice', orgId: 'org-test', roles: [], authTime: 0,
      exp: Math.floor(Date.now() / 1000) + 3600 };
    const headers = { cookie: `${view.config.cookieName}=${encodeSession(view.config, session)}`,
      origin: new URL(view.config.redirectUri).origin };
    const options = { silo: 'test', store: view.nats.store, keys: view.keys,
      db: view.db, binding: view.binding, feed: view.feed };
    const realtime = { feed: view.feed, binding: view.binding, chat: options };
    sockets = attachWebSocketServer(view.app.server, view.app.log, view.config, realtime);
    const address = await view.app.listen({ host: '127.0.0.1', port: 0 });
    const received: z.infer<typeof chatMessageSchema>[] = [];
    function receive(raw: Buffer) {
      received.push(chatMessageSchema.parse(JSON.parse(raw.toString())));
    }
    memberSocket = new WebSocket(`${address.replace('http:', 'ws:')}/ws`, { headers });
    memberSocket.on('message', receive);
    await once(memberSocket, 'open');
    const subscribe = { type: 'subscribe', topic: 'conversation',
      conversationId: 'private', since: 0 };
    memberSocket.send(JSON.stringify(subscribe));
    function isReady(message: typeof received[number]) {
      return message.type === 'ready';
    }
    function memberReady() {
      return received.some(isReady);
    }
    await until(memberReady, 3000);

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const computerAddress = server.address();
    if (!computerAddress || typeof computerAddress === 'string') throw new Error('No port');
    const input = { computerId: 'computer', assistantId: 'shared', bearer: 'computer-pass',
      url: `ws://127.0.0.1:${computerAddress.port}/bridge` };
    const append = view.nats.store.append.bind(view.nats.store);
    async function failDecision(command: Parameters<typeof append>[0]) {
      const event = z.object({ type: z.string() }).parse(command.event);
      if (event.type === 'decision.recorded') throw new Error('Decision save unavailable');
      return append(command);
    }
    const writes = vi.spyOn(view.nats.store, 'append');
    writes.mockImplementation(failDecision);
    link = await connectBridge(options, input);
    const closed = once(link.socket, 'close');
    const turn = { type: 'turn', id: message.id, conversationId: 'private',
      assistantId: 'shared', requesterId: 'alice', executionMode: 'restricted',
      text: 'Please continue', token: 'preparing', expiresAt: Date.now() + 60_000 };
    link.socket.send(JSON.stringify(turn));
    const closure: unknown[] = await closed;
    expect(closure[0]).toBe(1011);
    await link.settled();
    expect(await reportPosition(view.nats.store, 'test', 'computer')).toBe(1);
    expect(await history(view.nats.store, 'decision-*')).toEqual([]);
    const lifecycle = await history(view.nats.store, 'computer-shared');
    const savedStopId: unknown = expect.any(String);
    expect(lifecycle.at(-1)?.event).toMatchObject({ type: 'computer.turn_closed', data: {
      turnId: message.id, status: 'failed', budgetStopId: savedStopId,
    } });

    await channel.close();
    channel = bridgeChannel(server, driver);
    writes.mockRestore();
    await actor.configure({ ...ceiling, ceilingCents: 20000 });
    link = await connectBridge(options, input);
    async function terminalSaved() {
      return await reportPosition(view.nats.store, 'test', 'computer') === 2;
    }
    await until(terminalSaved, 3000);
    await link.settled();
    const reports = await history(view.nats.store, 'conversation-private');
    function isReport(row: typeof reports[number]) {
      return row.event.report !== undefined;
    }
    function reportType(row: typeof reports[number]) {
      return row.event.type;
    }
    const savedReports = reports.filter(isReport);
    expect(savedReports.map(reportType)).toEqual(['agent.turn_started', 'agent.turn_failed']);
    const decisions = await history(view.nats.store, 'decision-*');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.event.data).toMatchObject({ conversationId: 'private',
      turnId: message.id, requesterId: 'alice', assistantId: 'shared',
      route: 'model', outcome: 'deny', reason: 'budget_exhausted' });
    await view.runner.run(conversations);
    function isNotice(message: typeof received[number]) {
      return message.type === 'event' && message.row?.type === 'decision.recorded';
    }
    function noticeArrived() {
      return received.some(isNotice);
    }
    await until(noticeArrived, 3000);
    const notices = received.filter(isNotice);
    expect(notices).toMatchObject([{ row: { id: decisions[0]!.event.id,
      data: { turnId: message.id, reason: 'budget_exhausted' } } }]);
    const request = { url: '/api/conversations/private/messages', headers };
    const reload = await view.app.inject(request);
    expect(reload.statusCode).toBe(200);
    const feed = chatFeedSchema.parse(reload.json());
    function isSavedNotice(row: typeof feed.rows[number]) {
      return row.type === 'decision.recorded';
    }
    expect(feed.rows.filter(isSavedNotice)).toMatchObject([{ id: decisions[0]!.event.id,
      data: { turnId: message.id, reason: 'budget_exhausted' } }]);

    link.socket.terminate();
    await once(link.socket, 'close');
    await link.settled();
    await channel.close();
    channel = bridgeChannel(server, driver);
    link = await connectBridge(options, input);
    const pong = once(link.socket, 'pong');
    link.socket.ping();
    await pong;
    await link.settled();
    expect(await history(view.nats.store, 'decision-*')).toEqual(decisions);
    expect(await history(view.nats.store, 'computer-shared')).toEqual(lifecycle);
    const budget = await history(view.nats.store, 'budget-test');
    function isReservation(row: typeof budget[number]) {
      return row.event.type === 'budget.reserved';
    }
    expect(budget.filter(isReservation)).toEqual([]);
    expect(grants).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    memberSocket?.terminate();
    sockets?.close();
    link?.socket.terminate();
    await link?.settled();
    await channel.close();
    server.close();
    await view.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it('recovers the budget notice after a restricted computer restarts with a failed decision save',
  recoversNoticeAfterComputerRestart);
