import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { connectBridge } from '../src/chat/bridge.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { chatCommand } from '../src/chat/commands.ts';

it.each(['count', 'bytes'])('bounds queued report %s while another thread is acknowledged independently', async limit => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/bridge-pressure-`);
  const keys = conversationKeys(directory), server = createServer(), wss = new WebSocketServer({ server });
  for (const conversationId of ['slow', 'fast']) {
    keys.provision('test', conversationId);
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: `create-${conversationId}`, conversationId, assistantId: 'assistant' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: `message-${conversationId}`, conversationId, text: 'Hello' });
  }
  let release!: () => void, writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const append = nats.store.append.bind(nats.store), store = nats.store;
  vi.spyOn(store, 'append').mockImplementation(async command => {
    if (typeof command.event === 'object' && command.event !== null && 'subject' in command.event && command.event.subject === 'conversation-slow') { writes++; await gate; }
    return append(command);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connected = new Promise<import('ws').WebSocket>(resolve => wss.once('connection', resolve));
  const link = await connectBridge({ silo: 'test', store, keys }, { url: `ws://127.0.0.1:${address.port}`, computerId: 'computer', assistantId: 'assistant', bearer: 'test' });
  const socket = await connected;
  const acks: string[] = [];
  socket.on('message', raw => { acks.push(Buffer.isBuffer(raw) ? raw.toString() : ''); });
  const report = (conversationId: string, sequence: number, previousSequence: number, text = 'delta') => JSON.stringify({
    sequence, ...(sequence === 1 ? {} : { previousSequence }), conversationId, turnId: `message-${conversationId}`, assistantId: 'assistant', type: 'agent.message_delta', messageId: 'reply', text,
  });
  try {
    socket.send(report('slow', 1, 0)); await until(() => writes === 1, 1000);
    socket.send(report('fast', 2, 0));
    await until(() => acks.some(raw => raw.includes('"sequence":2')), 1000);
    const closed = new Promise<[number, Buffer]>(resolve => socket.once('close', (code, reason) => resolve([code, reason])));
    const count = limit === 'count' ? 65 : 10, text = limit === 'bytes' ? 'x'.repeat(128_000) : 'delta';
    for (let i = 0; i < count; i++) socket.send(report('slow', i+3, i === 0 ? 1 : i+2, text));
    const [code, reason] = await closed;
    expect(code).toBe(1013); expect(reason.toString()).toBe('Report queue limit');
    expect(writes).toBe(1);
  } finally { release(); link.socket.terminate(); socket.terminate(); await link.settled(); await new Promise<void>(resolve => wss.close(() => resolve())); server.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
});
