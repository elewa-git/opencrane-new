import { generateKeyPairSync } from 'node:crypto';
import { BudgetActor, envelope } from '@opencrane/models';
import { tokenIssuer } from '@opencrane/auth';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { expect, it, vi } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../../computer/src/channel.ts';

it('authenticates, overlaps conversations and replays a strict report sequence after disconnect', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-`), server = createServer();
  let calls = 0;
  const turnModels: unknown[] = [];
  const channel = bridgeChannel(server, {
    rpc(method, input) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${++calls}` } });
      if (method === 'turn/start') { turnModels.push(input['model']); }
      if (method === 'turn/start') channel.notification({ method: 'item/agentMessage/delta', params: { threadId: input['threadId'], itemId: 'reply', delta: 'Hello' } });
      return Promise.resolve({});
    },
    async grant() {},
    credential: () => ({ value: 'short-lived-test-capability', expiresAt: Date.now() + 60_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  let socket: WebSocket | undefined;
  const reports: { sequence: number; conversationId: string; type: string }[] = [];
  const connect = async (since: number) => {
    const ws = new WebSocket(url, { headers: { 'x-bridge-token': 'short-lived-test-capability' } });
    ws.on('message', raw => {
      const report = z.object({ sequence: z.number(), conversationId: z.string(), type: z.string() }).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '') as unknown);
      reports.push(report); ws.send(JSON.stringify({ type: 'ack', sequence: report.sequence, token: 'test-turn', expiresAt: Date.now()+120_000 }));
    });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'resume', since })); return ws;
  };
  try {
    const bad = new WebSocket(url); bad.on('error', () => undefined);
    await once(bad, 'unexpected-response'); bad.terminate();
    socket = await connect(0);
    for (const conversationId of ['alice', 'bob']) socket.send(JSON.stringify({ type: 'turn', id: conversationId, conversationId, assistantId: 'assistant', text: 'Hello', token: 'test-turn', expiresAt: Date.now()+60_000 }));
    await until(() => reports.filter(r => r.type === 'agent.message_delta').length === 2);
    expect(calls).toBe(2);
    expect(turnModels).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol']);
    channel.notification({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', delta: 'Checking the request.' } });
    channel.notification({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', command: 'echo safe', exitCode: 0 } } });
    await until(() => reports.some(r => r.type === 'agent.command_ran'));
    const last = reports.at(-1)!.sequence; socket.terminate(); await once(socket, 'close');
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread-2', turn: { status: 'completed' } } });
    socket = await connect(last);
    await until(() => reports.filter(r => r.type === 'agent.turn_completed').length === 2);
    expect(reports.map(r => r.sequence)).toEqual(Array.from({ length: reports.length }, (_, i) => i+1));
    socket.send(JSON.stringify({ type: 'turn', id: 'alice', conversationId: 'alice', assistantId: 'assistant', text: 'Hello', token: 'test-turn', expiresAt: Date.now()+60_000 }));
    expect(calls).toBe(2);
  } finally { socket?.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('recovers the server connector from the NATS report sequence without gaps or duplicate events', async () => {
  const { natsFixture } = await import('@opencrane/event-store/testing');
  const { conversationKeys } = await import('../src/chat/keys.ts');
  const { chatCommand, chatHistory } = await import('../src/chat/commands.ts');
  const { connectBridge } = await import('../src/chat/bridge.ts');
  const { reportPosition } = await import('../src/chat/reports.ts');
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/bridge-restart-`), server = createServer();
  const keys = conversationKeys(`${directory}/keys`); keys.provision('test', 'conversation');
  const options = { silo: 'test', store: nats.store, keys }, context = { silo: 'test', memberId: 'alice' };
  await chatCommand(nats.store, keys, context, { id: 'create', conversationId: 'conversation', assistantId: 'assistant' });
  await chatCommand(nats.store, keys, context, { id: 'message', conversationId: 'conversation', text: 'Hello' });
  const channel = bridgeChannel(server, { rpc: () => Promise.resolve({ thread: { id: 'thread' } }), grant: () => Promise.resolve(),
    credential: () => ({ value: 'short-lived-test', expiresAt: Date.now()+60_000 }), journal: `${directory}/reports` });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connection = { url: `ws://127.0.0.1:${address.port}/bridge`, computerId: 'computer', assistantId: 'assistant', bearer: 'short-lived-test' };
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://bridge.test/' });
  let position = 0;
  for (const type of ['computer.claimed', 'computer.ready']) {
    const result = await nats.store.append({ expectedSequence: position, event: { id: type, commandId: type, type,
      silo: 'test', subject: 'computer-assistant', source: 'test', principal: { kind: 'system', id: 'test' }, time: new Date().toISOString(),
      data: { computerId: 'computer', assistantId: 'assistant', generation: 1, ...(type === 'computer.claimed' ? { tokenId: 'token:test' } : { podUid: 'pod' }) } } });
    if (result.status !== 'appended') throw new Error('Computer fixture failed'); position = result.sequence;
  }
  await new BudgetActor(nats.store, 'test').start(2000, 20000, 'personal-default');
  await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }) });
  let link = await connectBridge(options, connection, tokens);
  try {
    link.socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'short-lived-turn', expiresAt: Date.now()+60_000 }));
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 1);
    channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Hello back' } });
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 2);
    link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
    channel.notification({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'reply', text: 'Hello back' } } });
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
    link = await connectBridge(options, connection, tokens);
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 4);
    const reports = (await chatHistory(nats.store, 'test', 'conversation')).flatMap(r => r.event.report ? [r.event.report.sequence] : []);
    expect(reports).toEqual([1, 2, 3, 4]);
  } finally { link.socket.terminate(); await channel.close(); server.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('reconnects after 121 seconds and executes the pending message once with a fresh grant', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-refresh-`), server = createServer();
  const initial = Date.now(); let now = initial, runs = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const channel = bridgeChannel(server, {
    rpc: method => { if (method === 'turn/start') runs++; return Promise.resolve({ thread: { id: 'thread' } }); },
    grant: (_thread, _conversation, token, expiry) => {
      if (token !== 'fresh' || expiry <= now) return Promise.reject(new Error('Expired grant'));
      return Promise.resolve();
    },
    credential: () => ({ value: 'computer', expiresAt: now + 600_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'computer' } });
    await once(socket, 'open'); return socket;
  };
  let socket = await connect();
  try {
    const first = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    const input = { type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'old', expiresAt: initial + 120_000 };
    socket.send(JSON.stringify(input)); await first;
    socket.terminate(); await once(socket, 'close');
    now += 121_000;
    socket = await connect();
    socket.send(JSON.stringify({ type: 'resume', since: 1 }));
    socket.send(JSON.stringify({ ...input, token: 'fresh', expiresAt: now + 120_000 }));
    socket.send(JSON.stringify({ type: 'ack', sequence: 1, token: 'fresh', expiresAt: now + 120_000 }));
    await until(() => runs === 1, 1000);
    expect(runs).toBe(1);
  } finally { clock.mockRestore(); socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('interrupts the requested Codex turn and retains the partial report', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-stop-`), server = createServer();
  const reports: { type: string; text?: string | undefined }[] = [];
  const channel = bridgeChannel(server, {
    rpc(method, params) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread' } });
      if (method === 'turn/start') {
        channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Partial' } });
        return Promise.resolve({ turn: { id: 'codex-turn' } });
      }
      expect(method).toBe('turn/interrupt'); expect(params).toEqual({ threadId: 'thread', turnId: 'codex-turn' });
      channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'interrupted' } } });
      return Promise.resolve({});
    },
    async grant() {}, credential: () => ({ value: 'test', expiresAt: Date.now() + 60_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'test' } });
  socket.on('message', raw => {
    const row = z.object({ sequence: z.number(), type: z.string(), text: z.string().optional() }).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : ''));
    reports.push(row); socket.send(JSON.stringify({ type: 'ack', sequence: row.sequence, token: 'turn', expiresAt: Date.now() + 60_000 }));
  });
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'turn', expiresAt: Date.now() + 60_000 }));
    await until(() => reports.some(row => row.text === 'Partial'));
    socket.send(JSON.stringify({ type: 'stop', turnId: 'message', conversationId: 'conversation' }));
    await until(() => reports.some(row => row.type === 'agent.turn_failed'), 1500);
    expect(reports.find(row => row.type === 'agent.message_delta')?.text).toBe('Partial');
  } finally { socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('retries a failed Stop after turn/start returns, retaining the active turn and its reports', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-stop-race-`), server = createServer();
  let release!: (value: unknown) => void, interrupts = 0;
  const start = new Promise<unknown>(resolve => { release = resolve; });
  const reports: { type: string; text?: string | undefined }[] = [];
  const channel = bridgeChannel(server, {
    rpc(method) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread' } });
      if (method === 'turn/start') {
        channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Partial' } });
        return start;
      }
      if (++interrupts === 1) return Promise.reject(new Error('Transport unavailable'));
      channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'interrupted' } } });
      return Promise.resolve({});
    },
    async grant() {}, credential: () => ({ value: 'test', expiresAt: Date.now() + 60_000 }), journal: `${directory}/reports`,
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'test' } });
    ws.on('message', raw => {
      const row = z.object({ sequence: z.number(), type: z.string(), text: z.string().optional() }).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : ''));
      reports.push(row); ws.send(JSON.stringify({ type: 'ack', sequence: row.sequence, token: 'turn', expiresAt: Date.now() + 60_000 }));
    });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'resume', since: 0 })); return ws;
  };
  let socket = await connect();
  const stop = { type: 'stop', turnId: 'message', conversationId: 'conversation' };
  try {
    socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'turn', expiresAt: Date.now() + 60_000 }));
    await until(() => reports.some(row => row.text === 'Partial'));
    socket.send(JSON.stringify(stop));
    // A subsequent replay response proves the preceding Stop frame was processed.
    const count = reports.length; socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    await until(() => reports.length > count);
    release({ turn: { id: 'codex-turn' } });
    await until(() => interrupts === 1);
    expect(reports.some(row => row.type === 'agent.turn_failed')).toBe(false);
    socket.terminate(); socket = await connect();
    channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: ' still running' } });
    await until(() => reports.some(row => row.text === ' still running'));
    socket.send(JSON.stringify(stop)); await until(() => reports.some(row => row.type === 'agent.turn_failed'));
    expect(interrupts).toBe(2);
  } finally { socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});

it('pauses both conversations, fences preparing turns and waits for local tools to stop', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-pause-`), server = createServer();
  let threads = 0, toolsStopped = false, finishTools!: () => void;
  const local = new Promise<void>(resolve => { finishTools = () => { toolsStopped = true; resolve(); }; });
  const received: Record<string, unknown>[] = [];
  const channel = bridgeChannel(server, {
    journal: `${directory}/reports`, credential: () => ({ value: 'test', expiresAt: Date.now()+60000 }),
    async grant() {}, async localControl(action) { if (action === 'pause') await local; },
    rpc(method, params) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${++threads}` } });
      if (method === 'turn/start') return Promise.resolve({ turn: { id: `turn-${threads}` } });
      channel.notification({ method: 'turn/completed', params: { threadId: params['threadId'], turn: { status: 'interrupted' } } });
      return Promise.resolve({});
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/bridge`, { headers: { 'x-bridge-token': 'test' } });
  socket.on('message', raw => {
    const value = z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.isBuffer(raw) ? raw.toString() : '{}')); received.push(value);
    if (value['type'] === 'agent.turn_started') socket.send(JSON.stringify({ type: 'ack', sequence: value['sequence'], token: 'turn', expiresAt: Date.now()+60000 }));
  });
  try {
    await once(socket, 'open'); socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    for (const conversation of ['one', 'two']) socket.send(JSON.stringify({ type: 'turn', id: conversation, conversationId: conversation, assistantId: 'assistant', text: 'Work', token: 'preparing', expiresAt: Date.now()+60000 }));
    await until(() => received.filter(row => row['type'] === 'agent.turn_started').length === 2);
    socket.send(JSON.stringify({ type: 'pause', id: 'takeover' }));
    await until(() => received.filter(row => row['type'] === 'agent.turn_failed').length === 2);
    expect(received.some(row => row['type'] === 'paused')).toBe(false);
    socket.send(JSON.stringify({ type: 'turn', id: 'third', conversationId: 'three', assistantId: 'assistant', text: 'Forbidden', token: 'preparing', expiresAt: Date.now()+60000 }));
    finishTools(); await until(() => received.some(row => row['type'] === 'paused'));
    expect(toolsStopped).toBe(true); expect(threads).toBe(2);
    expect(received.find(row => row['type'] === 'paused')).toMatchObject({ id: 'takeover' });
  } finally { finishTools(); socket.terminate(); await channel.close(); server.close(); await rm(directory, { recursive: true, force: true }); }
});
