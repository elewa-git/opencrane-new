import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { proxy } from '../src/proxy.ts';

const definition = JSON.stringify({ name: 'read', inputSchema: { type: 'object' } });
const tools = [{ key: 'oc_0123456789', serverId: 'server', connectionId: 'installed',
  definitions: [definition], serverInfo: { name: 'Reviewed', version: '1' } }];
const metadata = { threadId: 'thread-A', callId: 'call',
  'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
const call = { jsonrpc: '2.0', id: 7, method: 'tools/call',
  params: { name: 'read', arguments: { number: 1.0 }, _meta: metadata } };
const loadA = 'a'.repeat(32);
const loadB = 'b'.repeat(32);

async function fixture() {
  const directory = mkdtempSync(`${tmpdir()}/mcp-proxy-`);
  const received: { raw: string; headers: IncomingMessage['headers']; url: string | undefined }[] = [];
  let status = 200;
  let marked = false;
  let drop = false;
  let partial = false;
  let reply = '{"jsonrpc":"2.0","id":7,"result":{"content":[]}}';
  async function receive(incoming: IncomingMessage, response: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const data of incoming) {
      const chunk: unknown = data;
      if (!Buffer.isBuffer(chunk)) throw new Error('Expected bytes');
      chunks.push(chunk);
    }
    received.push({ raw: Buffer.concat(chunks).toString(), headers: incoming.headers,
      url: incoming.url });
    if (drop) { incoming.socket.destroy(); return; }
    if (partial) {
      response.writeHead(200);
      response.write('{"jsonrpc":');
      function disconnectReply() { response.destroy(); }
      setTimeout(disconnectReply, 10);
      return;
    }
    response.statusCode = status;
    if (marked) response.setHeader('x-opencrane-decision', 'refused');
    response.end(reply);
  }
  function handle(incoming: IncomingMessage, response: ServerResponse) {
    void receive(incoming, response);
  }
  const gateway = createServer(handle);
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('Missing gateway');
  const controlSocket = `${directory}/control.sock`;
  const local = await proxy(`http://127.0.0.1:${address.port}`,
    { callerPath: `${directory}/caller`, controlSocket, port: 0 });
  async function control(path: string, input: unknown) {
    function send(resolve: (status: number | undefined) => void, reject: (error: Error) => void) {
      function accept(response: IncomingMessage) {
        response.resume();
        function end() { resolve(response.statusCode); }
        response.on('end', end);
      }
      const outgoing = request({ socketPath: controlSocket, path, method: 'POST' }, accept);
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify(input));
    }
    return new Promise(send);
  }
  async function catalogue(loadKey = loadA, conversation = 'chat-A', thread = 'thread-A',
    listedTools = tools) {
    expect(await control('/catalogue', { loadKey, conversation, thread, tools: listedTools })).toBe(200);
  }
  async function grant(thread = 'thread-A', conversation = 'chat-A') {
    const input = { thread, conversation, computer: 'computer', token: `token-${thread}`,
      expires: Date.now() + 60_000 };
    expect(await control('/grant', input)).toBe(200);
  }
  async function send(body = call, extra = {}, loadKey = loadA, method = 'POST') {
    const headers = { authorization: `Bearer ${local.caller}`,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': body.method,
      'mcp-name': body.params.name, ...extra };
    const raw = JSON.stringify(body).replace('"number":1', '"number":1.0');
    const options: RequestInit = { method, headers };
    if (method !== 'GET') options.body = raw;
    const response = await fetch(`${local.url}/mcp/${loadKey}/${tools[0]!.key}`, options);
    const text = await response.text();
    return { status: response.status, text, raw };
  }
  async function sendRaw(raw: string) {
    const headers = { authorization: `Bearer ${local.caller}`,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' };
    const options = { method: 'POST', headers, body: raw };
    const response = await fetch(`${local.url}/mcp/${loadA}/${tools[0]!.key}`, options);
    await response.text();
    return response.status;
  }
  function answer(code: number, marker = false, text = '{"reason":"policy_block"}') {
    status = code; marked = marker; reply = text;
  }
  function disconnect() { drop = true; }
  function partialReply() { partial = true; }
  async function close() {
    vi.restoreAllMocks();
    await local.close();
    gateway.closeAllConnections();
    gateway.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return { catalogue, grant, send, sendRaw, control, answer, disconnect, partialReply, close, received };
}

async function discoveryIsPrivate() {
  const test = await fixture();
  try {
    await test.catalogue();
    const other = [{ ...tools[0]!, definitions: ['{"name":"private_other"}'] }];
    await test.catalogue(loadB, 'chat-B', 'thread-B', other);
    const discovery = { ...call, method: 'server/discover', params: { ...call.params, name: '' } };
    const result = await test.send(discovery);
    expect(JSON.parse(result.text)).toEqual({ jsonrpc: '2.0', id: 7, result: {
      resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} },
      serverInfo: { name: 'Reviewed', version: '1' }, ttlMs: 60000, cacheScope: 'private',
    } });
    const list = { ...discovery, method: 'tools/list' };
    expect((await test.send(list)).text).toContain('"name":"read"');
    expect((await test.send(list)).text).not.toContain('private_other');
    expect((await test.send(list, {}, loadB)).text).toContain('private_other');
    expect(test.received).toEqual([]);
    expect(await test.control('/catalogue/drop', { loadKey: loadA })).toBe(200);
    expect((await test.send(list)).text).toContain('Unknown tool list');
  } finally { await test.close(); }
}
it('answers discovery from only that load and refuses a dropped list', discoveryIsPrivate);

