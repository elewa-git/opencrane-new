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
import { randomUUID } from 'node:crypto';
import { mcpProxy, type ProxyGrant } from '../src/mcp-proxy.ts';
import { threadLoads } from '../src/thread-loads.ts';
import { parseTurn, type ToolServer } from '../src/turn-frame.ts';
import { record } from '../src/http.ts';

function createProxyFixture(gateway: string) {
  const grants = new Map<string, ProxyGrant>();
  function waiting() {
    return false;
  }
  function renew() {
    return Promise.reject(new Error('No grant'));
  }
  const approvalDriver = { waiting, renew };
  const approvals = approvalHolds(approvalDriver);
  const mcp = mcpProxy(gateway, grants, approvals);
  function dropped(turnId: string) {
    mcp.dropTurn(turnId);
  }
  const callers = privateCallers(dropped);
  const registrations = new Map<string, ReturnType<typeof callers.register>>();
  function register(binding: Parameters<typeof callers.register>[0]) {
    const registration = callers.register(binding);
    registrations.set(binding.turnId, registration);
    return registration;
  }
  return { approvals, mcp, callers, register, registrations };
}

type ProxyFixture = ReturnType<typeof createProxyFixture> & {
  url?: string;
  control?: (path: string, input: unknown) => Promise<void>;
  close?: () => Promise<void>;
};

async function startMcpListener(proxy: ProxyFixture) {
  if (proxy.url && proxy.close) {
    return { send: mcpSender(proxy.url), close: proxy.close };
  }
  const { callers, mcp } = proxy;
  async function receiveMcp(request: IncomingMessage, response: ServerResponse) {
    const caller = callers.identify(request.headers.authorization ?? '');
    function permits(turnId: string, thread?: string) {
      return callers.permits(caller, turnId, thread);
    }
    await mcp.handle(request, response, permits);
  }
  function handleMcp(request: IncomingMessage, response: ServerResponse) {
    function failed() {
      const headers = { 'content-type': 'application/json' };
      const failure = { error: 'Discovery refused' };
      response.writeHead(400, headers);
      response.end(JSON.stringify(failure));
    }
    void receiveMcp(request, response).catch(failed);
  }
  const listener = createServer(handleMcp);
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing fixture address');
  }
  const origin = `http://127.0.0.1:${address.port}`;
  async function close() {
    listener.closeAllConnections();
    function finish(resolve: () => void) {
      listener.close(resolve);
    }
    await new Promise<void>(finish);
  }
  return { send: mcpSender(origin), close };
}

function mcpSender(origin: string) {
  async function send(endpoint: string, caller: string, method = 'tools/list',
    params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) {
    const headers = { ...extraHeaders, authorization: `Bearer ${caller}`, 'mcp-method': method,
      'mcp-protocol-version': '2026-07-28' };
    const metadata = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
    const request = { jsonrpc: '2.0', id: 1, method, params: { _meta: metadata, ...params } };
    const body = JSON.stringify(request);
    const options = { method: 'POST', headers, body };
    const response = await fetch(origin + new URL(endpoint).pathname, options);
    return record(await response.json());
  }
  return send;
}

type NativeMemoryCall = (name: string, args: object, headers: Record<string, string>, callId: string)
  => Promise<Record<string, unknown>>;

function createDiscoveryControls(remember: boolean) {
  const received: string[] = [];
  const resume = Promise.withResolvers<void>();
  const calls = new Map<string, NativeMemoryCall>();
  return { received, resume, calls, remember, holdDiscovery: false, loseReload: false };
}

type DiscoveryControls = ReturnType<typeof createDiscoveryControls>;
type SendMcp = Awaited<ReturnType<typeof startMcpListener>>['send'];

