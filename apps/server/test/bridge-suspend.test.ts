import { BudgetActor, envelope } from '@opencrane/models';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../../computer/test/server.ts';
import { suspendComputer } from '../../ops/test/server.ts';
import { chatCommand, chatHistory } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { recordReport } from '../src/chat/reports.ts';
import { bridgePod } from './support/bridge-pod.ts';
import { turnCommand } from '../src/chat/turns.ts';

it.each(process.env['BRIDGE_SUSPEND_K3D'] === '1' ? ['local', 'k3d'] : ['local'])('recovers scan head 3, message 4, start report 5, suspend 6 after %s replacement and executes exactly once', async environment => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/bridge-suspend-`);
  const server = createServer(), keys = conversationKeys(`${directory}/keys`);
  const context = { silo: 'test', computerId: 'computer', assistantId: 'assistant' };
  let sequence = 0;
  const append = async (type: string, data = {}) => {
    const event = { id: `${type}-${sequence}`, commandId: `${type}-${sequence}`, type, silo: 'test', subject: 'computer-assistant',
      source: 'opencrane-lifecycle', correlation: {}, principal: { kind: 'system' as const, id: 'test' }, time: new Date().toISOString(), data: { computerId: context.computerId, assistantId: context.assistantId, ...data } };
    const result = await nats.store.append({ event, expectedSequence: sequence });
    if (result.status !== 'appended') throw new Error(`Append failed ${type}`); sequence = result.sequence; return event;
  };
  await append('computer.claimed', { generation: 1, tokenId: 'token:first' });
  const ready = await append('computer.ready', { generation: 1, podUid: 'first' });
  keys.provision('test', 'conversation');
  await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create', conversationId: 'conversation', assistantId: 'assistant' });
  expect(await nats.store.head()).toBe(3); // The idle scan saw no message.
  await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message', conversationId: 'conversation', text: 'Run once' });
  let runs = 0;
  function credential() {
    return { value: 'computer', expiresAt: Date.now() + 600_000 };
  }
  function grant() { return Promise.resolve(); }
  function rpc(method: string) {
    if (method === 'turn/start') runs++;
    if (method === 'thread/loaded/list') return Promise.resolve({ data: [] });
    return Promise.resolve({ thread: { id: 'thread' } });
  }
  const driver = { journal: `${directory}/reports`, credential, grant, rpc };
  const pod = environment === 'k3d' ? await bridgePod() : undefined;
  let channel = bridgeChannel(server, driver);
  const executions = async () => pod ? pod.runs() : runs;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const connect = async () => { const ws = new WebSocket(`${pod ? pod.url.replace('http:', 'ws:') : `ws://127.0.0.1:${address.port}`}/bridge`, { headers: { 'x-bridge-token': 'computer' } }); await once(ws, 'open'); return ws; };
  let socket = await connect();
  const input = { type: 'turn', id: 'message', conversationId: 'conversation', assistantId: 'assistant', text: 'Run once', token: 'unused', expiresAt: Date.now()+120_000 };
  try {
    const first = new Promise<unknown>(resolve => socket.once('message', resolve)); socket.send(JSON.stringify({ type: 'resume', since: 0 })); socket.send(JSON.stringify(input));
    const raw = await first;
    if (!Buffer.isBuffer(raw)) throw new Error('Missing report');
    await recordReport(nats.store, keys, context, JSON.parse(raw.toString()) as unknown);
    expect(await nats.store.head()).toBe(5);
    await suspendComputer(nats.store, { ...context, latest: ready });
    expect(await nats.store.head()).toBe(6);
    await expect(turnCommand(nats.store, context, { conversationId: 'conversation', turnId: 'message', threadId: 'thread', status: 'started' })).rejects.toThrow('not ready');
    expect(await executions()).toBe(0);
    socket.terminate(); await channel.close(); await pod?.replace(); // Pod replacement retains the journal.
    channel = bridgeChannel(server, driver);
    await new BudgetActor(nats.store, 'test').start(2000, 20000, 'personal-default');
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-assistant', 'assistant.created', { assistantId: 'assistant', ownerId: 'alice', kind: 'personal' }) });
    const joined = envelope('test', 'member-alice', 'member.joined', {
      memberId: 'alice', role: 'member', email: 'alice@example.test',
      displayName: 'Alice', invitationId: 'invite-alice',
    });
    await nats.seed([joined]);
    sequence = 6;
    await append('computer.resumed', { generation: 1, tokenId: 'token:second' });
    const replacement = await append('computer.ready', { generation: 1, podUid: 'second' });
    socket = await connect();
    const reports: string[] = [];
    socket.on('message', bytes => {
      const report = z.object({ type: z.string(), sequence: z.number() }).parse(JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString() : '') as unknown);
      reports.push(report.type);
      socket.send(JSON.stringify({ type: 'ack', sequence: report.sequence, token: 'fresh', expiresAt: Date.now()+120_000 }));
    });
    await turnCommand(nats.store, context, { conversationId: 'conversation', turnId: 'message', threadId: 'thread', status: 'started' });
    await suspendComputer(nats.store, { ...context, latest: replacement });
    const computerEvents = []; for await (const row of nats.store.readStream('computer-assistant')) computerEvents.push(row);
    expect(computerEvents.at(-1)?.event.type).toBe('computer.turn_started');
    socket.send(JSON.stringify({ type: 'resume', since: 1 })); socket.send(JSON.stringify(input));
    await until(async () => reports.includes('agent.turn_failed') || await executions() > 0, 5000);
    expect(reports).not.toContain('agent.turn_failed'); expect(await executions()).toBe(1);
    socket.send(JSON.stringify(input));
    if (pod) await pod.complete();
    else channel.notification({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
    await until(() => reports.includes('agent.turn_completed'));
    expect(await executions()).toBe(1);
    expect((await chatHistory(nats.store, 'test', 'conversation')).some(r => r.event.type === 'agent.turn_failed')).toBe(false);
  } finally { socket.terminate(); await channel.close(); server.close(); await pod?.close(); await nats.close(); await rm(directory, { recursive: true, force: true }); }
}, 240_000);
