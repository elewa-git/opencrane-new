import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { privateCallers } from '@opencrane/models/private-callers';
import { acceptPrivateLaunch } from '../src/private-launch.ts';
import { privateLaunchContext } from '../src/private-launch-context.ts';
import { openPrivateSession } from '../src/private-session.ts';
import { record } from '../src/http.ts';

vi.mock('node:net', { spy: true });

async function permitsLoaderDiscovery() {
  const directory = mkdtempSync(`${tmpdir()}/recall-preflight-`);
  const socketPath = `${directory}/native.sock`;
  const launchKey = 'a'.repeat(64);
  const received: string[] = [];
  function dropped() { /* No upstream calls are made during discovery. */ }
  const callers = privateCallers(dropped);
  async function native(socket: net.Socket) {
    await acceptPrivateLaunch(socket, launchKey);
    const lines = createInterface({ input: socket });
    function receive(line: string) {
      const request = record(JSON.parse(line));
      if (request['id'] === undefined) return;
      received.push(String(request['method']));
      let result: unknown = {};
      if (request['method'] === 'thread/start') {
        result = { thread: { id: 'returned-native-id', ephemeral: true,
          path: null, environments: [] } };
      }
      if (request['method'] === 'thread/loaded/list') result = { data: [] };
      const response = { id: request['id'], result };
      socket.write(JSON.stringify(response) + '\n');
    }
    lines.on('line', receive);
    socket.resume();
  }
  function connected(socket: net.Socket) {
    function failed() { socket.destroy(); }
    void native(socket).catch(failed);
  }
  const server = net.createServer(connected);
  server.listen(socketPath);
  await once(server, 'listening');
  const original = await vi.importActual<typeof net>('node:net');
  function connect(...args: Parameters<typeof net.connect>) {
    if (args[0] === '/run/executor/private.sock') return original.connect(socketPath);
    return original.connect(...args);
  }
  const replacement = vi.spyOn(net, 'connect').mockImplementation(connect);
  function notification() { /* This fixture only exercises native discovery. */ }
  const options = { runtimeProxy: { privateCaller: callers.register }, generation: 1,
    launchKey, initialiseParams: {}, notification };
  const launch = { turnId: 'turn', conversation: 'chat', expires: Date.now() + 60_000,
    abort: new AbortController() };
  function open() { return openPrivateSession(options); }
  let session: Awaited<ReturnType<typeof openPrivateSession>> | undefined;
  try {
    session = await privateLaunchContext.run(launch, open);
    await session.rpc('thread/start', {});
    await expect(session.rpc('config/mcpServer/reload', {})).resolves.toEqual({});
    await expect(session.rpc('mcpServerStatus/list', { threadId: 'returned-native-id' }))
      .resolves.toEqual({});
    await expect(session.rpc('thread/loaded/list', {})).resolves.toEqual({ data: [] });
    expect(received).toEqual(['initialize', 'thread/start',
      'config/mcpServer/reload', 'mcpServerStatus/list', 'thread/loaded/list']);
  } finally {
    session?.close();
    if (session) await session.closed;
    callers.close();
    replacement.mockRestore();
    const closed = once(server, 'close');
    server.close();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
}

it('keeps the admitted private session open for native tool discovery', permitsLoaderDiscovery);
