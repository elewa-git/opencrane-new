import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../../computer/src/channel.ts';

it('authenticates, overlaps conversations and replays a strict report sequence after disconnect', async () => {
  const directory = await mkdtemp(`${tmpdir()}/bridge-`), server = createServer();
  let calls = 0;
  const channel = bridgeChannel(server, {
    rpc(method, input) {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: `thread-${++calls}` } });
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
      reports.push(report); ws.send(JSON.stringify({ type: 'ack', sequence: report.sequence }));
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
  let link = await connectBridge(options, connection);
  try {
    link.socket.send(JSON.stringify({ type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Hello', token: 'short-lived-turn', expiresAt: Date.now()+60_000 }));
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 1);
    channel.notification({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'reply', delta: 'Hello back' } });
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 2);
    link.socket.terminate(); await once(link.socket, 'close'); await link.settled();
    channel.notification({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', id: 'reply', text: 'Hello back' } } });
    channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
    link = await connectBridge(options, connection);
    await until(async () => await reportPosition(nats.store, 'test', 'computer') === 4);
    const reports = (await chatHistory(nats.store, 'test', 'conversation')).flatMap(r => r.event.report ? [r.event.report.sequence] : []);
    expect(reports).toEqual([1, 2, 3, 4]);
  } finally { link.socket.terminate(); await channel.close(); server.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);