function handleNativeProtocol(
  socket: net.Socket,
  caller: string,
  thread: { id: string; ephemeral: boolean; path: null; environments: never[] },
  send: SendMcp,
  discovery: DiscoveryControls,
) {
  let endpoint = '';
  const lineOptions = { input: socket };
  const lines = createInterface(lineOptions);
  async function receive(line: string) {
    const request = record(JSON.parse(line));
    if (request['id'] === undefined) {
      return;
    }
    const method = String(request['method']);
    discovery.received.push(method);
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
      async function callMemory(name: string, args: object,
        headers: Record<string, string>, callId: string) {
        const metadata = { threadId: thread.id, callId,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
        const params = { name, arguments: args, _meta: metadata };
        const callHeaders = { ...headers, 'mcp-name': name };
        return send(endpoint, caller, 'tools/call', params, callHeaders);
      }
      discovery.calls.set(thread.id, callMemory);
      result = { thread };
    }
    if (method === 'config/mcpServer/reload' && discovery.loseReload) {
      socket.destroy();
      return;
    }
    if (method === 'mcpServerStatus/list' && endpoint) {
      if (discovery.holdDiscovery) {
        await discovery.resume.promise;
      }
      if (socket.destroyed) {
        return;
      }
      await send(endpoint, caller, 'server/discover');
      result = await send(endpoint, caller);
      const offered = record(record(result)['result']);
      const expected: unknown = JSON.parse(privateToolOffer('recall')[0]!.definitions[0]!);
      const expectedTools = [expected];
      if (discovery.remember) {
        const definition: unknown = JSON.parse(privateToolOffer('remember')[0]!.definitions[0]!);
        expectedTools.push(definition);
      }
      expect(offered['tools']).toEqual(expectedTools);
    }
    if (method === 'thread/loaded/list') {
      result = { data: [] };
    }
    const reply = { id: request['id'], result };
    socket.write(JSON.stringify(reply) + '\n');
  }
  function line(value: string) {
    function failed() {
      socket.destroy();
    }
    void receive(value).catch(failed);
  }
  function failed() { socket.destroy(); }
  lines.on('error', failed);
  lines.on('line', line);
  socket.resume();
}

async function startNativeSocket(
  socketPath: string, launchKey: string, send: SendMcp, discovery: DiscoveryControls,
) {
  let nextThread = 0;
  async function native(socket: net.Socket) {
    const caller = await acceptPrivateLaunch(socket, launchKey);
    nextThread += 1;
    const thread = { id: `returned-native-${nextThread}`, ephemeral: true,
      path: null, environments: [] };
    handleNativeProtocol(socket, caller, thread, send, discovery);
  }
  function connected(socket: net.Socket) {
    function failed() {
      socket.destroy();
    }
    socket.on('error', failed);
    void native(socket).catch(failed);
  }
  const server = net.createServer(connected);
  server.listen(socketPath);
  await once(server, 'listening');
  return server;
}

async function redirectPrivateSocket(socketPath: string) {
  const original = await vi.importActual<typeof net>('node:net');
  function connect(...args: Parameters<typeof net.connect>) {
    if (args[0] === '/run/executor/private.sock') {
      return original.connect(socketPath);
    }
    return original.connect(...args);
  }
  const replacement = vi.spyOn(net, 'connect');
  replacement.mockImplementation(connect);
  return replacement;
}

function createSessions(proxy: ProxyFixture, launchKey: string) {
  const sessions: Awaited<ReturnType<typeof openPrivateSession>>[] = [];
  const { register, registrations, callers } = proxy;
  function notification() {
    /* No model turn runs in this fixture. */
  }
  async function open(id = 'first', conversation = 'chat') {
    const identity = { turnId: id, conversation, generation: 1,
      inputGeneration: 1, expires: Date.now() + 60_000 };
    const launch = { ...identity, abort: new AbortController() };
    const options = { runtimeProxy: { privateCaller: register, privateAuthority: callers }, generation: 1,
      launchKey, initialiseParams: {}, notification };
    function start() {
      return openPrivateSession(options);
    }
    const session = await privateLaunchContext.run(launch, start);
    sessions.push(session);
    const registration = registrations.get(id)!;
    const owner = { ...identity, caller: registration.caller, registration,
      authority: callers, session };
    return { owner, session, abort: launch.abort };
  }
  return { open, sessions };
}

function createLoads({ callers, mcp, control }: ProxyFixture) {
  function rpc() {
    return Promise.reject(new Error('Ordinary RPC refused'));
  }
  function catalogue(loadKey: string, conversation: string, tools: ToolServer[],
    thread: string | undefined, turnId: string, generations?: object) {
    const input = { loadKey, conversation, tools, thread, turnId, ...generations };
    if (control) {
      return control('/catalogue', input);
    }
    expect(callers.check(input)).toBe(true);
    mcp.catalogue(input, true);
    return Promise.resolve();
  }
  function dropCatalogue(loadKey: string) {
    const catalogue = { loadKey };
    if (control) {
      return control('/catalogue/drop', catalogue);
    }
    mcp.drop(catalogue);
    return Promise.resolve();
  }
  function discovered(loadKey: string) {
    const catalogue = { loadKey };
    if (control) {
      return control('/catalogue/ready', catalogue);
    }
    return mcp.discovered(catalogue);
  }
  const driver = { rpc, catalogue, dropCatalogue, discovered };
  return { loads: threadLoads(driver), driver };
}

