import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { expect, it, vi } from 'vitest';
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
  async function connect() {
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
    socket.send(JSON.stringify({ type: 'resume', since: 0 }));
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

async function stopsEveryConversation() {
  const test = await fixture();
  try {
    test.start('first');
    test.start('second', 'restricted');
    function bothRunning() { return test.calls.includes('turn/start:thread-2'); }
    await until(bothRunning);
    test.send(gate);
    function interrupted() { return test.calls.includes('turn/interrupt:thread-2'); }
    await until(interrupted, 2000);
    expect(test.calls).toContain('turn/interrupt:thread-1');
    expect(test.grants.size).toBe(0);
    expect(test.catalogues.size).toBe(0);
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-1');
    await test.flush();
    expect(test.receipt()).toBeUndefined();
    test.finish('thread-2');
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    expect(test.receipt()).toEqual({ ...gate, type: 'bridge_quiet', epoch: test.receipt()?.['epoch'],
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
    const closed: unknown[] = await once(test.socket, 'close');
    expect(closed[0]).toBe(1008);
  } finally { await test.close(); }
}
it('closes all work before waiting for every terminal completion and unloaded threads',
  stopsEveryConversation);

async function cancelsLoading() {
  const test = await fixture();
  const loading = Promise.withResolvers<unknown>();
  const original = test.driver.rpc.bind(test.driver);
  function rpc(method: string, params: Record<string, unknown>) {
    if (method === 'thread/start') return loading.promise;
    return original(method, params);
  }
  test.driver.rpc = rpc;
  try {
    test.start('first');
    await test.flush();
    test.send(gate);
    await test.flush();
    expect(test.catalogues.size).toBe(0);
    test.loaded.add('late-thread');
    loading.resolve({ thread: { id: 'late-thread' } });
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    expect(test.grants.size).toBe(0);
    expect(test.loaded.size).toBe(0);
    expect(test.calls).not.toContain('turn/start:late-thread');
  } finally { await test.close(); }
}
it('unloads a late preparation without granting or starting it', cancelsLoading);

async function repeatsAfterReconnect() {
  const test = await fixture();
  try {
    test.send(gate);
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
    const epoch = test.receipt()?.['epoch'];
    test.frames.length = 0;
    test.loaded.add('unexpected-thread');
    const socket = await test.connect();
    socket.send(JSON.stringify(gate));
    await until(quiet);
    expect(test.receipt()?.['epoch']).toBe(epoch);
    expect(test.loaded.size).toBe(0);
    expect(test.calls).toContain('thread/unsubscribe:unexpected-thread');
    socket.send(JSON.stringify({ ...gate, takeoverId: 'another' }));
    const closed: unknown[] = await once(socket, 'close');
    expect(closed[0]).toBe(1008);
  } finally { await test.close(); }
}
it('gates an idle computer and repeats inventory checks with the same epoch on reconnect',
  repeatsAfterReconnect);

async function refusesLateGrant(renewal: boolean, installing: boolean) {
  const test = await fixture();
  const pending = Promise.withResolvers<void>();
  let delayed = !renewal && installing;
  let entered = false;
  const grant = test.driver.grant.bind(test.driver);
  async function install(thread: string, conversation: string, token: string, expires: number) {
    if (delayed && token) {
      entered = true;
      await pending.promise;
    }
    await grant(thread, conversation, token, expires);
  }
  test.driver.grant = install;
  try {
    if (!renewal && !installing) test.pauseAcks();
    test.start('first');
    function started() { return test.frames.length > 0; }
    await until(started);
    let refused: Promise<void> | undefined;
    if (renewal) {
      function running() { return test.calls.includes('turn/start:thread-1'); }
      await until(running);
      if (!installing) test.pauseAcks();
      delayed = installing;
      const renewing = test.channel.renew('thread-1');
      if (installing) refused = expect(renewing).resolves.toBeUndefined();
      else refused = expect(renewing).rejects.toThrow('Turn ended');
    }
    function grantPending() { return entered; }
    if (installing) await until(grantPending);
    test.send(gate);
    await test.flush();
    test.send({ type: 'ack', sequence: 1, token: 'late', expiresAt: Date.now() + 60_000 });
    await test.flush();
    if (installing) {
      test.channel.notification({ method: 'thread/closed', params: { threadId: 'thread-1' } });
    }
    pending.resolve();
    await refused;
    await test.flush();
    expect(test.grants.size).toBe(0);
    if (renewal && installing) return;
    if (renewal) test.finish('thread-1');
    function quiet() { return Boolean(test.receipt()); }
    await until(quiet);
  } finally { await test.close(); }
}
it.each([[false, false], [true, false], [false, true], [true, true]])(
  'refuses a late grant with renewal %s and installation %s', refusesLateGrant);

async function doesNotInferQuiet(cause: string) {
  const test = await fixture();
  try {
    test.start('first', 'restricted');
    function running() { return test.calls.includes('turn/start:thread-1'); }
    await until(running);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    test.send(gate);
    await test.flush();
    if (cause === 'thread/closed') {
      test.channel.notification({ method: cause, params: { threadId: 'thread-1' } });
    } else if (cause === 'eof') {
      test.exitPrivate();
    } else {
      test.socket.terminate();
      const reconnected = await test.connect();
      reconnected.send(JSON.stringify(gate));
      await test.flush(reconnected);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    function unavailable() {
      return test.frames.some(isUnavailable);
    }
    function isUnavailable(frame: Record<string, unknown>) {
      return frame['type'] === 'bridge_unavailable';
    }
    await until(unavailable);
    expect(test.receipt()).toBeUndefined();
    if (cause !== 'socket') {
      test.start('late');
      await test.flush();
    }
    expect(test.calls).not.toContain('thread/start:thread-2');
  } finally {
    vi.useRealTimers();
    await test.close();
  }
}
it.each(['thread/closed', 'eof', 'socket'])(
  'returns unavailable at thirty seconds after %s without terminal proof',
  doesNotInferQuiet);
