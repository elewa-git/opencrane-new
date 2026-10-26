import { createServer, request, IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { proxy } from '../src/proxy.ts';
import { proxyControl } from '../src/proxy-control.ts';

const tools = [{ key: 'oc_0123456789', serverId: 'fixture', connectionId: 'fixture',
  definitions: ['{"name":"read","inputSchema":{"type":"object"}}'],
  modes: { read: 'allow' } }];
const first = { turnId: 'turn-A', conversation: 'same-chat', generation: 1,
  inputGeneration: 1, expires: Date.now() + 120_000 };
const privateResult = 'fixture-private-result';
const approvalId = 'c'.repeat(64);

async function fixture(approvalDriver?: Parameters<typeof proxy>[3]) {
  const directory = mkdtempSync(`${tmpdir()}/private-proxy-`);
  const received: string[] = [];
  let held = false;
  let approvalRequired = false;
  function hold() { held = true; }
  function requireApproval() { approvalRequired = true; }
  function upstream(incoming: IncomingMessage, response: ServerResponse) {
    received.push(incoming.url ?? '');
    incoming.resume();
    if (approvalRequired && !incoming.headers['x-opencrane-approval-id']) {
      response.writeHead(403, { 'x-opencrane-decision': 'refused' });
      response.end(JSON.stringify({ reason: 'approval_requested', approvalId }));
      return;
    }
    const reply = { result: { content: [{ type: 'text', text: privateResult }] } };
    if (!held) response.end(JSON.stringify(reply));
  }
  const gateway = createServer(upstream);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const controlSocket = `${directory}/control.sock`;
  const options = { callerPath: `${directory}/caller`, controlSocket, port: 0 };
  const local = await proxy(`http://127.0.0.1:${address.port}`, options,
    undefined, approvalDriver);
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
    const options = { method: 'POST', headers, body: JSON.stringify(body) };
    const response = await fetch(`${local.url}${path}`, options);
    return { status: response.status, text: await response.text() };
  }
  async function close() {
    vi.restoreAllMocks();
    await local.close();
    gateway.closeAllConnections();
    function stopGateway(resolve: () => void) { gateway.close(resolve); }
    await new Promise<void>(stopGateway);
    rmSync(directory, { recursive: true, force: true });
  }
  return { local, control, grant, catalogue, send, received, hold, requireApproval,
    close, callerPath: options.callerPath };
}

async function refusesBorrowedPrivateGrant() {
  const test = await fixture();
  try {
    const ordinary = { ...first, turnId: 'ordinary-turn', expires: Date.now() + 60_000 };
    const key = await test.catalogue(ordinary);
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    // Allow an early binding refusal, but always check the ordinary caller's reply.
    try {
      session.bind('thread-A');
      await test.grant(binding);
    } catch (error) {
      expect(error).toEqual(new Error('Private caller refused'));
    }
    const reply = await test.send(test.local.caller, 'thread-A', 'tools/call', key);
    expect.soft(test.received).toEqual([]);
    expect.soft(reply.text).not.toContain(privateResult);
    expect(reply.text).toContain('"isError":true');
    expect(reply.text).toContain('Nothing was sent');
  } finally { await test.close(); }
}
it('refuses an ordinary catalogue borrowing a private grant before any upstream call',
  refusesBorrowedPrivateGrant);

async function refusesBorrowedPrivateGrantOnApproval() {
  const binding = { ...first, expires: Date.now() + 60_000 };
  function waiting() { return true; }
  async function renew(thread: string) {
    const session = test.local.privateCaller(binding);
    session.bind(thread);
    await test.grant(binding, thread);
  }
  const driver = { waiting, renew };
  const test = await fixture(driver);
  try {
    const ordinary = { ...binding, turnId: 'ordinary-turn' };
    const askTools = [{ ...tools[0]!, modes: { read: 'ask' } }];
    const key = 'b'.repeat(32);
    const catalogue = { ...ordinary, thread: 'thread-A', loadKey: key, tools: askTools };
    await test.control('/catalogue', catalogue);
    await test.grant(ordinary);
    test.local.approvals.resume(true);
    test.requireApproval();
    const pending = test.send(test.local.caller, 'thread-A', 'tools/call', key);
    function held() { expect(test.local.approvals.size).toBe(1); }
    await vi.waitFor(held);
    expect(test.received).toEqual(['/mcp/fixture/fixture']);
    await test.local.approvals.settle(approvalId, 'approved');
    const reply = await pending;
    expect.soft(test.received).toEqual(['/mcp/fixture/fixture']);
    expect.soft(reply.text).not.toContain(privateResult);
    expect(reply.text).toContain('"isError":true');
    expect(reply.text).toContain('Nothing was sent');
  } finally { await test.close(); }
}
it('refuses an approval retry borrowing a private grant without another upstream call',
  refusesBorrowedPrivateGrantOnApproval);

