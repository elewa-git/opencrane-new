import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { proxy } from '../src/proxy.ts';
import { proxyControl } from '../src/proxy-control.ts';

const tools = [{ key: 'oc_0123456789', serverId: 'fixture', connectionId: 'fixture',
  definitions: ['{"name":"read","inputSchema":{"type":"object"}}'],
  modes: { read: 'allow' } }];
const first = { turnId: 'turn-A', conversation: 'same-chat', generation: 1,
  inputGeneration: 1, expires: Date.now() + 120_000 };

async function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/private-proxy-`);
  const received: string[] = [];
  function upstream(incoming: IncomingMessage, response: ServerResponse) {
    received.push(incoming.url ?? '');
    incoming.resume();
    response.end('{"result":{"content":[]}}');
  }
  const gateway = createServer(upstream);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const controlSocket = `${directory}/control.sock`;
  const options = { callerPath: `${directory}/caller`, controlSocket, port: 0 };
  const local = await proxy(`http://127.0.0.1:${address.port}`, options);
  function control(path: string, input: unknown) {
    return proxyControl(path, input, controlSocket);
  }
  async function grant(binding = first, thread = 'thread-A') {
    const input = { ...binding, thread, computer: 'fixture-computer', token: 'fixture-pass' };
    await control('/grant', input);
  }
  async function catalogue(binding = first, thread: string | undefined = 'thread-A') {
    const loadKey = binding.turnId === 'turn-A' ? 'a'.repeat(32) : 'b'.repeat(32);
    await control('/catalogue', { ...binding, thread, loadKey, tools });
    return loadKey;
  }
  async function send(caller: string, thread = 'thread-A', method = 'model', key = 'a'.repeat(32)) {
    let path = '/v1/responses';
    const metadata = { threadId: thread,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
    const body = { jsonrpc: '2.0', id: 1, method,
      params: { name: 'read', arguments: {}, _meta: metadata } };
    if (method !== 'model') path = `/mcp/${key}/oc_0123456789`;
    const headers = { authorization: `Bearer ${caller}`, 'session-id': thread,
      'mcp-method': method, 'mcp-name': 'read', 'mcp-protocol-version': '2026-07-28' };
    const response = await fetch(`${local.url}${path}`,
      { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: response.status, text: await response.text() };
  }
  async function close() {
    vi.restoreAllMocks();
    await local.close();
    gateway.closeAllConnections();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
  return { local, control, grant, catalogue, send, received, close };
}

async function isolatesCallers(method: string) {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const other = { ...binding, turnId: 'turn-B', inputGeneration: 2 };
    const alice = test.local.privateCaller(binding);
    const bob = test.local.privateCaller(other);
    alice.bind('thread-A');
    bob.bind('thread-B');
    await test.catalogue(binding);
    const keyB = await test.catalogue(other, 'thread-B');
    await test.grant(binding);
    await test.grant(other, 'thread-B');
    const guessed = await test.send(test.local.caller, 'thread-A', method);
    expect(guessed.text).not.toContain('inputSchema');
    expect(test.received).toEqual([]);
    const stolen = await test.send(alice.caller, 'thread-B', method, keyB);
    expect(stolen.text).not.toContain('inputSchema');
    expect(test.received).toEqual([]);
    expect((await test.send(alice.caller, 'thread-A', method)).status).toBe(200);
    expect((await test.send(bob.caller, 'thread-B', method, keyB)).status).toBe(200);
    if (method === 'model' || method === 'tools/call') expect(test.received).toHaveLength(2);
    else expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it.each(['model', 'server/discover', 'tools/list', 'tools/call'])(
  'isolates two private callers in one conversation for %s', isolatesCallers);

async function refusesOldAuthority(reason: string) {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    session.bind('thread-A');
    await test.catalogue(binding);
    await test.grant(binding);
    if (reason === 'expired') vi.spyOn(Date, 'now').mockReturnValue(binding.expires);
    else if (reason === 'stopped') {
      await test.control('/drop', { thread: 'thread-A', turnId: binding.turnId });
    } else session.close();
    for (const method of ['model', 'tools/list', 'tools/call']) {
      const response = await test.send(session.caller, 'thread-A', method);
      expect(response.text).not.toContain('inputSchema');
    }
    expect(test.received).toEqual([]);
    await expect(test.grant(binding)).rejects.toThrow('refused');
    await expect(test.catalogue(binding)).rejects.toThrow('refused');
    expect(() => test.local.privateCaller(binding)).toThrow();
  } finally { await test.close(); }
}
it.each(['expired', 'stopped', 'closed'])(
  'refuses %s callers and late catalogue or grant installation', refusesOldAuthority);

async function refusesChangedBinding(field: string) {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    session.bind('thread-A');
    const changed: Record<string, unknown> = { ...binding, thread: 'thread-A',
      computer: 'fixture-computer', token: 'fixture-pass' };
    changed[field] = field === 'generation' || field === 'inputGeneration' ? 2 : 'wrong';
    await expect(test.control('/grant', changed)).rejects.toThrow('refused');
    expect(() => session.bind('thread-B')).toThrow();
    expect((await test.send(session.caller)).status).toBe(403);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it.each(['turnId', 'conversation', 'thread', 'generation', 'inputGeneration'])(
  'refuses a changed private %s before sending upstream', refusesChangedBinding);

async function limitsAndDiscovery() {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    const other = { ...binding, turnId: 'turn-B' };
    const second = test.local.privateCaller(other);
    expect(() => test.local.privateCaller({ ...binding, turnId: 'turn-C' })).toThrow();
    await test.control('/catalogue', { ...binding, loadKey: 'a'.repeat(32), tools });
    expect((await test.send(session.caller, '', 'tools/list')).text).toContain('inputSchema');
    expect((await test.send(session.caller, '', 'tools/call')).text).toContain('Nothing was sent');
    expect(test.received).toEqual([]);
    session.close();
    session.close();
    const replacement = test.local.privateCaller({ ...binding, turnId: 'turn-C' });
    replacement.close();
    second.close();
    await expect(test.control('/private/register', binding)).rejects.toThrow('refused');
  } finally { await test.close(); }
}
it('bounds private registrations and permits only fixed discovery before binding', limitsAndDiscovery);
