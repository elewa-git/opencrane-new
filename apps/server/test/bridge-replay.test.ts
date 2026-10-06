import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BudgetActor, envelope } from '@opencrane/models';
import { tokenIssuer } from '@opencrane/auth';
import { createLogger } from '@opencrane/observability';
import { conversations, pgDb, ProjectionRunner } from '@opencrane/projections';
import { SandboxClient } from '../../ops/src/kubernetes.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases, until } from '@opencrane/authz/testing';
import { connectBridge, watchBridges } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { reportPosition } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { history, suspendComputer } from '../../ops/src/lifecycle.ts';

async function bridgeTokens(fixture: { directory: string }) {
  const keyOptions = {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${fixture.directory}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const options = { privateKeyPath, issuer: 'https://bridge.test/' };
  return tokenIssuer(options);
}

async function replayFixture(conversationIds = ['alice', 'bob']) {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/bridge-replay-`);
  await new BudgetActor(nats.store, 'test').start(2000, 20000, 'personal-default');
  await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }) });
  const keys = conversationKeys(directory), server = createServer(), wss = new WebSocketServer({ server });
  const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
  for (const conversationId of conversationIds) {
    keys.provision('test', conversationId);
    await chatCommand(nats.store, keys, { silo: 'test', memberId: conversationId }, { id: `create-${conversationId}`, conversationId, assistantId: 'assistant' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: conversationId }, { id: `message-${conversationId}`, conversationId, text: 'Hello' });
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const messages: unknown[] = [];
  wss.on('connection', socket => socket.on('message', raw => messages.push(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as unknown)));
  return { ...nats, keys, context, messages, wss, directory, url: `http://127.0.0.1:${address.port}`,
    async connect() {
      const connected = new Promise<import('ws').WebSocket>(resolve => wss.once('connection', resolve));
      const link = await connectBridge({ silo: 'test', store: nats.store, keys }, { ...context, url: `ws://127.0.0.1:${address.port}`, bearer: 'test' });
      return { ...link, peer: await connected };
    },
    async close() {
      for (const socket of wss.clients) socket.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve())); server.close();
      await nats.close(); await rm(directory, { recursive: true, force: true });
    },
  };
}

