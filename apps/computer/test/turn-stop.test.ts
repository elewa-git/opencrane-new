import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it } from 'vitest';
import { proxy } from '../src/proxy.ts';
import { proxyControl } from '../src/proxy-control.ts';
import { fixture } from './bridge-gate-fixture.ts';

const tools = [{ key: 'oc_0123456789', serverId: 'server', connectionId: 'installed',
  modes: { read: 'allow' as const }, definitions: ['{"name":"read"}'] }];

async function withinStopDeadline<T>(pending: Promise<T>) {
  const deadline = Promise.withResolvers<never>();
  function expired() { deadline.reject(new Error('Stop deadline expired')); }
  const timer = setTimeout(expired, 2000);
  try {
    return await Promise.race([pending, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopFixture() {
  const computer = await fixture();
  const received: string[] = [];
  const open = new Map<string, ServerResponse>();
  const arrived = Promise.withResolvers<void>();
  const departed = Promise.withResolvers<void>();
  let closed = 0;
  function receive(incoming: IncomingMessage, response: ServerResponse) {
    const thread = String(incoming.headers['session-id']);
    const name = `${thread}:${incoming.url}`;
    received.push(name);
    open.set(name, response);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
    function disconnected() {
      if (thread === 'thread-1' && ++closed === 2) departed.resolve();
    }
    response.on('close', disconnected);
    if (received.length === 4) arrived.resolve();
  }
  const upstream = createServer(receive);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const socketPath = `${computer.driver.journal}.sock`;
  const options = { callerPath: `${computer.driver.journal}.caller`,
    controlSocket: socketPath, port: 0 };
  const local = await proxy(`http://127.0.0.1:${address.port}`, options);
  const lists = new Map<string, string>();
  const started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const revoked = Promise.withResolvers<void>();
  const rpc = computer.driver.rpc.bind(computer.driver);
  function recordRpc(method: string, params: Record<string, unknown>) {
    const result = rpc(method, params);
    if (method === 'turn/start') started.get(String(params['threadId']))?.resolve();
    return result;
  }
  computer.driver.rpc = recordRpc;
  async function grant(thread: string, conversation: string, token: string, expires: number) {
    const path = token ? '/grant' : '/drop';
    const input = { thread, conversation, computer: 'fixture', token, expires };
    await proxyControl(path, input, socketPath);
    if (!token && thread === 'thread-1') revoked.resolve();
  }
  computer.driver.grant = grant;
  async function catalogue(loadKey: string, conversation: string, _tools: unknown, thread?: string) {
    lists.set(conversation, loadKey);
    const input = { loadKey, conversation, thread, tools };
    await proxyControl('/catalogue', input, socketPath);
  }
  async function dropCatalogue(loadKey: string) {
    await proxyControl('/catalogue/drop', { loadKey }, socketPath);
  }
  computer.driver.catalogue = catalogue;
  computer.driver.dropCatalogue = dropCatalogue;
  async function start(name: string, thread: string) {
    const barrier = Promise.withResolvers<void>();
    started.set(thread, barrier);
    computer.start(name);
    await barrier.promise;
    await computer.flush();
  }
  function call(thread: string, conversation: string, model = false) {
    const metadata = { threadId: thread,
      'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'read', arguments: {}, _meta: metadata } };
    const headers = { authorization: `Bearer ${local.caller}`, 'session-id': thread,
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'read' };
    const path = model ? '/v1/responses' : `/mcp/${lists.get(conversation)}/${tools[0]!.key}`;
    const result = Promise.withResolvers<string>();
    function failed() { result.resolve('aborted'); }
    function receive(response: IncomingMessage) {
      const chunks: Buffer[] = [];
      function chunk(bytes: Buffer) { chunks.push(bytes); }
      function end() {
        const bytes = Buffer.concat(chunks);
        result.resolve(`${response.statusCode}:${bytes.toString()}`);
      }
      response.on('data', chunk);
      response.on('end', end);
      response.on('error', failed);
    }
    const outgoing = request(`${local.url}${path}`, { method: 'POST', headers }, receive);
    outgoing.on('error', failed);
    outgoing.end(JSON.stringify(body));
    return result.promise;
  }
  function stop() {
    computer.send({ type: 'stop', turnId: 'first', conversationId: 'first', reason: 'budget' });
  }
  async function close() {
    await local.close();
    upstream.closeAllConnections();
    upstream.close();
    await computer.close();
  }
  return { ...computer, local, start, stop, call, close, received, open,
    arrived: arrived.promise, departed: departed.promise, revoked: revoked.promise };
}

async function abortsOnlyStoppedRequests() {
  const test = await stopFixture();
  try {
    await test.start('first', 'thread-1');
    await test.start('second', 'thread-2');
    const stoppedModel = test.call('thread-1', 'first', true);
    const stoppedTool = test.call('thread-1', 'first');
    const otherModel = test.call('thread-2', 'second', true);
    const otherTool = test.call('thread-2', 'second');
    await test.arrived;
    test.stop();
    const aborted = Promise.all([stoppedModel, stoppedTool, test.departed]);
    await expect(withinStopDeadline(aborted)).resolves.toEqual(['aborted', 'aborted', undefined]);
    await test.channel.renew('thread-2');
    for (const [name, response] of test.open) {
      if (name.startsWith('thread-2:')) {
        expect(response.destroyed).toBe(false);
        response.end('{}');
      }
    }
    expect(await otherModel).toBe('200: {}');
    expect(await otherTool).toBe('200: {}');
    expect(await test.call('thread-1', 'first', true)).toContain('403:');
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
    expect(test.received).toHaveLength(4);
    test.finish('thread-2');
  } finally {
    await test.close();
  }
}
it('aborts only the stopped thread model and MCP streams before terminal release',
  abortsOnlyStoppedRequests);

async function refusesLateAcknowledgement(renewal: boolean) {
  const test = await stopFixture();
  try {
    if (renewal) await test.start('first', 'thread-1');
    test.pauseAcks();
    const reported = once(test.socket, 'message');
    let renewalResult: Promise<unknown> | undefined;
    function refused(error: unknown) { return error; }
    if (renewal) {
      renewalResult = test.channel.renew('thread-1').catch(refused);
    } else test.send({ type: 'turn', id: 'first', conversationId: 'first',
      assistantId: 'assistant', text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 });
    await reported;
    test.stop();
    await withinStopDeadline(test.revoked);
    if (renewalResult) expect(await renewalResult).toEqual(new Error('Turn ended'));
    test.send({ type: 'ack', sequence: 1, token: 'late', expiresAt: Date.now() + 60_000 });
    await test.flush();
    expect(await test.call('thread-1', 'first', true)).toContain('403:');
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
    expect(test.received).toEqual([]);
  } finally {
    await test.close();
  }
}
it.each([false, true])('refuses an acknowledgement held across Stop (renewal: %s)',
  refusesLateAcknowledgement);

async function removesAnInstallationAlreadyInFlight() {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  let drops = 0;
  async function heldGrant(thread: string, conversation: string, token: string, expires: number) {
    if (token) {
      entered.resolve();
      await release.promise;
    }
    await grant(thread, conversation, token, expires);
    if (!token && ++drops === 2) removed.resolve();
  }
  test.driver.grant = heldGrant;
  try {
    test.send({ type: 'turn', id: 'first', conversationId: 'first',
      assistantId: 'assistant', text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 });
    await entered.promise;
    test.stop();
    await withinStopDeadline(test.revoked);
    release.resolve();
    await withinStopDeadline(removed.promise);
    expect(await test.call('thread-1', 'first', true)).toContain('403:');
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
    expect(test.received).toEqual([]);
    expect(test.calls).not.toContain('turn/start:thread-1');
  } finally {
    release.resolve();
    await test.close();
  }
}
it('removes a grant installation that was already pending when Stop arrived',
  removesAnInstallationAlreadyInFlight);

async function stopsDuringToolPreparation() {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const dropped = Promise.withResolvers<void>();
  const catalogue = test.driver.catalogue!.bind(test.driver);
  const drop = test.driver.dropCatalogue!.bind(test.driver);
  async function heldCatalogue(...input: Parameters<typeof catalogue>) {
    await catalogue(...input);
    entered.resolve();
    await release.promise;
  }
  async function recordDrop(loadKey: string) {
    await drop(loadKey);
    dropped.resolve();
  }
  test.driver.catalogue = heldCatalogue;
  test.driver.dropCatalogue = recordDrop;
  try {
    test.send({ type: 'turn', id: 'first', conversationId: 'first',
      assistantId: 'assistant', text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 });
    await entered.promise;
    test.stop();
    await withinStopDeadline(dropped.promise);
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
    const terminal = once(test.socket, 'message');
    release.resolve();
    await terminal;
    expect(test.calls).toEqual([]);
    expect(test.received).toEqual([]);
  } finally {
    release.resolve();
    await test.close();
  }
}
it('removes the tool list while thread preparation is still waiting', stopsDuringToolPreparation);

async function refusesModelBodyArrivingAfterStop() {
  const test = await stopFixture();
  const result = Promise.withResolvers<number | undefined>();
  function receive(response: IncomingMessage) {
    response.resume();
    result.resolve(response.statusCode);
  }
  const headers = { authorization: `Bearer ${test.local.caller}`, 'session-id': 'thread-1',
    expect: '100-continue' };
  let outgoing: ReturnType<typeof request> | undefined;
  try {
    await test.start('first', 'thread-1');
    outgoing = request(`${test.local.url}/v1/responses`, { method: 'POST', headers }, receive);
    outgoing.on('error', result.reject);
    const reading = once(outgoing, 'continue');
    outgoing.flushHeaders();
    await reading;
    test.stop();
    await withinStopDeadline(test.revoked);
    outgoing.end('{}');
    expect(await result.promise).toBe(403);
    expect(test.received).toEqual([]);
  } finally {
    outgoing?.destroy();
    await test.close();
  }
}
it('refuses a model request whose body finishes arriving after Stop',
  refusesModelBodyArrivingAfterStop);
