import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { acceptPrivateLaunch } from '../src/private-launch.ts';
import { openPrivateSession } from '../src/private-session.ts';
import { proxy } from '../src/proxy.ts';
import { record } from '../src/http.ts';
import { fixture } from './bridge-gate-fixture.ts';

vi.mock('node:net', { spy: true });

type Computer = Awaited<ReturnType<typeof fixture>>;
type Cancellation = 'Stop' | 'disconnect' | 'socket close';
const launchKey = 'a'.repeat(64);

async function pendingConnections() {
  const directory = mkdtempSync(`${tmpdir()}/private-connect-`);
  const socketPath = `${directory}/native.sock`;
  const sockets: net.Socket[] = [];
  let nextThread = 0;
  async function nativeSession(socket: net.Socket) {
    await acceptPrivateLaunch(socket, launchKey);
    const lines = createInterface({ input: socket });
    function receive(line: string) {
      const message = record(JSON.parse(line));
      if (!message['id']) return;
      let result: unknown = {};
      if (message['method'] === 'thread/start') {
        const id = `native-${++nextThread}`;
        result = { thread: { id, ephemeral: true, path: null, environments: [] } };
      }
      const response = { id: message['id'], result };
      socket.write(JSON.stringify(response) + '\n');
    }
    lines.on('line', receive);
    socket.resume();
  }
  function connected(socket: net.Socket) {
    function failed() { socket.destroy(); }
    void nativeSession(socket).catch(failed);
  }
  const server = net.createServer(connected);
  server.listen(socketPath);
  await once(server, 'listening');
  const options = { callerPath: `${directory}/caller`,
    controlSocket: `${directory}/control.sock`, port: 0 };
  const runtimeProxy = await proxy('http://127.0.0.1:1', options);
  const nativeNet = await vi.importActual<typeof net>('node:net');
  const connect = nativeNet.connect;
  function connectPrivate(...args: Parameters<typeof net.connect>) {
    if (args[0] !== '/run/executor/private.sock') return connect(...args);
    // Hold only the first two connections before the operating system can connect them.
    const socket = sockets.length < 2 ? new net.Socket() : connect(socketPath);
    sockets.push(socket);
    return socket;
  }
  const connection = vi.spyOn(net, 'connect').mockImplementation(connectPrivate);
  let computer: Computer;
  function notification(message: Record<string, unknown>) {
    computer.channel.notification(message);
  }
  function privateSession() {
    const sessionOptions = { runtimeProxy, generation: 1, launchKey,
      initialiseParams: {}, notification };
    return openPrivateSession(sessionOptions);
  }
  try {
    computer = await fixture(true, undefined, privateSession);
  } catch (error) {
    connection.mockRestore();
    await runtimeProxy.close();
    server.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  computer.pauseAcks();
  async function close() {
    connection.mockRestore();
    await computer.close();
    for (const socket of sockets) socket.destroy();
    await runtimeProxy.close();
    const closed = once(server, 'close');
    server.close();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
  return { computer, sockets, close };
}

function stop(socket: WebSocket, turnId: string, conversationId: string) {
  const frame = { type: 'stop', turnId, conversationId };
  socket.send(JSON.stringify(frame));
}

async function cancelConnections(test: Awaited<ReturnType<typeof pendingConnections>>,
  cause: Cancellation) {
  const { computer, sockets } = test;
  if (cause === 'disconnect') {
    const closed = once(computer.socket, 'close');
    computer.socket.terminate();
    await closed;
    return computer.connect();
  }
  for (const id of ['first', 'second']) {
    if (cause === 'Stop') stop(computer.socket, id, id);
  }
  if (cause === 'socket close') {
    for (const socket of sockets) socket.destroy();
  }
  await computer.flush();
  return computer.socket;
}

function startReplacement(socket: WebSocket, conversationId: string) {
  const frame = { type: 'turn', id: `${conversationId}-replacement`, conversationId,
    assistantId: 'assistant', executionMode: 'restricted', text: 'Hello',
    token: 'pending', expiresAt: Date.now() + 60_000 };
  socket.send(JSON.stringify(frame));
}

function isStart(frame: Record<string, unknown>) {
  return frame['type'] === 'agent.turn_started';
}

async function checksReleasedCapacity(computer: Computer, socket: WebSocket) {
  startReplacement(socket, 'first');
  startReplacement(socket, 'second');
  function bothStarted() {
    const starts = computer.frames.filter(isStart);
    expect(starts).toHaveLength(2);
    expect(starts[0]?.['conversationId']).toBe('first');
    expect(starts[1]?.['conversationId']).toBe('second');
  }
  await vi.waitFor(bothStarted);
  // Check repeated cancellation cannot free a slot owned by a replacement turn.
  stop(socket, 'first', 'first');
  stop(socket, 'second', 'second');
  startReplacement(socket, 'third');
  await computer.flush(socket);
  bothStarted();
  stop(socket, 'first-replacement', 'first');
  stop(socket, 'second-replacement', 'second');
  function replacementsEnded() {
    for (const id of ['first', 'second']) {
      function ended(frame: Record<string, unknown>) {
        return frame['type'] === 'agent.turn_failed'
          && frame['turnId'] === `${id}-replacement`;
      }
      expect(computer.frames.filter(ended)).toHaveLength(1);
    }
  }
  await vi.waitFor(replacementsEnded);
}

async function releasesCancelledConnections(cause: Cancellation) {
  const test = await pendingConnections();
  const { computer, sockets } = test;
  try {
    computer.start('first', 'restricted');
    computer.start('second', 'restricted');
    function bothConnecting() { expect(sockets).toHaveLength(2); }
    await vi.waitFor(bothConnecting);
    const socket = await cancelConnections(test, cause);
    function bothEnded() {
      for (const id of ['first', 'second']) {
        function ended(frame: Record<string, unknown>) {
          return frame['type'] === 'agent.turn_failed' && frame['turnId'] === id;
        }
        expect(computer.frames.filter(ended)).toHaveLength(1);
      }
    }
    await vi.waitFor(bothEnded);
    await checksReleasedCapacity(computer, socket);
    const gate = await computer.signedGate();
    socket.send(JSON.stringify(gate));
    function quiet() {
      const expected = { type: 'bridge_quiet', preparingTurnIds: [], runningTurnIds: [],
        loadedThreadIds: [], heldApprovalIds: [] };
      expect(computer.receipt()).toMatchObject(expected);
    }
    await vi.waitFor(quiet);
  } finally {
    await test.close();
  }
}

it.each(['Stop', 'disconnect', 'socket close'] as const)(
  'restores both private slots and bridge quiet after %s before connect',
  releasesCancelledConnections);