it.each([true, false])('acknowledges completed-start duplicates and keeps other threads recovering (lifecycle closed: %s)', async closed => {
  const fixture = await replayFixture();
  const alice = { sequence: 1, previousSequence: 0, conversationId: 'alice', turnId: 'message-alice', assistantId: 'assistant', type: 'agent.message_delta', messageId: 'reply', text: 'Hello Alice' };
  const start = { sequence: 2, previousSequence: 0, conversationId: 'bob', turnId: 'message-bob', assistantId: 'assistant', type: 'agent.turn_started', threadId: 'thread-bob' };
  const completed = { ...start, sequence: 3, previousSequence: 2, type: 'agent.turn_completed' };
  let link: Awaited<ReturnType<typeof fixture.connect>> | undefined;
  try {
    await recordReport(fixture.store, fixture.keys, fixture.context, start);
    await recordReport(fixture.store, fixture.keys, fixture.context, completed);
    if (closed) await turnCommand(fixture.store, fixture.context, { ...completed, status: 'completed' });
    link = await fixture.connect();
    await until(() => fixture.messages.length > 0, 1000);
    expect(fixture.messages).toEqual([{ type: 'resume', since: 0 }]);
    for (const report of [alice, start, completed]) link.peer.send(JSON.stringify(report));
    await until(() => fixture.messages.length === 4 || link?.socket.readyState === 3, 2000);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
    expect(fixture.messages).toEqual(expect.arrayContaining([1, 2, 3].map(sequence => ({ type: 'ack', sequence }))));
    link.peer.send(JSON.stringify({ ...alice, sequence: 4, previousSequence: 1, text: 'Still recovering' }));
    await until(() => fixture.messages.length === 5, 1000);
    expect(fixture.messages.at(-1)).toEqual({ type: 'ack', sequence: 4 });
    const lifecycle = [];
    for await (const row of fixture.store.readStream('computer-assistant')) lifecycle.push(row);
    expect(lifecycle.map(row => row.event.type)).toEqual(['computer.turn_closed']);
    const bob = await chatHistory(fixture.store, 'test', 'bob');
    expect(bob.filter(row => row.event.report).map(row => row.event.report?.sequence)).toEqual([2, 3]);
    const refused = new Promise<{ code: number; reason: string }>(resolve => link!.peer.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    link.peer.send(JSON.stringify({ ...start, threadId: 'forged' }));
    expect(await refused).toEqual({ code: 1008, reason: 'Report sequence reused' });
    expect(fixture.messages).toHaveLength(5);
  } finally { link?.socket.terminate(); await link?.settled(); await fixture.close(); }
});

it('replays an older Alice/Bob journal in its global computer sequence', async () => {
  const fixture = await replayFixture(), directory = await mkdtemp(`${tmpdir()}/old-journal-`), server = createServer();
  const reports = ['alice', 'bob', 'alice', 'bob'].map((conversationId, index) => ({
    sequence: index + 1, conversationId, turnId: `message-${conversationId}`, assistantId: 'assistant',
    type: 'agent.message_delta', messageId: 'reply', text: `Report ${index + 1}`,
  }));
  await writeFile(`${directory}/reports`, reports.map(report => JSON.stringify(report)).join('\n') + '\n');
  const channel = bridgeChannel(server, { journal: `${directory}/reports`,
    credential: () => ({ value: 'test', expiresAt: Date.now() + 60_000 }),
    rpc: () => Promise.reject(new Error('Replay must not execute a turn')), grant: () => Promise.resolve(),
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connect = () => connectBridge({ silo: 'test', store: fixture.store, keys: fixture.keys },
    { ...fixture.context, url: `ws://127.0.0.1:${address.port}/bridge`, bearer: 'test' });
  let link = await connect();
  try {
    await until(async () => await reportPosition(fixture.store, 'test', 'computer') === 4 || link.socket.readyState === 3, 2000);
    expect(link.socket.readyState).toBe(link.socket.OPEN);
    expect(await reportPosition(fixture.store, 'test', 'computer')).toBe(4);
    link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
    link = await connect();
    for (const [conversationId, sequences] of [['alice', [1, 3]], ['bob', [2, 4]]] as const) {
      expect((await chatHistory(fixture.store, 'test', conversationId)).filter(row => row.event.report).map(row => row.event.report?.sequence)).toEqual(sequences);
    }
    expect(link.socket.readyState).toBe(link.socket.OPEN);
  } finally { link.socket.terminate(); await link.settled(); await channel.close(); server.close(); await fixture.close(); await rm(directory, { recursive: true, force: true }); }
});

it('reconnects after credential expiry and delivers the pending message once', async () => {
  const fixture = await replayFixture(['alice']), dbs = await databases(), stop = new AbortController(), server = createServer();
  const tokens = await bridgeTokens(fixture);
  const loggerLines: string[] = [];
  const logger = createLogger('bridge-expiry', { level: 'info', destination: { write: line => { loggerLines.push(line); } } });
  const db = pgDb(dbs.queue), runner = new ProjectionRunner(db, fixture.store, logger);
  await runner.initialise(conversations); await runner.run(conversations);
  let sequence = 0;
  for (const type of ['computer.claimed', 'computer.ready']) {
    const result = await fixture.store.append({ expectedSequence: sequence, event: { id: type, commandId: type, type,
      silo: 'test', subject: 'computer-assistant', source: 'test', principal: { kind: 'system', id: 'test' }, time: new Date().toISOString(),
      data: { computerId: 'computer', assistantId: 'assistant', generation: 1, ...(type === 'computer.claimed' ? { tokenId: 'token:test' } : { podUid: 'pod' }) } } });
    if (result.status !== 'appended') throw new Error('Computer fixture failed'); sequence = result.sequence;
  }
  const credentials: { value: string; expiresAt: number }[] = [], connections: unknown[] = [], delivered: unknown[] = [];
  const expired = new Promise<void>(resolve => server.once('connection', socket => socket.once('close', () => resolve())));
  // Stand in for the Kubernetes proxy path; the real channel handles authentication and expiry.
  server.on('upgrade', request => { connections.push(request.headers['x-bridge-token']); request.url = '/bridge'; });
  const channel = bridgeChannel(server, {
    journal: `${fixture.directory}/reports`, credential: () => credentials.at(-1)!,
    grant: () => Promise.resolve(),
    async rpc(method, input) {
      if (method === 'thread/start') await expired; // Keep the message pending across expiry.
      if (method === 'turn/start') delivered.push(input['input']);
      return { thread: { id: 'thread' } };
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const delivery = vi.spyOn(kube, 'credentials').mockImplementation((_computerId, token) => {
    credentials.push({ value: token.value, expiresAt: Date.now() + (credentials.length ? 60_000 : 150) });
    return Promise.resolve();
  });
  const work = watchBridges({ silo: 'test', store: fixture.store, keys: fixture.keys, db }, tokens, kube, `http://127.0.0.1:${address.port}`, stop.signal, logger);
  try {
    await expired;
    expect(delivered).toEqual([]);
    expect(credentials[0]!.expiresAt).toBeLessThanOrEqual(Date.now());
    await vi.waitFor(() => expect(connections).toHaveLength(2), { timeout: 2000 });
    expect(credentials).toHaveLength(2);
    expect(connections).toEqual(credentials.map(credential => credential.value));
    expect(credentials[1]!.value).not.toBe(credentials[0]!.value);
    expect(credentials[1]!.expiresAt).toBeGreaterThan(Date.now());
    await until(() => delivered.length > 0, 2000);
    await delay(800); // Repeated watcher polls must not execute the pending turn again.
    expect(delivered).toEqual([[{ type: 'text', text: 'Hello', text_elements: [] }]]);
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
    await until(async () => await reportPosition(fixture.store, 'test', 'computer') === 2, 2000);
    expect((await chatHistory(fixture.store, 'test', 'alice')).filter(row => row.event.report).map(row => row.event.type))
      .toEqual(['agent.turn_started', 'agent.turn_completed']);
    expect(loggerLines.join('')).not.toContain('Bridge recovery stopped');
  } finally { stop.abort(); await work; delivery.mockRestore(); await channel.close(); server.close(); await fixture.close(); await dbs.close(); }
}, 30_000);

it('surfaces a permanent report rejection and stops automatic reconnect attempts', async () => {
  const fixture = await replayFixture(), dbs = await databases(), stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const loggerLines: string[] = [];
  const logger = createLogger('bridge-rejection', { level: 'info', destination: { write: line => { loggerLines.push(line); } } });
  const db = pgDb(dbs.queue), runner = new ProjectionRunner(db, fixture.store, logger);
  await runner.initialise(conversations); await runner.run(conversations);
  let sequence = 0;
  for (const type of ['computer.claimed', 'computer.ready']) {
    const result = await fixture.store.append({ expectedSequence: sequence, event: { id: type, commandId: type, type,
      silo: 'test', subject: 'computer-assistant', source: 'test', principal: { kind: 'system', id: 'test' }, time: new Date().toISOString(),
      data: { computerId: 'computer', assistantId: 'assistant', generation: 1, ...(type === 'computer.claimed' ? { tokenId: 'token:test' } : { podUid: 'pod' }) } } });
    if (result.status !== 'appended') throw new Error('Computer fixture failed'); sequence = result.sequence;
  }
  let connections = 0;
  const closed: { code: number; reason: string }[] = [];
  fixture.wss.on('connection', socket => {
    connections++;
    socket.once('close', (code, reason) => closed.push({ code, reason: reason.toString() }));
    socket.once('message', () => socket.send(JSON.stringify({ sequence: 2, conversationId: 'alice', turnId: 'message-alice',
      assistantId: 'assistant', type: 'agent.message_delta', messageId: 'reply', text: 'Private rejected content' })));
  });
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'credentials').mockResolvedValue(undefined);
  const work = watchBridges({ silo: 'test', store: fixture.store, keys: fixture.keys, db }, tokens, kube, fixture.url, stop.signal, logger);
  try {
    await until(() => closed.length > 0, 2000);
    expect(closed[0]).toEqual({ code: 1008, reason: 'Report sequence gap' });
    await delay(800); // More than three watcher polls: a permanent refusal must not reconnect.
    expect(connections).toBe(1);
    expect(loggerLines.join('')).toContain('Report sequence gap');
    expect(loggerLines.join('')).not.toContain('Private rejected content');
  } finally { stop.abort(); await work; await fixture.close(); await dbs.close(); }
});

it('wakes another conversation without rereading the archive of an already closed turn', async () => {
  const fixture = await replayFixture(), dbs = await databases(), stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue), runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-wake'));
  await runner.initialise(conversations); await runner.run(conversations);
  for (const [type, extra] of [
    ['computer.claimed', { tokenId: 'token:initial', generation: 1 }],
    ['computer.ready', { generation: 1, podUid: 'old-pod' }],
  ] as const) {
    const result = await fixture.store.append({ expectedSequence: (await history(fixture.store, 'computer-assistant')).at(-1)?.sequence ?? 0,
      event: { id: type, commandId: type, type, silo: 'test', subject: 'computer-assistant', source: 'test', time: new Date().toISOString(),
        principal: { kind: 'system', id: 'test' }, data: { computerId: 'computer', assistantId: 'assistant', ...extra } } });
    if (result.status !== 'appended') throw new Error('Computer fixture failed');
  }
  const ready = (await history(fixture.store, 'computer-assistant')).at(-1)!.event;
  const started = { sequence: 1, previousSequence: 0, conversationId: 'alice', turnId: 'message-alice', assistantId: 'assistant', type: 'agent.turn_started', threadId: 'alice-thread' };
  const completed = { ...started, sequence: 2, previousSequence: 1, type: 'agent.turn_completed' };
  await recordReport(fixture.store, fixture.keys, fixture.context, started);
  await recordReport(fixture.store, fixture.keys, fixture.context, completed);
  await turnCommand(fixture.store, fixture.context, { ...completed, status: 'completed' });
  await suspendComputer(fixture.store, { ...fixture.context, latest: ready, ready });
  let release!: () => void;
  const archiveBlocked = new Promise<void>(resolve => { release = resolve; });
  let archiveRead = false;
  const read = fixture.store.readStream.bind(fixture.store);
  // The first snapshot is available; later archive reads are stalled at the NATS boundary.
  const reading = vi.spyOn(fixture.store, 'readStream').mockImplementation(async function* (...args) {
    if (args[0] === 'conversation-alice') {
      if (archiveRead) await archiveBlocked;
      archiveRead = true;
    }
    yield* read(...args);
  });
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'credentials').mockResolvedValue(undefined);
  const work = watchBridges({ silo: 'test', store: fixture.store, keys: fixture.keys, db }, tokens, kube, fixture.url, stop.signal);
  try {
    await until(async () => (await history(fixture.store, 'computer-assistant')).at(-1)?.event.type === 'computer.resumed', 3000);
    const result = await fixture.store.append({ expectedSequence: (await history(fixture.store, 'computer-assistant')).at(-1)!.sequence,
      event: { ...ready, id: 'new-ready', commandId: 'new-ready', data: { computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'new-pod' } } });
    expect(result.status).toBe('appended');
    await until(() => fixture.messages.some(message => typeof message === 'object' && message !== null && Reflect.get(message, 'id') === 'message-bob'), 3000);
    expect((await history(fixture.store, 'computer-assistant')).filter(row => row.event.type === 'computer.turn_closed')).toHaveLength(1);
  } finally {
    release(); stop.abort(); await work; reading.mockRestore(); vi.restoreAllMocks(); await fixture.close(); await dbs.close();
  }
});

async function deliversNewMessagesAfterIdle() {
  const fixture = await replayFixture(['alice']);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-idle'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const claimed = envelope('test', 'computer-assistant', 'computer.claimed', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, tokenId: 'token:test',
  });
  const claimResult = await fixture.store.append({ event: claimed, expectedSequence: 0 });
  if (claimResult.status !== 'appended') throw new Error('Computer fixture failed');
  const ready = envelope('test', 'computer-assistant', 'computer.ready', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'pod',
  });
  await fixture.store.append({ event: ready, expectedSequence: claimResult.sequence });
  const terminal = {
    sequence: 1, previousSequence: 0, conversationId: 'alice', turnId: 'message-alice',
    assistantId: 'assistant', type: 'agent.turn_failed',
  };
  await recordReport(fixture.store, fixture.keys, fixture.context, terminal);
  await turnCommand(fixture.store, fixture.context, { ...terminal, status: 'failed' });
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials').mockResolvedValue();
  const mode = vi.spyOn(kube, 'mode').mockResolvedValue();
  const state = vi.spyOn(kube, 'state');
  const reads = vi.spyOn(fixture.store, 'readStream');
  const heads = vi.spyOn(fixture.store, 'head');
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  try {
    function initialHistoryWasRead() {
      return reads.mock.calls.length >= 2;
    }
    await until(initialHistoryWasRead);
    const initialPasses = heads.mock.calls.length;
    function idlePassFinished() {
      return heads.mock.calls.length >= initialPasses + 2;
    }
    await until(idlePassFinished);
    reads.mockClear();
    const idlePasses = heads.mock.calls.length;
    function moreIdlePassesFinished() {
      return heads.mock.calls.length >= idlePasses + 3;
    }
    await until(moreIdlePassesFinished);
    expect(reads).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    const command = { id: 'next-message', conversationId: 'alice', text: 'New work' };
    await chatCommand(fixture.store, fixture.keys, { silo: 'test', memberId: 'alice' }, command);
    function receivedNextMessage(message: unknown) {
      return typeof message === 'object' && message !== null &&
        Reflect.get(message, 'id') === 'next-message';
    }
    function nextMessageArrived() {
      return fixture.messages.some(receivedNextMessage);
    }
    await until(nextMessageArrived, 1000);
    expect(credentials).toHaveBeenCalledOnce();
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('leaves idle chat history unread and picks up a new message on the next poll', deliversNewMessagesAfterIdle);

async function deliversAfterTableCatchesUp() {
  const fixture = await replayFixture(['alice']);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-table-delay'));
  await runner.initialise(conversations);
  const claimed = envelope('test', 'computer-assistant', 'computer.claimed', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, tokenId: 'token:test',
  });
  const result = await fixture.store.append({ event: claimed, expectedSequence: 0 });
  if (result.status !== 'appended') throw new Error('Computer fixture failed');
  const ready = envelope('test', 'computer-assistant', 'computer.ready', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'pod',
  });
  await fixture.store.append({ event: ready, expectedSequence: result.sequence });
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'credentials').mockResolvedValue();
  const queries = vi.spyOn(db, 'query');
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  function queriedConversations(call: typeof queries.mock.calls[number]) {
    return typeof call[0] === 'string' && call[0].includes("type = 'conversation.created'");
  }
  function twoPollsFinished() {
    const conversationQueries = queries.mock.calls.filter(queriedConversations);
    return conversationQueries.length >= 2;
  }
  function isPostedTurn(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'id') === 'message-alice';
  }
  function messageReceived() {
    return fixture.messages.some(isPostedTurn);
  }
  try {
    await until(twoPollsFinished);
    expect(fixture.messages).toEqual([]);
    await runner.run(conversations);
    await until(messageReceived, 1000);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('delivers a message when the conversation table catches up without another event', deliversAfterTableCatchesUp);

type TemporaryFailure = 'head' | 'credentials' | 'table' | 'history';

async function deliversAfterTemporaryFailure(failureKind: TemporaryFailure) {
  const fixture = await replayFixture(['alice']);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-retry'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const claim = envelope('test', 'computer-assistant', 'computer.claimed', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, tokenId: 'token:test',
  });
  const claimed = await fixture.store.append({ event: claim, expectedSequence: 0 });
  if (claimed.status !== 'appended') throw new Error('Computer fixture failed');
  const ready = envelope('test', 'computer-assistant', 'computer.ready', {
    computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'pod',
  });
  await fixture.store.append({ event: ready, expectedSequence: claimed.sequence });
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials').mockResolvedValue();
  if (failureKind === 'head') {
    vi.spyOn(fixture.store, 'head').mockRejectedValueOnce(new Error('Temporary NATS outage'));
  } else if (failureKind === 'credentials') {
    credentials.mockRejectedValueOnce(new Error('Temporary Pod outage'));
  } else if (failureKind === 'table') {
    vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('Temporary database outage'));
  } else {
    function historyUnavailable(): never {
      throw new Error('Temporary history read outage');
    }
    vi.spyOn(fixture.store, 'readStream').mockImplementationOnce(historyUnavailable);
  }
  const logs: string[] = [];
  function logLine(line: string) {
    logs.push(line);
  }
  const loggerOptions = { level: 'error', destination: { write: logLine } };
  const logger = createLogger('bridge-retry', loggerOptions);
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal, logger);
  let failure: unknown;
  function recordFailure(error: unknown) {
    failure = error;
  }
  void work.catch(recordFailure);
  function turnReceived(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'id') === 'message-alice';
  }
  function messageReceivedOrWatcherFailed() {
    return failure !== undefined || fixture.messages.some(turnReceived);
  }
  try {
    await until(messageReceivedOrWatcherFailed, 3000);
    expect(failure).toBeUndefined();
    expect(fixture.messages.some(turnReceived)).toBe(true);
    if (failureKind === 'head') {
      expect(logs.join('')).toContain('Temporary NATS outage');
    } else if (failureKind === 'table') {
      expect(logs.join('')).toContain('Temporary database outage');
    } else if (failureKind === 'credentials') {
      expect(credentials).toHaveBeenCalledTimes(2);
    }
  } finally {
    stop.abort();
    await work.catch(recordFailure);
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

const temporaryFailures = ['head', 'credentials', 'table', 'history'] as const;
it.each(temporaryFailures)(
  'delivers the next message after one temporary %s failure without another event',
  deliversAfterTemporaryFailure,
);

async function finishedChatFixture(count: number) {
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    names.push(`old-${index}`);
  }
  names.push('fresh');
  const fixture = await replayFixture(names);
  const computer = { computerId: 'computer', assistantId: 'assistant', generation: 1 };
  const claimedData = { ...computer, tokenId: 'token:test' };
  const claimed = envelope('test', 'computer-assistant', 'computer.claimed', claimedData);
  const claimCommand = { event: claimed, expectedSequence: 0 };
  const claim = await fixture.store.append(claimCommand);
  if (claim.status !== 'appended') throw new Error('Computer fixture failed');
  const readyData = { ...computer, podUid: 'pod' };
  const ready = envelope('test', 'computer-assistant', 'computer.ready', readyData);
  const readyCommand = { event: ready, expectedSequence: claim.sequence };
  await fixture.store.append(readyCommand);
  for (let index = 0; index < count; index++) {
    const conversationId = `old-${index}`;
    const report = {
      sequence: index + 1, previousSequence: 0, conversationId,
      turnId: `message-${conversationId}`, assistantId: 'assistant', type: 'agent.turn_failed',
    };
    await recordReport(fixture.store, fixture.keys, fixture.context, report);
    const closeTurn = { ...report, status: 'failed' as const };
    await turnCommand(fixture.store, fixture.context, closeTurn);
  }
  return fixture;
}

