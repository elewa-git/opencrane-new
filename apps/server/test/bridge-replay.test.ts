import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BudgetActor, envelope } from '@opencrane/models';
import { tokenIssuer, turnTokenAudience } from '@opencrane/auth';
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
import { databases, until, openfga } from '@opencrane/authz/testing';
import { createStore } from '@opencrane/authz';
import { getEventDefinition } from '@opencrane/events';
import * as desktop from '../src/computers/desktop.ts';
import { connectBridge, watchBridges } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { recordReport } from '../src/chat/reports.ts';
import { bridgeChannel } from '../../computer/src/channel.ts';
import { reportPosition } from '../src/chat/reports.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { history, suspendComputer } from '../../ops/src/lifecycle.ts';

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
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${fixture.directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${fixture.directory}/key.pem`, issuer: 'https://bridge.test/' });
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
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${fixture.directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${fixture.directory}/key.pem`, issuer: 'https://bridge.test/' });
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

it.each([false, true])('wakes another conversation after watcher restart (released: %s)', async afterRelease => {
  const fixture = await replayFixture(), dbs = await databases(), stop = new AbortController();
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${fixture.directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${fixture.directory}/key.pem`, issuer: 'https://bridge.test/' });
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
  const fgaFixture = afterRelease ? await openfga() : undefined;
  const binding = fgaFixture ? await createStore(fgaFixture.apiUrl, 'test') : undefined;
  if (afterRelease) {
    vi.spyOn(desktop, 'computerControl').mockReturnValue(() => Promise.resolve());
    for (const type of ['takeover.requested', 'takeover.ended']) expect((await fixture.store.append({
      expectedSequence: (await history(fixture.store, 'computer-assistant')).at(-1)!.sequence,
      event: envelope('test', 'computer-assistant', type, Object.assign({}, getEventDefinition(type)!.example,
        { assistantId: 'assistant', computerId: 'computer', conversationId: 'alice', requestedBy: 'alice', turnId: 'message-alice' })),
    })).status).toBe('appended');
  }
  await suspendComputer(fixture.store, { ...fixture.context, latest: ready, ready });
  let release!: () => void;
  const archiveBlocked = new Promise<void>(resolve => { release = resolve; });
  let archiveRead = false;
  const read = fixture.store.readStream.bind(fixture.store);
  // The first snapshot is available; later archive reads are stalled at the NATS boundary.
  const reading = vi.spyOn(fixture.store, 'readStream').mockImplementation(async function* (...args) {
    if (!afterRelease && args[0] === 'conversation-alice') {
      if (archiveRead) await archiveBlocked;
      archiveRead = true;
    }
    yield* read(...args);
  });
  let granted: string | undefined, sent = false;
  if (afterRelease) fixture.wss.on('connection', socket => socket.on('message', raw => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw)]);
    const value: unknown = JSON.parse(bytes.toString());
    if (typeof value !== 'object' || value === null) return;
    if (Reflect.get(value, 'id') === 'message-bob' && !sent) {
      sent = true;
      socket.send(JSON.stringify({ sequence: 3, previousSequence: 0, conversationId: 'bob', turnId: 'message-bob',
        assistantId: 'assistant', type: 'agent.turn_started', threadId: 'bob-after-release' }));
    }
    const token: unknown = Reflect.get(value, 'token');
    if (Reflect.get(value, 'type') === 'ack' && typeof token === 'string') granted = token;
  }));
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'credentials').mockResolvedValue(undefined);
  const work = watchBridges({ silo: 'test', store: fixture.store, keys: fixture.keys, db, ...(binding ? { binding } : {}) }, tokens, kube, fixture.url, stop.signal);
  try {
    await until(async () => (await history(fixture.store, 'computer-assistant')).at(-1)?.event.type === 'computer.resumed', 3000);
    const result = await fixture.store.append({ expectedSequence: (await history(fixture.store, 'computer-assistant')).at(-1)!.sequence,
      event: { ...ready, id: 'new-ready', commandId: 'new-ready', data: { computerId: 'computer', assistantId: 'assistant', generation: 1, podUid: 'new-pod' } } });
    expect(result.status).toBe('appended');
    await until(() => fixture.messages.some(message => typeof message === 'object' && message !== null && Reflect.get(message, 'id') === 'message-bob'), 3000);
    if (afterRelease) {
      await until(() => granted !== undefined, 3000);
      expect(await tokens.verify(granted!, turnTokenAudience)).toMatchObject({ turn: 'message-bob', requester: 'bob', thread: 'bob-after-release' });
    }
    expect((await history(fixture.store, 'computer-assistant')).filter(row => row.event.type === 'computer.turn_closed')).toHaveLength(1);
  } finally {
    release(); stop.abort(); await work; reading.mockRestore(); vi.restoreAllMocks(); await fixture.close(); await dbs.close(); await fgaFixture?.close();
  }
});
