import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { until } from '@opencrane/authz/testing';
import { bridgeChannel } from '../src/channel.ts';
import { record } from '../src/http.ts';
import type { TurnDriver } from '../src/turn-runner.ts';

const gate = { type: 'bridge_gate', takeoverId: 'takeover', generation: 1,
  affectedTurnIds: ['first', 'second'] };

async function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/bridge-gate-`);
  const server = createServer();
  const calls: string[] = [];
  const loaded = new Set<string>();
  const catalogues = new Set<string>();
  const grants = new Set<string>();
  const frames: Record<string, unknown>[] = [];
  let threads = 0;
  function rpc(method: string, params: Record<string, unknown>) {
    const threadId = String(params['threadId'] ?? '');
    calls.push(`${method}:${threadId}`);
    if (method === 'thread/start') {
      const id = `thread-${++threads}`;
      loaded.add(id);
      return Promise.resolve({ thread: { id } });
    }
    if (method === 'thread/unsubscribe') loaded.delete(threadId);
    if (method === 'thread/loaded/list') return Promise.resolve({ data: [...loaded] });
    return Promise.resolve({ turn: { id: `codex-${threadId}` } });
  }
  async function grant(thread: string, _conversation: string, token: string) {
    if (token) grants.add(thread);
    else grants.delete(thread);
  }
  async function catalogue(key: string) { catalogues.add(key); }
  async function dropCatalogue(key: string) { catalogues.delete(key); }
  function credential() { return { value: 'test', expiresAt: Date.now() + 120_000 }; }
  const driver: TurnDriver = { rpc, grant, catalogue, dropCatalogue, credential,
    journal: `${directory}/reports` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  async function connect() {
    const socket = new WebSocket(url, { headers: { 'x-bridge-token': 'test' } });
    function receive(bytes: Buffer) {
      const frame = record(JSON.parse(bytes.toString()));
      frames.push(frame);
      if (frame['type'] === 'agent.turn_started') {
        const ack = { type: 'ack', sequence: frame['sequence'], token: 'fresh',
          expiresAt: Date.now() + 60_000 };
        socket.send(JSON.stringify(ack));
      }
    }
    socket.on('message', receive);
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    return socket;
  }
  const socket = await connect();
  function send(value: unknown) { socket.send(JSON.stringify(value)); }
  function start(id: string) {
    send({ type: 'turn', id, conversationId: id, assistantId: 'assistant',
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 });
  }
  function finish(threadId: string) {
    channel.notification({ method: 'turn/completed', params: { threadId,
      turn: { id: `codex-${threadId}`, status: 'completed' } } });
  }
  function receipt() {
    return frames.find(isReceipt);
  }
  function isReceipt(frame: Record<string, unknown>) { return frame['type'] === 'bridge_quiet'; }
  async function flush() {
    const pong = once(socket, 'pong');
    socket.ping();
    await pong;
  }
  async function close() {
    await channel.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return { driver, channel, calls, loaded, catalogues, grants, frames, socket, connect,
    send, start, finish, receipt, flush, close };
}

async function stopsEveryConversation() {
  const test = await fixture();
  try {
    test.start('first');
    test.start('second');
    function bothRunning() { return test.calls.includes('turn/start:thread-2'); }
    await until(bothRunning);
    test.send(gate);
    function interrupted() { return test.calls.includes('turn/interrupt:thread-2'); }
    await until(interrupted);
    expect(test.calls).toContain('turn/interrupt:thread-1');
    expect(test.grants.size).toBe(0);
    expect(test.catalogues.size).toBe(0);
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-1');
    await test.flush();
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-2');
    await until(test.receipt);
    expect(test.receipt()).toEqual({ ...gate, type: 'bridge_quiet', epoch: expect.any(String),
      interruptedTurnIds: ['first', 'second'], preparingTurnIds: [], runningTurnIds: [],
      loadedThreadIds: [], heldApprovalIds: [], executorProof: 'unavailable',
      browserProof: 'unavailable' });
    expect(test.loaded.size).toBe(0);
    const before = [...test.calls];
    test.start('late');
    test.send({ type: 'file_begin' });
    await test.flush();
    expect(test.calls).toEqual(before);
    test.send({ ...gate, generation: 2 });
    const [code] = await once(test.socket, 'close');
    expect(code).toBe(1008);
  } finally { await test.close(); }
}
it('closes all work before waiting for every terminal completion and unloaded threads',
  stopsEveryConversation);