function isFreshTurn(message: unknown) {
  return typeof message === 'object' && message !== null &&
    Reflect.get(message, 'type') === 'turn' && Reflect.get(message, 'id') === 'message-fresh';
}

async function retriesIgnoredTurn() {
  const fixture = await finishedChatFixture(0);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-retry'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  function turnArrived() {
    return fixture.messages.some(isFreshTurn);
  }
  function secondDeliveryArrived() {
    return fixture.messages.filter(isFreshTurn).length >= 2;
  }
  function isAcknowledgement(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'type') === 'ack' && Reflect.get(message, 'token') !== undefined;
  }
  function admitted() {
    return fixture.messages.some(isAcknowledgement);
  }
  try {
    await until(turnArrived, 10_000);
    const peer = [...fixture.wss.clients][0]!;
    // Ignore the first delivery, just as a computer does while its private slots are full.
    await until(secondDeliveryArrived, 5000);
    expect([...fixture.wss.clients]).toEqual([peer]);
    expect(credentials).toHaveBeenCalledTimes(1);
    const report = {
      sequence: 1, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
      assistantId: 'assistant', type: 'agent.turn_started', threadId: 'thread-fresh',
    };
    peer.send(JSON.stringify(report));
    await until(admitted, 10_000);
    const lifecycle = await history(fixture.store, 'computer-assistant');
    function isStarted(row: typeof lifecycle[number]) {
      return row.event.type === 'computer.turn_started';
    }
    expect(lifecycle.filter(isStarted)).toHaveLength(1);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('resends an ignored turn on the same connection so it can start when a slot frees',
  retriesIgnoredTurn);

async function avoidsRepeatedPendingReads() {
  const fixture = await finishedChatFixture(30);
  const report = {
    sequence: 31, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
    assistantId: 'assistant', type: 'agent.turn_started', threadId: 'thread-fresh',
  };
  await recordReport(fixture.store, fixture.keys, fixture.context, report);
  const start = { ...report, status: 'started' as const };
  await turnCommand(fixture.store, fixture.context, start);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-pending'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  let pass = 0;
  const query = db.query.bind(db);
  async function countPass(...args: Parameters<typeof db.query>) {
    if (typeof args[0] === 'string' && args[0].includes("type = 'conversation.created'")) {
      pass++;
      if (pass === 5) {
        stop.abort();
        throw new Error('Three passes after connection opening finished');
      }
    }
    return query(...args);
  }
  const queries = vi.spyOn(db, 'query');
  queries.mockImplementation(countPass);
  const reads: { pass: number; subject: string }[] = [];
  const read = fixture.store.readStream.bind(fixture.store);
  async function* countRead(...args: Parameters<typeof fixture.store.readStream>) {
    const observation = { pass, subject: args[0] };
    reads.push(observation);
    yield* read(...args);
  }
  const reading = vi.spyOn(fixture.store, 'readStream');
  reading.mockImplementation(countRead);
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  try {
    await work;
    for (let checkedPass = 2; checkedPass <= 4; checkedPass++) {
      function isComputerRead(read: typeof reads[number]) {
        return read.pass === checkedPass && read.subject === 'computer-assistant';
      }
      function isAssistantRead(read: typeof reads[number]) {
        return read.pass === checkedPass && read.subject === 'assistant-assistant';
      }
      expect(reads.filter(isComputerRead).length).toBeLessThanOrEqual(1);
      expect(reads.filter(isAssistantRead).length).toBeLessThanOrEqual(1);
    }
    function isRepeatedFinishedChatRead(read: typeof reads[number]) {
      return read.pass > 1 && read.subject.startsWith('conversation-old-');
    }
    expect(reads.filter(isRepeatedFinishedChatRead)).toEqual([]);
    expect(fixture.messages.filter(isFreshTurn)).toHaveLength(1);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('keeps 30 finished chats unread with no resend after the turn is accepted',
  avoidsRepeatedPendingReads, 120_000);

async function routesAndCachesAssistants() {
  const fixture = await finishedChatFixture(0);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  for (const assistantId of ['team', 'unclaimed']) {
    const assistantData = { assistantId, ownerId: 'alice', kind: 'team' };
    const created = envelope('test', `assistant-${assistantId}`, 'assistant.created', assistantData);
    const creation = { expectedSequence: 0, event: created };
    await fixture.store.append(creation);
    fixture.keys.provision('test', assistantId);
    const member = { silo: 'test', memberId: 'alice' };
    const create = { id: `create-${assistantId}`, conversationId: assistantId, assistantId };
    await chatCommand(fixture.store, fixture.keys, member, create);
    if (assistantId === 'team') {
      const message = { id: 'message-team', conversationId: assistantId, text: 'Private work' };
      await chatCommand(fixture.store, fixture.keys, member, message);
      const computer = { computerId: 'team-computer', assistantId, generation: 1 };
      const claimData = { ...computer, tokenId: 'token:team' };
      const claim = envelope('test', 'computer-team', 'computer.claimed', claimData);
      const claimCommand = { expectedSequence: 0, event: claim };
      const claimed = await fixture.store.append(claimCommand);
      if (claimed.status !== 'appended') throw new Error('Team computer fixture failed');
      const readyData = { ...computer, podUid: 'team-pod' };
      const ready = envelope('test', 'computer-team', 'computer.ready', readyData);
      const readyCommand = { expectedSequence: claimed.sequence, event: ready };
      await fixture.store.append(readyCommand);
    }
  }
  const deliveries: { path: string | undefined; message: unknown }[] = [];
  function receiveConnection(socket: import('ws').WebSocket,
    request: import('node:http').IncomingMessage) {
    function receive(raw: import('ws').RawData) {
      const message: unknown = JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '');
      const delivery = { path: request.url, message };
      deliveries.push(delivery);
    }
    socket.on('message', receive);
  }
  fixture.wss.on('connection', receiveConnection);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-assistants'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  let pass = 0;
  const query = db.query.bind(db);
  async function countPass(...args: Parameters<typeof db.query>) {
    if (typeof args[0] === 'string' && args[0].includes("type = 'conversation.created'")) {
      pass++;
      if (pass === 5) {
        stop.abort();
        throw new Error('Four passes completed');
      }
    }
    return query(...args);
  }
  const queries = vi.spyOn(db, 'query');
  queries.mockImplementation(countPass);
  const reads: { pass: number; subject: string }[] = [];
  const read = fixture.store.readStream.bind(fixture.store);
  async function* countRead(...args: Parameters<typeof fixture.store.readStream>) {
    reads.push({ pass, subject: args[0] });
    yield* read(...args);
  }
  const reading = vi.spyOn(fixture.store, 'readStream');
  reading.mockImplementation(countRead);
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  try {
    await watchBridges(options, tokens, kube, fixture.url, stop.signal);
    for (const assistantId of ['assistant', 'team', 'unclaimed']) {
      function isRepeatedAssistantRead(read: typeof reads[number]) {
        return read.pass > 1 && (read.subject === `computer-${assistantId}` ||
          read.subject === `assistant-${assistantId}`);
      }
      expect(reads.filter(isRepeatedAssistantRead)).toEqual([]);
      for (let checkedPass = 2; checkedPass <= 4; checkedPass++) {
        function isChatRead(read: typeof reads[number]) {
          return read.pass === checkedPass && read.subject === 'conversation-unclaimed';
        }
        expect(reads.filter(isChatRead)).toEqual([]);
      }
    }
    function isPersonalDelivery(delivery: typeof deliveries[number]) {
      return isFreshTurn(delivery.message);
    }
    function isTeamDelivery(delivery: typeof deliveries[number]) {
      return typeof delivery.message === 'object' && delivery.message !== null &&
        Reflect.get(delivery.message, 'id') === 'message-team';
    }
    const personal = deliveries.filter(isPersonalDelivery);
    const team = deliveries.filter(isTeamDelivery);
    expect(personal.length).toBeGreaterThan(0);
    expect(team.length).toBeGreaterThan(0);
    const personalTurn = { assistantId: 'assistant', executionMode: 'memory_free' };
    for (const delivery of personal) {
      expect(delivery.path).toContain('/pods/computer:8081/');
      expect(delivery.message).toMatchObject(personalTurn);
    }
    const privateTurn = { assistantId: 'team', executionMode: 'restricted', attachments: [] };
    for (const delivery of team) {
      expect(delivery.path).toContain('/pods/team-computer:8081/');
      expect(delivery.message).toMatchObject(privateTurn);
    }
  } finally {
    stop.abort();
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('routes personal and private team turns to their own computers and reuses unchanged histories',
  routesAndCachesAssistants, 120_000);

async function waitsSafelyForAssistantHistory(source: string, waiting: boolean) {
  const fixture = await finishedChatFixture(0);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  if (!waiting) {
    const terminal = {
      sequence: 1, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
      assistantId: 'assistant', type: 'agent.turn_failed',
    };
    await recordReport(fixture.store, fixture.keys, fixture.context, terminal);
    const closeTurn = { ...terminal, status: 'failed' as const };
    await turnCommand(fixture.store, fixture.context, closeTurn);
  }
  const db = pgDb(dbs.queue);
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  const loggerOptions = { level: 'error', destination: { write } };
  const logger = createLogger('bridge-kind', loggerOptions);
  const runner = new ProjectionRunner(db, fixture.store, logger);
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  const read = fixture.store.readStream.bind(fixture.store);
  async function* failHistoryRead(...args: Parameters<typeof fixture.store.readStream>) {
    if (args[0] === `${source}-assistant`) throw new Error('History unavailable');
    yield* read(...args);
  }
  const reading = vi.spyOn(fixture.store, 'readStream');
  reading.mockImplementation(failHistoryRead);
  const heads = vi.spyOn(fixture.store, 'head');
  const queries = vi.spyOn(db, 'query');
  function isGlobalHead(call: typeof heads.mock.calls[number]) {
    return call[0] === undefined;
  }
  function enoughPolls() {
    return heads.mock.calls.filter(isGlobalHead).length >= 6;
  }
  function isPass(call: typeof queries.mock.calls[number]) {
    return typeof call[0] === 'string' && call[0].includes("type = 'conversation.created'");
  }
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal, logger);
  try {
    await until(enoughPolls);
    const passCount = queries.mock.calls.filter(isPass).length;
    if (waiting) {
      expect(passCount).toBeGreaterThanOrEqual(4);
    } else {
      expect(passCount).toBe(1);
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Assistant');
    expect(credentials).not.toHaveBeenCalled();
    expect(fixture.messages.filter(isFreshTurn)).toEqual([]);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

const unavailableHistories = [
  ['assistant', false], ['assistant', true], ['computer', false], ['computer', true],
] as const;

it.each(unavailableHistories)(
  'logs unreadable %s history once and polls only for a waiting message (%s)',
  waitsSafelyForAssistantHistory);

async function checksRecentTurnClose() {
  const fixture = await finishedChatFixture(0);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const terminal = {
    sequence: 1, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
    assistantId: 'assistant', type: 'agent.turn_failed',
  };
  await recordReport(fixture.store, fixture.keys, fixture.context, terminal);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-recent-close'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  let injected = false;
  let closing = false;
  const laterReads: string[] = [];
  const read = fixture.store.readStream.bind(fixture.store);
  async function* closeBeforeChatRead(...args: Parameters<typeof fixture.store.readStream>) {
    if (injected && !closing) laterReads.push(args[0]);
    if (args[0] === 'conversation-fresh' && !injected) {
      injected = true;
      closing = true;
      // Finish the report after the computer snapshot but before the bridge reads the chat.
      const closeTurn = { ...terminal, status: 'failed' as const };
      await turnCommand(fixture.store, fixture.context, closeTurn);
      closing = false;
    }
    yield* read(...args);
  }
  const reading = vi.spyOn(fixture.store, 'readStream');
  reading.mockImplementation(closeBeforeChatRead);
  const heads = vi.spyOn(fixture.store, 'head');
  function isGlobalHead(call: typeof heads.mock.calls[number]) {
    return call[0] === undefined;
  }
  function enoughPolls() {
    return heads.mock.calls.filter(isGlobalHead).length >= 6;
  }
  function isChatRead(subject: string) {
    return subject === 'conversation-fresh';
  }
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  try {
    await until(enoughPolls);
    expect(injected).toBe(true);
    expect(laterReads.filter(isChatRead)).toEqual([]);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('refreshes a missing turn close before trying to close an already finished turn again',
  checksRecentTurnClose);

async function sendsPromptlyWithFinishedChats() {
  const fixture = await finishedChatFixture(90);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-many-chats'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const heads = vi.spyOn(fixture.store, 'head');
  const reads = vi.spyOn(fixture.store, 'readStream');
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  function freshTurnArrived() {
    return fixture.messages.some(isFreshTurn);
  }
  function isNextTurn(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'id') === 'next-message';
  }
  function nextTurnArrived() {
    return fixture.messages.some(isNextTurn);
  }
  function isGlobalHead(call: typeof heads.mock.calls[number]) {
    return call[0] === undefined;
  }
  try {
    await until(freshTurnArrived, 60_000);
    const terminal = {
      sequence: 91, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
      assistantId: 'assistant', type: 'agent.turn_failed',
    };
    await recordReport(fixture.store, fixture.keys, fixture.context, terminal);
    const closeTurn = { ...terminal, status: 'failed' as const };
    await turnCommand(fixture.store, fixture.context, closeTurn);
    await runner.run(conversations);
    const previousPolls = heads.mock.calls.filter(isGlobalHead).length;
    function finishedTurnProcessed() {
      return heads.mock.calls.filter(isGlobalHead).length >= previousPolls + 3;
    }
    await until(finishedTurnProcessed, 60_000);
    const command = { id: 'next-message', conversationId: 'fresh', text: 'New work' };
    reads.mockClear();
    const member = { silo: 'test', memberId: 'fresh' };
    await chatCommand(fixture.store, fixture.keys, member, command);
    await until(nextTurnArrived, 60_000);
    function isFinishedChatRead(call: typeof reads.mock.calls[number]) {
      return call[0].startsWith('conversation-old-');
    }
    function isComputerRead(call: typeof reads.mock.calls[number]) {
      return call[0] === 'computer-assistant';
    }
    expect(reads.mock.calls.filter(isFinishedChatRead)).toEqual([]);
    expect(reads.mock.calls.filter(isComputerRead).length).toBeLessThanOrEqual(1);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('sends a posted turn without rereading 90 finished chats or unchanged computer history',
  sendsPromptlyWithFinishedChats, 180_000);

async function stopsAndReconnectsAcceptedTurn() {
  const fixture = await finishedChatFixture(0);
  const dbs = await databases();
  const stop = new AbortController();
  const tokens = await bridgeTokens(fixture);
  const db = pgDb(dbs.queue);
  const runner = new ProjectionRunner(db, fixture.store, createLogger('bridge-accepted'));
  await runner.initialise(conversations);
  await runner.run(conversations);
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  const credentials = vi.spyOn(kube, 'credentials');
  credentials.mockResolvedValue();
  const reads = vi.spyOn(fixture.store, 'readStream');
  const queries = vi.spyOn(db, 'query');
  let acceptedDeliveries = 0;
  function isPass(call: typeof queries.mock.calls[number]) {
    return typeof call[0] === 'string' && call[0].includes("type = 'conversation.created'");
  }
  function passCount() {
    return queries.mock.calls.filter(isPass).length;
  }
  async function waitForPasses() {
    const count = passCount();
    function threePassesStarted() {
      return passCount() >= count + 3;
    }
    await until(threePassesStarted);
  }
  function turnArrived() {
    return fixture.messages.some(isFreshTurn);
  }
  function isAcknowledgement(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'type') === 'ack' && Reflect.get(message, 'token') !== undefined;
  }
  function admitted() {
    return fixture.messages.some(isAcknowledgement);
  }
  function isStop(message: unknown) {
    return typeof message === 'object' && message !== null &&
      Reflect.get(message, 'type') === 'stop' && Reflect.get(message, 'turnId') === 'message-fresh';
  }
  function stopArrived() {
    return fixture.messages.some(isStop);
  }
  function resentAfterReconnect() {
    return fixture.messages.filter(isFreshTurn).length > acceptedDeliveries;
  }
  function readFreshChat(call: typeof reads.mock.calls[number]) {
    return call[0] === 'conversation-fresh';
  }
  const options = { silo: 'test', store: fixture.store, keys: fixture.keys, db };
  const work = watchBridges(options, tokens, kube, fixture.url, stop.signal);
  try {
    await until(turnArrived);
    const peer = [...fixture.wss.clients][0]!;
    const report = {
      sequence: 1, previousSequence: 0, conversationId: 'fresh', turnId: 'message-fresh',
      assistantId: 'assistant', type: 'agent.turn_started', threadId: 'thread-fresh',
    };
    peer.send(JSON.stringify(report));
    await until(admitted);
    await waitForPasses();
    acceptedDeliveries = fixture.messages.filter(isFreshTurn).length;
    reads.mockClear();
    await waitForPasses();
    expect(reads.mock.calls.filter(readFreshChat)).toEqual([]);
    expect(fixture.messages.filter(isFreshTurn)).toHaveLength(acceptedDeliveries);
    const request = { id: 'stop-fresh', conversationId: 'fresh', stopTurnId: 'message-fresh' };
    const member = { silo: 'test', memberId: 'fresh' };
    await chatCommand(fixture.store, fixture.keys, member, request);
    await until(stopArrived);
    peer.terminate();
    await until(resentAfterReconnect);
    await waitForPasses();
    expect(fixture.messages.filter(isFreshTurn)).toHaveLength(acceptedDeliveries + 1);
    expect(fixture.messages.filter(isStop)).toHaveLength(2);
  } finally {
    stop.abort();
    await work;
    vi.restoreAllMocks();
    await fixture.close();
    await dbs.close();
  }
}

it('leaves an accepted turn unread, still sends Stop, and resends after reconnecting',
  stopsAndReconnectsAcceptedTurn);
