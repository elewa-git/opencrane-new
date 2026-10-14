import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { bridgeChannel } from '../src/channel.ts';
import { record } from '../src/http.ts';
import type { TurnDriver } from '../src/turn-runner.ts';

export async function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/bridge-gate-`);
  const server = createServer();
  const calls: string[] = [];
  const loaded = new Set<string>();
  const catalogues = new Set<string>();
  const grants = new Set<string>();
  const frames: Record<string, unknown>[] = [];
  let threads = 0;
  let acknowledge = true;
  let privateExit = () => {};
  function rpc(method: string, params: Record<string, unknown>) {
    const threadId = typeof params['threadId'] === 'string' ? params['threadId'] : '';
    calls.push(`${method}:${threadId}`);
    if (method === 'thread/start') {
      const id = `thread-${++threads}`;
      loaded.add(id);
      return Promise.resolve({ thread: { id, ephemeral: true, path: null } });
    }
    if (method === 'thread/unsubscribe') loaded.delete(threadId);
    if (method === 'thread/loaded/list') return Promise.resolve({ data: [...loaded] });
    return Promise.resolve({ turn: { id: `codex-${threadId}` } });
  }
  function grant(thread: string, _conversation: string, token: string) {
    if (token) grants.add(thread);
    else grants.delete(thread);
    return Promise.resolve();
  }
  function catalogue(key: string) {
    catalogues.add(key);
    return Promise.resolve();
  }
  function dropCatalogue(key: string) {
    catalogues.delete(key);
    return Promise.resolve();
  }
  function credential() { return { value: 'test', expiresAt: Date.now() + 120_000 }; }
  function privateSession() {
    const lifetime = Promise.withResolvers<void>();
    privateExit = lifetime.resolve;
    return Promise.resolve({ rpc, close: lifetime.resolve, closed: lifetime.promise });
  }
  const driver: TurnDriver = { rpc, grant, catalogue, dropCatalogue, credential, privateSession,
    journal: `${directory}/reports` };
  const channel = bridgeChannel(server, driver);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const url = `ws://127.0.0.1:${address.port}/bridge`;
  async function connect(resume = true) {
    const socket = new WebSocket(url, { headers: { 'x-bridge-token': 'test' } });
    function receive(bytes: Buffer) {
      const frame = record(JSON.parse(bytes.toString()));
      frames.push(frame);
      if (acknowledge && frame['type'] === 'agent.turn_started') {
        const ack = { type: 'ack', sequence: frame['sequence'], token: 'fresh',
          expiresAt: Date.now() + 60_000 };
        socket.send(JSON.stringify(ack));
      }
    }
    socket.on('message', receive);
    await once(socket, 'open');
    if (resume) socket.send(JSON.stringify({ type: 'resume', since: 0 }));
    return socket;
  }
  const socket = await connect();
  function send(value: unknown) { socket.send(JSON.stringify(value)); }
  function start(id: string, executionMode = 'memory_free') {
    send({ type: 'turn', id, conversationId: id, assistantId: 'assistant', executionMode,
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
  async function flush(current = socket) {
    const pong = once(current, 'pong');
    current.ping();
    await pong;
  }
  async function close() {
    await channel.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
  function pauseAcks() { acknowledge = false; }
  function exitPrivate() { privateExit(); }
  return { driver, channel, exitPrivate, pauseAcks, calls, loaded, catalogues, grants, frames, socket, connect,
    send, start, finish, receipt, flush, close };
}

