import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { expect, vi } from 'vitest';
import { privateCallers } from '@opencrane/models/private-callers';
import { privateCatalogue, privateToolOffer, checkPrivateTurnTools }
  from '../../server/test/support/private-catalogue.ts';
import { acceptPrivateLaunch } from '../src/private-launch.ts';
import { privateLaunchContext } from '../src/private-launch-context.ts';
import { openPrivateSession } from '../src/private-session.ts';
import { approvalHolds } from '../src/approval-holds.ts';
import { mcpProxy } from '../src/mcp-proxy.ts';
import { threadLoads } from '../src/thread-loads.ts';
import { parseTurn, type ToolServer } from '../src/turn-frame.ts';
import { record } from '../src/http.ts';

export async function preflightFixture() {
  const directory = mkdtempSync(`${tmpdir()}/recall-preflight-`);
  const socketPath = `${directory}/native.sock`;
  const launchKey = 'a'.repeat(64);
  const received: string[] = [];
  const sessions: Awaited<ReturnType<typeof openPrivateSession>>[] = [];
  const registrations = new Map<string, ReturnType<ReturnType<typeof privateCallers>['register']>>();
  const resume = Promise.withResolvers<void>();
  let holdDiscovery = false;
  let loseReload = false;
  function waiting() { return false; }
  function renew() { return Promise.reject(new Error('No grant')); }
  const approvals = approvalHolds({ waiting, renew });
  const mcp = mcpProxy('http://127.0.0.1:1', new Map(), approvals);
  function dropped(turnId: string) { mcp.dropTurn(turnId); }
  const callers = privateCallers(dropped);
  function register(binding: Parameters<typeof callers.register>[0]) {
    const registration = callers.register(binding);
    registrations.set(binding.turnId, registration);
    return registration;
  }
  async function receiveMcp(request: IncomingMessage, response: ServerResponse) {
    const caller = callers.identify(request.headers.authorization ?? '');
    function permits(turnId: string, thread?: string) {
      return callers.permits(caller, turnId, thread);
    }
    await mcp.handle(request, response, permits);
  }
  function handleMcp(request: IncomingMessage, response: ServerResponse) {
    function failed() { response.destroy(); }
    void receiveMcp(request, response).catch(failed);
  }
  const listener = createServer(handleMcp);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const origin = `http://127.0.0.1:${address.port}`;
  async function send(endpoint: string, caller: string, method = 'tools/list') {
    const headers = { authorization: `Bearer ${caller}`, 'mcp-method': method,
      'mcp-protocol-version': '2026-07-28' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method });
    const options = { method: 'POST', headers, body };
    const response = await fetch(origin + new URL(endpoint).pathname, options);
    return record(await response.json());
  }
  let nextThread = 0;
  async function native(socket: net.Socket) {
    const caller = await acceptPrivateLaunch(socket, launchKey);
    const thread = { id: `returned-native-${++nextThread}`, ephemeral: true,
      path: null, environments: [] };
    let endpoint = '';
    const lines = createInterface({ input: socket });
    async function receive(line: string) {
      const request = record(JSON.parse(line));
      if (request['id'] === undefined) return;
      const method = String(request['method']);
      received.push(method);
      let result: unknown = {};
      if (method === 'thread/start') {
        const params = record(request['params']);
        const config = record(params['config'] ?? {});
        const servers = record(config['mcp_servers'] ?? {});
        const server = Object.values(servers)[0];
        if (server) {
          endpoint = String(record(server)['url']);
          expect(await send(endpoint, caller, 'server/discover')).toHaveProperty('error');
        }
        result = { thread };
      }
      if (method === 'config/mcpServer/reload' && loseReload) {
        socket.destroy();
        return;
      }
      if (method === 'mcpServerStatus/list' && endpoint) {
        if (holdDiscovery) await resume.promise;
        await send(endpoint, caller, 'server/discover');
        result = await send(endpoint, caller);
      }
      if (method === 'thread/loaded/list') result = { data: [] };
      socket.write(JSON.stringify({ id: request['id'], result }) + '\n');
    }
    function line(value: string) {
      function failed() { socket.destroy(); }
      void receive(value).catch(failed);
    }
    lines.on('line', line);
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
  function notification() { /* No model turn runs in this fixture. */ }
  async function open(id = 'first') {
    const identity = { turnId: id, conversation: 'chat', generation: 1,
      inputGeneration: 1, expires: Date.now() + 60_000 };
    const launch = { ...identity, abort: new AbortController() };
    const options = { runtimeProxy: { privateCaller: register }, generation: 1,
      launchKey, initialiseParams: {}, notification };
    function start() { return openPrivateSession(options); }
    const session = await privateLaunchContext.run(launch, start);
    sessions.push(session);
    const registration = registrations.get(id)!;
    const owner = { ...identity, caller: registration.caller, registration,
      authority: callers, session };
    return { owner, session, abort: launch.abort };
  }
  function rpc() { return Promise.reject(new Error('Ordinary RPC refused')); }
  function catalogue(loadKey: string, conversation: string, tools: ToolServer[],
    thread: string | undefined, turnId: string, generations?: object) {
    const input = { loadKey, conversation, tools, thread, turnId, ...generations };
    expect(callers.check(input)).toBe(true);
    mcp.catalogue(input, true);
    return Promise.resolve();
  }
  function dropCatalogue(loadKey: string) { mcp.drop({ loadKey }); return Promise.resolve(); }
  function discovered(loadKey: string) { return mcp.discovered({ loadKey }); }
  const loads = threadLoads({ rpc, catalogue, dropCatalogue, discovered });
  async function prepare(id = 'first') {
    const opened = await open(id);
    const input = parseTurn({ id, conversationId: 'chat', assistantId: 'assistant',
      requesterId: 'alice', executionMode: 'restricted', text: 'Hello', token: 'fixture',
      expiresAt: opened.owner.expires, tools: privateToolOffer('recall') });
    const started = await loads.startPrivate(input, opened.owner);
    const thread = String(record(started['thread'])['id']);
    const grant = { turnId: id, conversation: input.conversationId,
      generation: 1, inputGeneration: 1, expires: input.expiresAt,
      silo: 'test', requesterId: 'alice',
      assistantId: 'assistant', computerId: 'computer', thread };
    const approved = await privateCatalogue(callers, opened.owner.caller, grant);
    const binding = { ...opened.owner, grant, tools: approved.tools,
      checkTools: checkPrivateTurnTools };
    function load() { return loads.loadPrivate(input, binding); }
    return { ...opened, input, binding, load };
  }
  async function close() {
    resume.resolve();
    await loads.stop();
    for (const session of sessions) {
      session.close();
      await session.closed;
    }
    callers.close();
    approvals.stop();
    replacement.mockRestore();
    const closed = once(server, 'close');
    server.close();
    await closed;
    listener.closeAllConnections();
    function finish(resolve: () => void) { listener.close(resolve); }
    await new Promise<void>(finish);
    rmSync(directory, { recursive: true, force: true });
  }
  function pauseDiscovery() { holdDiscovery = true; }
  function dropReloadReply() { loseReload = true; }
  return { open, prepare, received, callers, loads, mcp, close, pauseDiscovery,
    resume: resume.resolve, dropReloadReply };
}
