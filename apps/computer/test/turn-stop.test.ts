import { once } from 'node:events';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
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
  const firstRequest = Promise.withResolvers<ServerResponse>();
  let closed = 0;
  function receive(incoming: IncomingMessage, response: ServerResponse) {
    const thread = String(incoming.headers['session-id']);
    const name = `${thread}:${incoming.url}`;
    received.push(name);
    open.set(name, response);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(' ');
    firstRequest.resolve(response);
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
  const interrupted = Promise.withResolvers<void>();
  const rpc = computer.driver.rpc.bind(computer.driver);
  function recordRpc(method: string, params: Record<string, unknown>) {
    const result = rpc(method, params);
    if (method === 'thread/resume') {
      computer.loaded.add(String(params['threadId']));
      return Promise.resolve({ thread: { id: params['threadId'] } });
    }
    if (method === 'turn/start') started.get(String(params['threadId']))?.resolve();
    if (method === 'turn/interrupt') interrupted.resolve();
    return result;
  }
  computer.driver.rpc = recordRpc;
  async function grant(thread: string, conversation: string, token: string, expires: number,
    turnId: string) {
    const path = token ? '/grant' : '/drop';
    const input = { thread, turnId, conversation, computer: 'fixture', token, expires };
    await proxyControl(path, input, socketPath);
    if (!token && thread === 'thread-1') revoked.resolve();
  }
  computer.driver.grant = grant;
  async function catalogue(loadKey: string, conversation: string, _tools: unknown,
    thread: string | undefined, turnId: string) {
    lists.set(conversation, loadKey);
    const input = { loadKey, turnId, conversation, thread, tools };
    await proxyControl('/catalogue', input, socketPath);
  }
  async function dropCatalogue(loadKey: string) {
    await proxyControl('/catalogue/drop', { loadKey }, socketPath);
  }
  computer.driver.catalogue = catalogue;
  computer.driver.dropCatalogue = dropCatalogue;
  async function start(name: string, thread: string, conversationId = name) {
    const barrier = Promise.withResolvers<void>();
    started.set(thread, barrier);
    const frame = { type: 'turn', id: name, conversationId, assistantId: 'assistant',
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 };
    computer.send(frame);
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
    arrived: arrived.promise, departed: departed.promise, revoked: revoked.promise,
    firstRequest: firstRequest.promise, interrupted: interrupted.promise };
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
  async function heldGrant(thread: string, conversation: string, token: string, expires: number,
    turnId: string) {
    if (token) {
      entered.resolve();
      await release.promise;
    }
    await grant(thread, conversation, token, expires, turnId);
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

async function finishesOldInstallationBeforeReusingThread() {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  async function heldGrant(thread: string, conversation: string, token: string, expires: number,
    turnId: string) {
    if (token) {
      entered.resolve();
      await release.promise;
    }
    await grant(thread, conversation, token, expires, turnId);
  }
  function refused(error: unknown) { return error; }
  try {
    await test.start('first', 'thread-1');
    test.driver.grant = heldGrant;
    const renewing = test.channel.renew('thread-1').catch(refused);
    await entered.promise;
    test.stop();
    await withinStopDeadline(test.revoked);
    await withinStopDeadline(test.interrupted);
    test.finish('thread-1');
    test.finish('thread-1');
    const beforeRetry = [...test.calls];
    const next = { type: 'turn', id: 'next', conversationId: 'first', assistantId: 'assistant',
      text: 'Hello', token: 'initial', expiresAt: Date.now() + 60_000 };
    test.send(next);
    await test.flush();
    expect(test.calls).toEqual(beforeRetry);
    release.resolve();
    expect(await renewing).toEqual(new Error('Turn ended'));
    test.driver.grant = grant;
    await test.start('next', 'thread-1', 'first');
    const response = test.call('thread-1', 'first', true);
    const upstream = await test.firstRequest;
    upstream.end('{}');
    expect(await response).toBe('200: {}');
    function firstTerminal(frame: Record<string, unknown>) {
      return frame['type'] === 'agent.turn_completed' && frame['turnId'] === 'first';
    }
    expect(test.frames.filter(firstTerminal)).toHaveLength(1);
  } finally {
    release.resolve();
    await test.close();
  }
}
it('finishes an old grant installation before admitting another turn on its thread',
  finishesOldInstallationBeforeReusingThread);

async function refusesRenewalBeforeItsReplyReturns(signedGate: boolean) {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const apply = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  async function heldGrant(...input: Parameters<typeof grant>) {
    if (!input[2]) return grant(...input);
    entered.resolve();
    await apply.promise;
    let failure: Error | undefined;
    try {
      await grant(...input);
    } catch (error) {
      if (error instanceof Error) failure = error;
      else failure = new Error('Control request failed', { cause: error });
    }
    applied.resolve();
    await reply.promise;
    if (failure) throw failure;
  }
  function refused(error: unknown) { return error; }
  function finishUnexpectedRequest(upstream: ServerResponse) { upstream.end('{}'); }
  void test.firstRequest.then(finishUnexpectedRequest);
  async function blockedModel() {
    const response = test.call('thread-1', 'first', true);
    expect(await response).toContain('403:');
    expect(test.received).toEqual([]);
  }
  try {
    await test.start('first', 'thread-1');
    test.driver.grant = heldGrant;
    const renewing = test.channel.renew('thread-1').catch(refused);
    await entered.promise;
    if (signedGate) test.send(await test.signedGate());
    else test.stop();
    await withinStopDeadline(test.revoked);
    await withinStopDeadline(test.interrupted);
    await blockedModel();
    apply.resolve();
    await applied.promise;
    await blockedModel();
    reply.resolve();
    if (signedGate) expect(await renewing).toBeUndefined();
    else expect(await renewing).toEqual(new Error('Turn ended'));
    await blockedModel();
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
  } finally {
    apply.resolve();
    reply.resolve();
    await test.close();
  }
}
it.each([false, true])(
  'never makes a cancelled renewal usable while its reply is held (signed gate: %s)',
  refusesRenewalBeforeItsReplyReturns);

async function keepsNextTurnAccessWhenOldDropArrives() {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  let holdFirstDrop = true;
  async function heldDrop(...input: Parameters<typeof grant>) {
    if (!input[2] && holdFirstDrop) {
      holdFirstDrop = false;
      entered.resolve();
      await release.promise;
      await grant(...input);
      applied.resolve();
      return;
    }
    await grant(...input);
  }
  try {
    await test.start('first', 'thread-1');
    test.driver.grant = heldDrop;
    test.stop();
    await entered.promise;
    test.finish('thread-1');
    await withinStopDeadline(test.revoked);
    expect(await test.call('thread-1', 'first', true)).toContain('403:');
    expect(await test.call('thread-1', 'first')).toContain('Unknown tool list');
    expect(test.received).toEqual([]);
    await test.start('next', 'thread-1', 'first');
    const model = test.call('thread-1', 'first', true);
    const upstream = await test.firstRequest;
    const tool = test.call('thread-1', 'first');
    function toolArrived() {
      const response = test.open.get('thread-1:/mcp/server/installed');
      if (!response) throw new Error('Tool request has not arrived');
      return response;
    }
    const toolUpstream = await vi.waitFor(toolArrived);
    expect(toolUpstream).toBeDefined();
    release.resolve();
    await applied.promise;
    upstream.end('{}');
    toolUpstream.end('{}');
    expect(await model).toBe('200: {}');
    expect(await tool).toBe('200: {}');
    function finishRequest() {
      const response = test.open.get('thread-1:/v1/responses');
      if (test.received.length < 3 || !response) throw new Error('Request has not arrived');
      response.end('{}');
    }
    const nextModel = test.call('thread-1', 'first', true);
    await vi.waitFor(finishRequest);
    expect(await nextModel).toBe('200: {}');
    test.finish('thread-1');
  } finally {
    release.resolve();
    await test.close();
  }
}
it('keeps the next turn streams and pass when an old Stop drop arrives',
  keepsNextTurnAccessWhenOldDropArrives);

async function refusesModelBodyArrivingAfterExpiry() {
  const test = await stopFixture();
  const result = Promise.withResolvers<number | undefined>();
  function receive(response: IncomingMessage) {
    response.resume();
    result.resolve(response.statusCode);
  }
  function finishUnexpectedRequest(upstream: ServerResponse) { upstream.end('{}'); }
  void test.firstRequest.then(finishUnexpectedRequest);
  const headers = { authorization: `Bearer ${test.local.caller}`, 'session-id': 'thread-1',
    expect: '100-continue' };
  let outgoing: ReturnType<typeof request> | undefined;
  const clock = vi.spyOn(Date, 'now');
  try {
    await test.start('first', 'thread-1');
    const options = { method: 'POST', headers };
    outgoing = request(`${test.local.url}/v1/responses`, options, receive);
    outgoing.on('error', result.reject);
    const reading = once(outgoing, 'continue');
    outgoing.flushHeaders();
    await reading;
    clock.mockReturnValue(Date.now() + 60_001);
    outgoing.end('{}');
    expect(await result.promise).toBe(403);
    expect(test.received).toEqual([]);
  } finally {
    clock.mockRestore();
    outgoing?.destroy();
    await test.close();
  }
}
it('rechecks pass expiry after reading a model request body',
  refusesModelBodyArrivingAfterExpiry);

async function cancelsOnlyStoppedTurnWaiters() {
  const test = await stopFixture();
  let otherSettled = false;
  function refused(error: unknown) { return error; }
  function otherFinished() { otherSettled = true; }
  try {
    await test.start('first', 'thread-1');
    await test.start('second', 'thread-2');
    test.pauseAcks();
    let reported = once(test.socket, 'message');
    const firstRenewal = test.channel.renew('thread-1').catch(refused);
    await reported;
    reported = once(test.socket, 'message');
    const secondRenewal = test.channel.renew('thread-2').catch(refused);
    void secondRenewal.then(otherFinished);
    await reported;
    test.stop();
    await withinStopDeadline(test.interrupted);
    expect(await firstRenewal).toEqual(new Error('Turn ended'));
    expect(otherSettled).toBe(false);
    const acknowledgement = { type: 'ack', sequence: 2, token: 'second-renewed',
      expiresAt: Date.now() + 60_000 };
    test.send(acknowledgement);
    expect(await secondRenewal).toBeUndefined();
    const response = test.call('thread-2', 'second', true);
    const upstream = await test.firstRequest;
    upstream.end('{}');
    expect(await response).toBe('200: {}');
    expect(await test.call('thread-1', 'first', true)).toContain('403:');
    expect(test.received).toEqual(['thread-2:/v1/responses']);
  } finally {
    await test.close();
  }
}
it('leaves another turn renewal waiting when Stop cancels its own waiter',
  cancelsOnlyStoppedTurnWaiters);

async function closesOldStreamAfterThreadReuse() {
  const test = await stopFixture();
  const entered = Promise.withResolvers<void>();
  const terminalDrop = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const applied = Promise.withResolvers<void>();
  const grant = test.driver.grant.bind(test.driver);
  let drops = 0;
  let finishedDrops = 0;
  async function heldDrop(...input: Parameters<typeof grant>) {
    if (input[2] || input[4] !== 'first') return grant(...input);
    drops++;
    entered.resolve();
    if (drops === 2) terminalDrop.resolve();
    await release.promise;
    await grant(...input);
    if (++finishedDrops === 2) applied.resolve();
  }
  try {
    await test.start('first', 'thread-1');
    const oldModel = test.call('thread-1', 'first', true);
    const oldUpstream = await test.firstRequest;
    test.driver.grant = heldDrop;
    test.stop();
    await entered.promise;
    test.finish('thread-1');
    await terminalDrop.promise;
    await test.start('next', 'thread-1', 'first');
    const nextModel = test.call('thread-1', 'first', true);
    function nextArrived() {
      const response = test.open.get('thread-1:/v1/responses');
      if (!response || response === oldUpstream) throw new Error('New request has not arrived');
      return response;
    }
    const nextUpstream = await vi.waitFor(nextArrived);
    release.resolve();
    await applied.promise;
    await expect(withinStopDeadline(oldModel)).resolves.toBe('aborted');
    expect(nextUpstream.destroyed).toBe(false);
    nextUpstream.end('{}');
    expect(await nextModel).toBe('200: {}');
  } finally {
    release.resolve();
    await test.close();
  }
}
it('closes an old turn model stream after the next turn has reused its thread',
  closesOldStreamAfterThreadReuse);