async function refusesOutsideList(kind: string) {
  const test = await fixture();
  try {
    await test.catalogue();
    await test.grant();
    await test.grant('thread-B', 'chat-B');
    let body = call;
    if (kind === 'same-conversation-thread') await test.grant('thread-B', 'chat-A');
    if (kind === 'thread' || kind === 'same-conversation-thread') body = { ...call, params: { ...call.params,
      _meta: { ...metadata, threadId: 'thread-B' } } };
    if (kind === 'tool') body = { ...call, params: { ...call.params, name: 'unlisted' } };
    if (kind === 'conversation') await test.grant('thread-A', 'chat-B');
    if (kind === 'ended') await test.control('/drop', { thread: 'thread-A' });
    if (kind === 'expired') {
      const clock = Date.now() + 61_000;
      vi.spyOn(Date, 'now').mockReturnValue(clock);
    }
    const result = await test.send(body);
    expect(result.status).toBe(200);
    expect(result.text).toContain('"isError":true');
    expect(result.text).toContain('Nothing was sent');
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it.each(['thread', 'same-conversation-thread', 'tool', 'conversation', 'ended', 'expired'])(
  'refuses a call with another %s or no live turn without sending it', refusesOutsideList);

async function forwardsExactly() {
  const test = await fixture();
  try {
    await test.catalogue();
    await test.grant();
    const result = await test.send(call, { 'x-opencrane-decision': 'refused', 'x-secret': 'private' });
    expect(result.status).toBe(200);
    expect(test.received).toHaveLength(1);
    expect(test.received[0]).toMatchObject({ raw: result.raw, url: '/mcp/server/installed',
      headers: { authorization: 'Bearer computer', 'x-turn-token': 'token-thread-A',
        'session-id': 'thread-A', 'mcp-name': 'read' } });
    expect(test.received[0]!.headers).not.toHaveProperty('x-secret');
    expect(test.received[0]!.headers).not.toHaveProperty('x-opencrane-decision');
    await test.catalogue(loadB, 'chat-B', 'thread-B');
    await test.grant('thread-B', 'chat-B');
    const otherCall = { ...call, params: { ...call.params,
      _meta: { ...metadata, threadId: 'thread-B' } } };
    await test.send(otherCall, {}, loadB);
    expect(test.received[1]!.headers).toMatchObject({ 'session-id': 'thread-B',
      'x-turn-token': 'token-thread-B' });
  } finally { await test.close(); }
}
it('forwards unchanged bytes with only that thread grant and allowed headers', forwardsExactly);

async function refusalWording(kind: string) {
  const test = await fixture();
  try {
    await test.catalogue();
    await test.grant();
    if (kind === 'marked') test.answer(403, true);
    if (kind === 'error') test.answer(403, true, '{"error":"Request refused"}');
    if (kind === 'forged') test.answer(403);
    if (kind === 'unavailable') test.answer(502);
    if (kind === 'dropped') test.disconnect();
    if (kind === 'partial') test.partialReply();
    const result = await test.send();
    expect(result.text).toContain('"isError":true');
    if (kind === 'marked' || kind === 'error') {
      expect(result.text).toContain('Nothing was sent to the tool');
      expect(result.text).toContain(kind === 'marked' ? 'policy_block' : 'Request refused');
    } else {
      expect(result.text).toContain('may have received');
      expect(result.text).not.toContain('Nothing was sent');
    }
    expect(test.received).toHaveLength(1);
  } finally { await test.close(); }
}
it.each(['marked', 'error', 'forged', 'unavailable', 'dropped', 'partial'])(
  'reports a %s reply honestly and never sends it again', refusalWording);

async function rejectsProtocol(kind: string) {
  const test = await fixture();
  try {
    await test.catalogue();
    await test.grant();
    let extra: Record<string, string> = {};
    let body = call;
    let method = 'POST';
    if (kind === 'caller') extra = { authorization: '' };
    if (kind === 'session') extra = { 'mcp-session-id': 'session' };
    if (kind === 'version') extra = { 'mcp-protocol-version': '2025-06-18' };
    if (kind === 'meta') body = { ...call, params: { ...call.params,
      _meta: { ...metadata, 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } } };
    if (kind === 'method') extra = { 'mcp-method': 'tools/list' };
    if (kind === 'name') extra = { 'mcp-name': 'write' };
    if (kind === 'initialize') body = { ...call, method: 'initialize' };
    if (kind === 'size') body = { ...call, params: { ...call.params,
      _meta: { ...metadata, callId: 'x'.repeat(1024 * 1024) } } };
    if (kind === 'GET' || kind === 'DELETE') method = kind;
    const result = await test.send(body, extra, loadA, method);
    expect(result.status).toBe(kind === 'caller' ? 401 : 400);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it.each(['caller', 'session', 'version', 'meta', 'method', 'name', 'initialize', 'size', 'GET', 'DELETE'])(
  'refuses %s before forwarding', rejectsProtocol);

async function resetsDeadline() {
  const test = await fixture();
  try {
    const clock = Date.now() + 601_000;
    vi.spyOn(Date, 'now').mockReturnValue(clock);
    expect((await test.send()).status).toBe(401);
    await test.catalogue();
    const discovery = { ...call, method: 'tools/list' };
    expect((await test.send(discovery)).status).toBe(200);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it('renews the caller deadline on catalogue registration before any grant', resetsDeadline);

async function refusesNonObjects(raw: string) {
  const test = await fixture();
  try {
    await test.catalogue();
    expect(await test.sendRaw(raw)).toBe(400);
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it.each(['[]', 'null', '123', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":null}'])(
  'refuses a non-object request or params: %s', refusesNonObjects);

async function replacedLoadIsUnavailable() {
  const test = await fixture();
  try {
    await test.catalogue();
    await test.catalogue(loadB, 'chat-A', 'thread-A');
    const list = { ...call, method: 'tools/list' };
    expect((await test.send(list)).text).toContain('Unknown tool list');
    expect((await test.send(list, {}, loadB)).text).toContain('"name":"read"');
    expect(test.received).toEqual([]);
  } finally { await test.close(); }
}
it('refuses an older address as soon as the same conversation registers a replacement',
  replacedLoadIsUnavailable);