async function isolatesCallers(method: string) {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const other = { ...binding, turnId: 'turn-B', inputGeneration: 2 };
    const alice = test.local.privateCaller(binding);
    const bob = test.local.privateCaller(other);
    expect(readFileSync(test.callerPath, 'utf8')).toBe(test.local.caller);
    expect(alice.caller).not.toBe(bob.caller);
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
    expect(stolen.text).not.toContain(alice.caller);
    expect(guessed.text).not.toContain(bob.caller);
    expect(test.received).toEqual([]);
    const aliceReply = await test.send(alice.caller, 'thread-A', method);
    const bobReply = await test.send(bob.caller, 'thread-B', method, keyB);
    expect(aliceReply.status).toBe(200);
    expect(bobReply.status).toBe(200);
    if (method === 'tools/list' || method === 'server/discover') {
      let expected = 'inputSchema';
      if (method === 'server/discover') expected = 'supportedVersions';
      expect(aliceReply.text).toContain(expected);
      expect(bobReply.text).toContain(expected);
    }
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
      expect(response.status).toBe(401);
      expect(response.text).not.toContain('inputSchema');
    }
    expect(test.received).toEqual([]);
    await expect(test.grant(binding)).rejects.toThrow('refused');
    await expect(test.catalogue(binding)).rejects.toThrow('refused');
    function registerAgain() { test.local.privateCaller(binding); }
    expect(registerAgain).toThrow();
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
    function changeThread() { session.bind('thread-B'); }
    expect(changeThread).toThrow();
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
    const third = { ...binding, turnId: 'turn-C' };
    function registerThird() { test.local.privateCaller(third); }
    expect(registerThird).toThrow();
    await test.control('/catalogue', { ...binding, loadKey: 'a'.repeat(32), tools });
    expect((await test.send(session.caller, '', 'tools/list')).text).toContain('inputSchema');
    expect((await test.send(session.caller, '', 'tools/call')).text).toContain('Nothing was sent');
    expect(test.received).toEqual([]);
    session.close();
    session.close();
    const replacement = test.local.privateCaller(third);
    replacement.close();
    second.close();
    await expect(test.control('/private/register', binding)).rejects.toThrow('refused');
  } finally { await test.close(); }
}
it('bounds private registrations and permits only fixed discovery before binding', limitsAndDiscovery);

async function closesRequests(method: string) {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    session.bind('thread-A');
    await test.catalogue(binding);
    await test.grant(binding);
    test.hold();
    const pending = test.send(session.caller, 'thread-A', method);
    const settled = Promise.allSettled([pending]);
    function sent() { expect(test.received).toHaveLength(1); }
    await vi.waitFor(sent);
    session.close();
    await settled;
    const other = { ...binding, turnId: 'turn-B', inputGeneration: 2 };
    const replacement = test.local.privateCaller(other);
    replacement.bind('thread-A');
    await test.catalogue(other);
    await test.grant(other);
    expect((await test.send(session.caller, 'thread-A', method)).status).toBe(401);
    await expect(test.grant(binding)).rejects.toThrow('refused');
    expect(test.received).toHaveLength(1);
    replacement.close();
  } finally { await test.close(); }
}
it.each(['model', 'tools/call'])(
  'closes an in-flight %s and refuses old authority after replacement', closesRequests);

async function stopsDuringBody() {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    session.bind('thread-A');
    await test.grant(binding);
    const headers = { authorization: `Bearer ${session.caller}`, 'session-id': 'thread-A',
      expect: '100-continue' };
    const outgoing = request(`${test.local.url}/v1/responses`, { method: 'POST', headers });
    const responsePromise = once(outgoing, 'response');
    const reading = once(outgoing, 'continue');
    outgoing.flushHeaders();
    await reading;
    outgoing.write('{"input":');
    await test.control('/drop', { thread: 'thread-A', turnId: binding.turnId });
    outgoing.end('"held"}');
    const responseValues: unknown[] = await responsePromise;
    const response = responseValues[0];
    if (!(response instanceof IncomingMessage)) throw new Error('Missing response');
    response.resume();
    expect(response.statusCode).toBe(403);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it('checks private authority again after reading a delayed model body', stopsDuringBody);

async function losesControlReply() {
  const test = await fixture();
  try {
    const binding = { ...first, expires: Date.now() + 60_000 };
    const session = test.local.privateCaller(binding);
    session.bind('thread-A');
    const socketPath = test.callerPath.replace(/caller$/u, 'control.sock');
    const outgoing = request({ socketPath, path: '/grant', method: 'POST' });
    const replied = once(outgoing, 'response');
    outgoing.end(JSON.stringify({ ...binding, thread: 'thread-A',
      computer: 'fixture-computer', token: 'fixture-pass' }));
    const replyValues: unknown[] = await replied;
    const reply = replyValues[0];
    if (!(reply instanceof IncomingMessage)) throw new Error('Missing reply');
    expect(reply.statusCode).toBe(200);
    // Lose the acknowledgement after installation, then close the uncertain session.
    outgoing.destroy();
    session.close();
    await expect(test.grant(binding)).rejects.toThrow('refused');
    expect((await test.send(session.caller)).status).toBe(401);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it('removes an installed grant even when its control reply is lost', losesControlReply);