async function prepareApproval(
  id: string,
  open: ReturnType<typeof createSessions>['open'],
  loads: ReturnType<typeof createLoads>['loads'],
  callers: ProxyFixture['callers'],
) {
  const opened = await open(id);
  const request = { id, conversationId: 'chat', assistantId: 'assistant',
    requesterId: 'alice', executionMode: 'restricted', text: 'Hello', token: 'fixture',
    expiresAt: opened.owner.expires, tools: privateToolOffer('recall') };
  const input = parseTurn(request);
  const started = await loads.startPrivate(input, opened.owner);
  const thread = String(record(started['thread'])['id']);
  const grant = { turnId: id, conversation: input.conversationId,
    generation: 1, inputGeneration: 1, expires: input.expiresAt,
    silo: 'test', requesterId: 'alice',
    assistantId: 'assistant', computerId: 'computer', thread };
  const approved = await privateCatalogue(callers, opened.owner.caller, grant);
  const binding = { ...opened.owner, grant, tools: approved.tools,
    checkTools: checkPrivateTurnTools };
  function load() {
    return loads.loadPrivate(input, binding);
  }
  return { ...opened, input, binding, load };
}

function createCleanup(
  directory: string,
  discovery: DiscoveryControls,
  loads: ReturnType<typeof createLoads>['loads'],
  sessions: ReturnType<typeof createSessions>,
  proxy: ProxyFixture,
  replacement: Awaited<ReturnType<typeof redirectPrivateSocket>>,
  server: net.Server,
  endpoint: Awaited<ReturnType<typeof startMcpListener>>,
) {
  async function close() {
    discovery.resume.resolve();
    await loads.stop();
    for (const session of sessions.sessions) {
      session.close();
      await session.closed;
    }
    proxy.callers.close();
    proxy.approvals.stop();
    replacement.mockRestore();
    const closed = once(server, 'close');
    server.close();
    await closed;
    await endpoint.close();
    const removal = { recursive: true, force: true };
    rmSync(directory, removal);
  }
  return close;
}

export async function preflightFixture(gateway = 'http://127.0.0.1:1',
  runtime?: ProxyFixture, remember = false) {
  const directory = mkdtempSync(`${tmpdir()}/recall-preflight-`);
  const socketPath = `${directory}/native.sock`;
  const launchKey = 'a'.repeat(64);
  const proxy = runtime ?? createProxyFixture(gateway);
  const endpoint = await startMcpListener(proxy);
  const { send } = endpoint;
  const discovery = createDiscoveryControls(remember);
  const server = await startNativeSocket(socketPath, launchKey, send, discovery);
  const replacement = await redirectPrivateSocket(socketPath);
  const sessions = createSessions(proxy, launchKey);
  const { loads, driver } = createLoads(proxy);
  const close = createCleanup(
    directory, discovery, loads, sessions, proxy, replacement, server, endpoint,
  );
  function prepare(id = 'first') {
    return prepareApproval(id, sessions.open, loads, proxy.callers);
  }
  function pauseDiscovery() {
    discovery.holdDiscovery = true;
  }
  function dropReloadReply() {
    discovery.loseReload = true;
  }
  async function openCurrent() {
    const launch = privateLaunchContext.getStore()!;
    const opened = await sessions.open(launch.turnId, launch.conversation);
    return opened.session;
  }
  function call(thread: string, name: string, args: object, headers: Record<string, string> = {},
    callId: string = randomUUID()) {
    const nativeCall = discovery.calls.get(thread);
    if (!nativeCall) {
      throw new Error('Native thread has not started');
    }
    return nativeCall(name, args, headers, callId);
  }
  function recall(thread: string, args: object, headers: Record<string, string> = {},
    callId: string = randomUUID()) {
    return call(thread, 'recall', args, headers, callId);
  }
  return { call, recall, open: sessions.open, openCurrent, prepare, received: discovery.received,
    callers: proxy.callers, loads, driver, mcp: proxy.mcp, close, pauseDiscovery,
    resume: discovery.resume.resolve, dropReloadReply };
}
