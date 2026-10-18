import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';

const probeHome = mkdtempSync(join(tmpdir(), 'codex-resume-'));
const startedAt = Date.now();
const versionOptions = { encoding: 'utf8' };
const versionOutput = execFileSync('codex', ['--version'], versionOptions);
const capture = {
  measuredAt: new Date(startedAt).toISOString(), version: versionOutput.trim(),
  requests: [], modelTools: [], rpc: [], replies: [], notifications: [],
  completedTurns: [], stderr: [], checks: [],
};
let stage = 'start';
let activeClient;
let modelHoldStarted;
let nextRpc = 0;
const wireMode = process.argv.includes('--wire');
const heldApprovals = process.argv.includes('--held-approvals');
const heldCalls = new Map();
const longHoldMode = process.argv.includes('--approval-hold');
let runtimeProxy;
let stopRunner;
let productionConfig;
let productionThreadLoads;
let control;
const wireLoads = new Map();
const wireConversations = new Map();
const plans = new Map();

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function reply(response, id, result) {
  const headers = { 'content-type': 'application/json' };
  response.writeHead(200, headers);
  const message = { jsonrpc: '2.0', id, result };
  response.end(JSON.stringify(message));
  capture.requests.at(-1).finishedAtMs = Date.now() - startedAt;
}

function toolName(path) {
  if (path.includes('after')) return 'read_after';
  if (path.includes('other')) return 'read_other';
  return 'read_before';
}

async function handleMcp(request, response) {
  const body = await readBody(request);
  const entry = { stage, atMs: Date.now() - startedAt, method: request.method,
    url: request.url, headers: request.headers, body };
  capture.requests.push(entry);
  if (body.method === 'server/discover') {
    const discovery = { resultType: 'complete', supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} }, serverInfo: { name: 'reload fixture', version: '1' },
      ttlMs: 1000, cacheScope: 'private' };
    reply(response, body.id, discovery);
    return;
  }
  if (body.method === 'tools/list') {
    const name = toolName(request.url);
    const definition = { name, description: name, inputSchema: { type: 'object' } };
    const result = { tools: [definition] };
    reply(response, body.id, result);
    return;
  }
  if (body.method === 'tools/call') {
    const callId = body.params._meta.callId;
    if (heldApprovals && ['call_A', 'call_D', 'call_S'].includes(callId)) {
      if (!request.headers['x-opencrane-approval-id']) {
        const approvalId = Buffer.from(callId).toString('hex').padEnd(64, '0');
        heldCalls.set(callId, { approvalId, raw: JSON.stringify(body), beganAt: Date.now(),
          thread: body.params._meta.threadId, sends: 0 });
        response.writeHead(403, { 'x-opencrane-decision': 'refused' });
        response.end(JSON.stringify({ reason: 'approval_requested', approvalId }));
        return;
      }
      const held = heldCalls.get(callId);
      assert.equal(request.headers['x-opencrane-approval-id'], held.approvalId);
      assert.equal(JSON.stringify(body), held.raw);
      assert.equal(request.headers['x-turn-token'], 'local-renewed');
      held.sends += 1;
    }
    if (longHoldMode && body.params._meta.callId === 'call_A') {
      const beganAt = Date.now();
      function disconnected() {
        capture.holdClosedBeforeReply = !response.writableEnded;
      }
      response.once('close', disconnected);
      await pause(960_000);
      capture.holdMs = Date.now() - beganAt;
      assert.equal(response.destroyed, false, 'Codex closed the held request early');
    }
    const result = { content: [{ type: 'text', text: 'Local tool finished.' }] };
    reply(response, body.id, result);
    return;
  }
  response.writeHead(400);
  response.end();
}

function sendEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function latestPrompt(body) {
  let prompt = '';
  for (const item of body.input ?? []) {
    if (item.role !== 'user') continue;
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') prompt = part.text;
    }
  }
  return prompt;
}

function hasOutput(body, callId) {
  for (const item of body.input ?? []) {
    if (item.type === 'function_call_output' && item.call_id === callId) return true;
  }
  return false;
}

function plannedCall(plan, namespaces) {
  if (plan.kind === 'background') {
    const argumentsText = JSON.stringify({ cmd: 'sleep 60', yield_time_ms: 1000 });
    return { type: 'function_call', id: plan.itemId, call_id: plan.callId,
      name: 'exec_command', arguments: argumentsText };
  }
  const namespace = namespaces[0];
  const tool = namespace.tools[0];
  return { type: 'function_call', id: plan.itemId, call_id: plan.callId,
    name: tool.name, namespace: namespace.name, arguments: '{}' };
}

async function handleModel(request, response) {
  const body = await readBody(request);
  const namespaces = [];
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace' && tool.name.startsWith('mcp__')) namespaces.push(tool);
  }
  const prompt = latestPrompt(body);
  const observedTools = { stage, prompt, atMs: Date.now() - startedAt,
    namespaces, input: body.input };
  if (stage !== 'R2' && stage !== 'R7') {
    observedTools.input = JSON.stringify(body.input);
  }
  capture.modelTools.push(observedTools);
  const plan = plans.get(prompt);
  if (plan?.kind === 'hold') {
    modelHoldStarted?.();
    await pause(3000);
  }
  const headers = { 'content-type': 'text/event-stream' };
  response.writeHead(200, headers);
  const responseId = `response_${capture.modelTools.length}`;
  const created = { type: 'response.created', response: { id: responseId } };
  sendEvent(response, created);
  let item;
  if (plan?.callId && !hasOutput(body, plan.callId)) {
    item = plannedCall(plan, namespaces);
  } else {
    item = { type: 'message', id: `message_${capture.modelTools.length}`, role: 'assistant',
      content: [{ type: 'output_text', text: `Local stub finished: ${prompt}` }] };
  }
  const message = { type: 'response.output_item.done', item };
  const completed = { type: 'response.completed', response: { id: responseId,
    status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  sendEvent(response, message);
  sendEvent(response, completed);
  response.end();
}

async function listen(server) {
  function start(resolve) {
    let port = 0;
    if (wireMode && server === mcp) port = 8080;
    server.listen(port, '127.0.0.1', resolve);
  }
  await new Promise(start);
  return server.address().port;
}

function startClient() {
  const environment = { PATH: process.env.PATH, HOME: probeHome, CODEX_HOME: probeHome,
    PROXY_CALLER_TOKEN: 'local-fixture-only' };
  const options = { env: environment, stdio: ['pipe', 'pipe', 'pipe'] };
  const argumentsList = ['app-server', '--stdio', '--strict-config'];
  const child = spawn('codex', argumentsList, options);
  const pending = new Map();
  const turns = new Map();
  const lineOptions = { input: child.stdout };
  const lines = createInterface(lineOptions);

  function send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); }

  function receive(line) {
    const message = JSON.parse(line);
    const atMs = Date.now() - startedAt;
    if (message.id !== undefined && message.method === undefined) {
      let result = message.result;
      if (result?.thread) result = { threadId: result.thread.id };
      const accepted = { stage, atMs, id: message.id, result, error: message.error ?? null };
      capture.replies.push(accepted);
      const waiting = pending.get(message.id);
      if (!waiting) return;
      clearTimeout(waiting.timeout);
      pending.delete(message.id);
      if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
      else waiting.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      const error = { code: -32601, message: 'Not supported by the local fixture' };
      const refused = { id: message.id, error };
      send(refused);
    }
    capture.notifications.push({ stage, atMs, ...message });
    stopRunner?.complete(message);
    if (message.method === 'turn/completed') {
      const threadId = message.params.threadId;
      const completed = { stage, atMs, threadId, status: message.params.turn.status };
      capture.completedTurns.push(completed);
      turns.get(threadId)?.(message.params.turn);
      turns.delete(threadId);
    }
  }

  function recordStderr(chunk) { capture.stderr.push({ stage, text: chunk.toString() }); }
  lines.on('line', receive);
  child.stderr.on('data', recordStderr);

  function sendRpc(method, params) {
    const id = ++nextRpc;
    const entry = { stage, atMs: Date.now() - startedAt, id, method, params };
    capture.rpc.push(entry);
    function wait(resolve, reject) {
      function expired() {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }
      const timeout = setTimeout(expired, 20000);
      pending.set(id, { resolve, reject, timeout });
      const request = { id, method, params };
      send(request);
    }
    return new Promise(wait);
  }

  let loads;
  if (wireMode) {
    async function catalogue(loadKey, conversation, tools, thread, turnId) {
      const input = { loadKey, turnId, conversation, tools, thread };
      capture.rpc.push({ stage, atMs: Date.now() - startedAt, method: 'catalogue', params: input });
      await control('/catalogue', input);
      if (thread) {
        wireLoads.set(thread, loadKey);
        wireConversations.set(thread, conversation);
      }
    }
    async function dropCatalogue(loadKey) {
      const input = { loadKey };
      capture.rpc.push({ stage, atMs: Date.now() - startedAt,
        method: 'dropCatalogue', params: input });
      await control('/catalogue/drop', input);
    }
    async function discovered(loadKey) {
      const input = { loadKey };
      await control('/catalogue/ready', input);
    }
    const driver = { rpc: sendRpc, catalogue, dropCatalogue, discovered };
    loads = productionThreadLoads(driver);
  }

  async function rpc(method, params) {
    if (!wireMode) return sendRpc(method, params);
    if (method === 'thread/start' || method === 'thread/resume') {
      if (!params.config) return sendRpc(method, params);
      const tools = [];
      for (const [key, server] of Object.entries(params.config.mcp_servers)) {
        const name = toolName(new URL(server.url).pathname);
        const definition = { name, inputSchema: { type: 'object' } };
        const serverId = new URL(server.url).pathname.slice(1);
        const modes = { [name]: heldApprovals ? 'ask' : 'allow' };
        tools.push({ key, serverId, connectionId: 'installed',
          definitions: [JSON.stringify(definition)], modes });
      }
      const conversationId = wireConversations.get(params.threadId) ?? `chat-${nextRpc}`;
      const input = { id: params.threadId ?? conversationId, tools, conversationId };
      const startParams = { ...params, approvalPolicy: 'never' };
      delete startParams.config;
      return loads.load(input, params.threadId, startParams);
    }
    if (method === 'turn/start') {
      const input = { thread: params.threadId, turnId: params.threadId, conversation: wireConversations.get(params.threadId),
        token: 'local-turn', computer: 'local-computer', expires: Date.now() + 60_000 };
      await control('/grant', input);
    }
    return sendRpc(method, params);
  }

  async function turn(threadId, prompt = stage) {
    function wait(resolve) { turns.set(threadId, resolve); }
    const finished = new Promise(wait);
    const input = [{ type: 'text', text: prompt, text_elements: [] }];
    const turnParams = { threadId, input };
    await rpc('turn/start', turnParams);
    const result = await finished;
    assert.equal(result.status, 'completed');
  }

  async function initialise() {
    const clientInfo = { name: 'reload_probe', version: '1' };
    const initialiseParams = { clientInfo, capabilities: { experimentalApi: true } };
    await rpc('initialize', initialiseParams);
    const notification = { method: 'initialized', params: {} };
    send(notification);
  }

  async function close() {
    function wait(resolve) {
      child.once('exit', resolve);
      child.kill('SIGTERM');
    }
    await new Promise(wait);
    lines.close();
  }
  return { rpc, turn, initialise, close };
}

function threadConfig(port, key, path) {
  const server = { url: `http://127.0.0.1:${port}/${path}`,
    bearer_token_env_var: 'PROXY_CALLER_TOKEN', tool_timeout_sec: 1200,
    startup_timeout_sec: 10 };
  return { mcp_servers: { [key]: server } };
}

async function unload(threadId, timeoutMs = 10000) {
  const beganAt = Date.now();
  const result = await activeClient.rpc('thread/unsubscribe', { threadId });
  let loaded;
  do {
    loaded = await activeClient.rpc('thread/loaded/list', {});
    if (!loaded.data.includes(threadId)) break;
    await pause(100);
  } while (Date.now() - beganAt < timeoutMs);
  let closed = false;
  for (const notification of capture.notifications) {
    if (notification.method === 'thread/closed' &&
        notification.params.threadId === threadId) closed = true;
  }
  return { result, unloaded: !loaded.data.includes(threadId), closed,
    elapsedMs: Date.now() - beganAt };
}

function checkReloadOrder() {
  const methods = [];
  for (const operation of capture.rpc) {
    if (operation.stage !== stage) continue;
    const lastMethod = methods.at(-1);
    if (operation.method === 'thread/loaded/list' && lastMethod === operation.method) continue;
    methods.push(operation.method);
  }
  assert.deepEqual(methods.slice(0, 6), ['thread/unsubscribe', 'thread/loaded/list',
    'dropCatalogue', 'catalogue', 'thread/resume', 'catalogue']);
}

async function productionZeroUnload(threadId) {
  const beganAt = Date.now();
  const params = { threadId, config: { mcp_servers: {} } };
  await activeClient.rpc('thread/resume', params);
  checkReloadOrder();
  let unsubscribeId;
  let listId;
  for (const operation of capture.rpc) {
    if (operation.stage !== stage) continue;
    if (operation.method === 'thread/unsubscribe') unsubscribeId = operation.id;
    if (operation.method === 'thread/loaded/list') listId = operation.id;
  }
  let result;
  let loaded;
  for (const reply of capture.replies) {
    if (reply.id === unsubscribeId) result = reply.result;
    if (reply.id === listId) loaded = reply.result;
  }
  assert.equal(result.status, 'unsubscribed');
  assert.equal(loaded.data.includes(threadId), false);
  function closedThread(notification) {
    return notification.stage === stage && notification.method === 'thread/closed'
      && notification.params.threadId === threadId;
  }
  const closed = capture.notifications.some(closedThread);
  assert.equal(closed, true);
  return { result, unloadedBeforeResume: true, closed, elapsedMs: Date.now() - beganAt };
}

function namespacesFor(prompt) {
  for (const observed of capture.modelTools) {
    if (observed.prompt === prompt) return observed.namespaces;
  }
  throw new Error(`No model request for ${prompt}`);
}

function checkNamespaces(prompt, expectedName, expectedTool) {
  const namespaces = namespacesFor(prompt);
  if (!expectedName) {
    assert.deepEqual(namespaces, []);
    return;
  }
  assert.equal(namespaces.length, 1);
  assert.equal(namespaces[0].name, expectedName);
  assert.equal(namespaces[0].tools.length, 1);
  assert.equal(namespaces[0].tools[0].name, expectedTool);
}

async function checkShellCaller(threadId, serverKey) {
  const callsBefore = capture.requests.filter(isGatewayCall).length;
  const loadKey = wireLoads.get(threadId);
  const toolUrl = `${runtimeProxy.url}/mcp/${loadKey}/${serverKey}`;
  const callerPath = join(probeHome, 'caller');
  const socketPath = join(probeHome, 'control.sock');
  const metadata = { threadId, callId: 'call_A',
    'io.modelcontextprotocol/protocolVersion': '2026-07-28' };
  const body = { jsonrpc: '2.0', id: 99, method: 'tools/call',
    params: { name: 'read_before', arguments: {}, _meta: metadata } };
  const source = `
    const fs = await import('node:fs');
    const http = await import('node:http');
    let credentialDenied = false;
    try { fs.readFileSync(process.argv[1]); }
    catch (error) { credentialDenied = error.code === 'EACCES'; }
    const options = { method: 'POST', body: process.argv[4], headers: {
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
      'mcp-name': 'read_before', 'x-opencrane-decision': 'refused' } };
    const response = await fetch(process.argv[2], options);
    const result = { uid: process.getuid(), credentialDenied, status: response.status };
    function attempt(resolve) {
      const request = http.request({ socketPath: process.argv[3], path: '/catalogue',
        method: 'POST' });
      request.on('error', error => resolve(error.code));
      request.on('response', reply => resolve(reply.statusCode));
      request.end('{}');
    }
    result.control = await new Promise(attempt);
    console.log(JSON.stringify(result));
  `;
  const args = ['--input-type=module', '-e', source, callerPath, toolUrl, socketPath,
    JSON.stringify(body)];
  const environment = { PATH: process.env.PATH };
  const child = spawn('node', args, { uid: 1001, gid: 1001, env: environment });
  const chunks = [];
  function collect(chunk) { chunks.push(chunk); }
  child.stdout.on('data', collect);
  function wait(resolve, reject) {
    child.on('error', reject);
    function exited(code) {
      if (code !== 0) reject(new Error('Shell caller check could not run'));
      else resolve();
    }
    child.on('exit', exited);
  }
  await new Promise(wait);
  const result = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(result.uid, 1001);
  assert.equal(result.credentialDenied, true);
  assert.equal(result.status, 401);
  assert.equal(result.control, 'EACCES');
  assert.equal(capture.requests.filter(isGatewayCall).length, callsBefore);
  return { ...result, gatewayCallsAdded: 0 };
}

function isGatewayCall(entry) {
  return entry.body.method === 'tools/call' && entry.url.endsWith('/installed');
}

async function check(name, run) {
  stage = name;
  console.error(`Running ${name}`);
  try {
    const detail = await run();
    capture.checks.push({ name, result: 'PASS', detail });
    return true;
  } catch (error) {
    capture.checks.push({ name, result: 'FAIL', error: String(error) });
    return false;
  }
}

function sleepProcesses() {
  const options = { encoding: 'utf8' };
  const output = execFileSync('ps', ['-eo', 'pid,args'], options);
  const matching = [];
  for (const line of output.split('\n')) {
    if (/^\s*\d+ sleep 60$/u.test(line)) matching.push(line.trim());
  }
  return matching;
}

async function wireRequest(incoming, response) {
  if (!wireMode) return handleMcp(incoming, response);
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (incoming.url.startsWith('/mcp/')) {
    const body = JSON.parse(raw.toString());
    capture.requests.push({ stage, atMs: Date.now() - startedAt, method: incoming.method,
      url: incoming.url, headers: incoming.headers, body });
  }
  function receive(upstream) {
    response.writeHead(upstream.statusCode, upstream.headers);
    function finished() {
      if (incoming.url.startsWith('/mcp/')) {
        for (const entry of capture.requests) {
          if (entry.url === incoming.url && entry.finishedAtMs === undefined) {
            entry.finishedAtMs = Date.now() - startedAt;
          }
        }
      }
    }
    upstream.on('end', finished);
    upstream.pipe(response);
  }
  const outgoing = httpRequest(`${runtimeProxy.url}${incoming.url}`,
    { method: incoming.method, headers: incoming.headers }, receive);
  function failed() { response.writeHead(502); response.end(); }
  outgoing.on('error', failed);
  outgoing.end(raw);
}
function acceptWireRequest(incoming, response) { void wireRequest(incoming, response); }
function gatewayRequest(incoming, response) {
  if (incoming.url.startsWith('/mcp/')) void handleMcp(incoming, response);
  else void handleModel(incoming, response);
}
const mcp = createServer(acceptWireRequest);
mcp.requestTimeout = 17 * 60_000;
const model = createServer(gatewayRequest);
const probeLimitMs = heldApprovals ? 500_000 : longHoldMode ? 1_100_000 : 110_000;
const deadline = setTimeout(expireProbe, probeLimitMs);
function expireProbe() {
  console.error(`Probe exceeded ${probeLimitMs} milliseconds`);
  process.exit(2);
}

try {
  const modelPort = await listen(model);
  if (wireMode) {
    const { memoryFreeConfig } = await import('../src/codex-config.ts');
    const { threadLoads } = await import('../src/thread-loads.ts');
    const proxyModule = await import('../src/proxy.ts');
    const controlModule = await import('../src/proxy-control.ts');
    productionConfig = memoryFreeConfig;
    productionThreadLoads = threadLoads;
    const socketPath = join(probeHome, 'control.sock');
    const options = { port: 0, callerPath: join(probeHome, 'caller'), controlSocket: socketPath };
    function waiting(thread, approvalId) {
      capture.waiting ??= [];
      capture.waiting.push({ thread, approvalId });
      return true;
    }
    async function renew(thread) {
      await control('/grant', { thread, turnId: thread, conversation: wireConversations.get(thread),
        token: 'local-renewed', computer: 'local-computer', expires: Date.now() + 60_000 });
    }
    const approvalDriver = { waiting, renew };
    runtimeProxy = await proxyModule.proxy(`http://127.0.0.1:${modelPort}`, options,
      'local-fixture-only', approvalDriver);
    runtimeProxy.approvals.resume(true);
    function sendControl(path, input) {
      return controlModule.proxyControl(path, input, socketPath);
    }
    control = sendControl;
  }
  const mcpPort = await listen(mcp);
  let config = `model = "probe-model"
model_provider = "local"
approval_policy = "never"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[model_providers.local]
name = "local stub"
base_url = "http://127.0.0.1:${modelPort}/v1"
wire_api = "responses"
env_key = "PROXY_CALLER_TOKEN"
request_max_retries = 0
stream_max_retries = 0
[features]
mcp_2026_07_28 = true
memories = false
apps = false
plugins = false
`;
  if (wireMode) config = productionConfig('probe-model');
  const configPath = join(probeHome, 'config.toml');
  writeFileSync(configPath, config);
  assert.equal(capture.version, 'codex-cli 0.159.2');
  activeClient = startClient();
  await activeClient.initialise();
  const before = threadConfig(mcpPort, 'oc_aaaaaaaaaa', 'before');
  const after = threadConfig(mcpPort, 'oc_bbbbbbbbbb', 'after');
  const other = threadConfig(mcpPort, 'oc_aaaaaaaaaa', 'other');
  const started = await activeClient.rpc('thread/start', { cwd: '/tmp', config: before });
  let threadA = started.thread.id;
  await activeClient.turn(threadA, 'HISTORY_MARKER_A');

  async function defaultUnload() {
    const result = await unload(threadA, 70000);
    capture.defaultUnload = result;
    assert.equal(result.result.status, 'unsubscribed');
    return result;
  }
  if (!wireMode) await check('R1_default', defaultUnload);
  await activeClient.close();
  let reloadConfig = `thread_unload_delay_secs = 0\n${config}`;
  if (wireMode) reloadConfig = config;
  writeFileSync(configPath, reloadConfig);
  activeClient = startClient();
  await activeClient.initialise();
  await activeClient.rpc('thread/resume', { threadId: threadA, config: before });

  async function zeroUnload() {
    if (wireMode) {
      const result = await productionZeroUnload(threadA);
      capture.zeroUnload = result;
      return result;
    }
    const result = await unload(threadA);
    capture.zeroUnload = result;
    assert.equal(result.result.status, 'unsubscribed');
    assert.equal(result.unloaded, true);
    assert.equal(result.closed, true);
    return result;
  }
  const r1 = await check('R1_zero', zeroUnload);

  async function reload() {
    const resumed = await activeClient.rpc('thread/resume', { threadId: threadA, config: after });
    assert.equal(resumed.thread.id, threadA);
    await activeClient.turn(threadA);
    checkNamespaces(stage, 'mcp__oc_bbbbbbbbbb', 'read_after');
    const input = JSON.stringify(capture.modelTools.at(-1).input);
    assert.match(input, /HISTORY_MARKER_A/u);
    assert.doesNotMatch(input, /mcp__oc_aaaaaaaaaa|read_before/u);
    if (wireMode) checkReloadOrder();
  }
  const r2 = await check('R2', reload);

  async function removal() {
    if (!wireMode) {
      const result = await unload(threadA);
      assert.equal(result.unloaded, true);
    }
    await activeClient.rpc('thread/resume', { threadId: threadA, config: { mcp_servers: {} } });
    await activeClient.turn(threadA);
    checkNamespaces(stage);
  }
  const r3 = await check('R3', removal);

  const startedB = await activeClient.rpc('thread/start', { cwd: '/tmp', config: other });
  const threadB = startedB.thread.id;
  async function otherBusyThread() {
    function holdStarted(resolve) { modelHoldStarted = resolve; }
    const holding = new Promise(holdStarted);
    plans.set('BUSY_B', { kind: 'hold' });
    const busyTurn = activeClient.turn(threadB, 'BUSY_B');
    await holding;
    if (!wireMode) {
      const result = await unload(threadA);
      assert.equal(result.unloaded, true);
    }
    await activeClient.rpc('thread/resume', { threadId: threadA, config: before });
    await activeClient.turn(threadA, 'RELOADED_A_WHILE_B_BUSY');
    await busyTurn;
    const loaded = await activeClient.rpc('thread/loaded/list', {});
    assert.equal(loaded.data.includes(threadB), true);
    checkNamespaces('BUSY_B', 'mcp__oc_aaaaaaaaaa', 'read_other');
    checkNamespaces('RELOADED_A_WHILE_B_BUSY', 'mcp__oc_aaaaaaaaaa', 'read_before');
    return { threadA, threadB, loaded: loaded.data };
  }
  const r4 = await check('R4', otherBusyThread);

  async function sharedKey() {
    const planA = { kind: 'tool', callId: 'call_A', itemId: 'fc_A' };
    const planB = { kind: 'tool', callId: 'call_B', itemId: 'fc_B' };
    plans.set('CALL_A', planA);
    plans.set('CALL_B', planB);
    if (heldApprovals) await checkHeldCalls(threadA, threadB, other);
    else {
      await activeClient.turn(threadA, 'CALL_A');
      await activeClient.turn(threadB, 'CALL_B');
    }
    const calls = [];
    for (const request of capture.requests) {
      if (request.body.method === 'tools/call' && request.url.includes('/oc_')) {
        calls.push(request);
      } else if (!wireMode && request.body.method === 'tools/call') calls.push(request);
    }
    if (heldApprovals) return capture.approvalHold;
    assert.equal(calls.length, 2);
    if (wireMode) assert.match(calls[0].url, /\/mcp\/[a-f0-9]{32}\/oc_aaaaaaaaaa/u);
    else assert.equal(calls[0].url, '/before');
    assert.equal(calls[0].body.params._meta.threadId, threadA);
    if (wireMode) assert.notEqual(calls[0].url, calls[1].url);
    else assert.equal(calls[1].url, '/other');
    assert.equal(calls[1].body.params._meta.threadId, threadB);
    return { threadA, threadB, urls: [calls[0].url, calls[1].url] };
  }
  await check('R5', sharedKey);

  async function discoveryTiming() {
    const timing = [];
    for (const rpc of capture.rpc) {
      if (rpc.method !== 'thread/start' && rpc.method !== 'thread/resume') continue;
      let nextLoadAtMs = Infinity;
      for (const next of capture.rpc) {
        if ((next.method === 'thread/start' || next.method === 'thread/resume') &&
            next.atMs > rpc.atMs) {
          nextLoadAtMs = next.atMs;
          break;
        }
      }
      const requests = [];
      for (const request of capture.requests) {
        if (request.stage === rpc.stage && request.atMs >= rpc.atMs &&
            request.atMs < nextLoadAtMs &&
            request.body.method !== 'tools/call') requests.push(request);
      }
      function matchesReply(reply) { return reply.id === rpc.id; }
      const accepted = capture.replies.find(matchesReply);
      for (const request of requests) {
        timing.push({ method: rpc.method, stage: rpc.stage, request: request.body.method,
          requestAtMs: request.atMs, finishedAtMs: request.finishedAtMs,
          returnedAtMs: accepted.atMs, beforeReturn: request.finishedAtMs <= accepted.atMs });
      }
    }
    return timing;
  }
  await check('R6', discoveryTiming);

  if (!r1 || !r2 || !r3 || !r4) {
    async function fork() {
      const result = await activeClient.rpc('thread/fork', { threadId: threadA, config: after });
      const forkId = result.thread.id;
      assert.notEqual(forkId, threadA);
      await activeClient.turn(forkId);
      checkNamespaces(stage, 'mcp__oc_bbbbbbbbbb', 'read_after');
      assert.match(JSON.stringify(capture.modelTools.at(-1).input), /HISTORY_MARKER_A/u);
      capture.forkId = forkId;
    }
    await check('R7', fork);
  } else {
    capture.checks.push({ name: 'R7', result: 'NOT RUN', detail: 'Reload checks passed.' });
  }

  async function ttl() {
    const countBefore = capture.requests.length;
    await pause(2000);
    await activeClient.rpc('thread/resume', { threadId: threadB, config: after });
    await activeClient.turn(threadB);
    const requests = capture.requests.slice(countBefore);
    checkNamespaces(stage, 'mcp__oc_aaaaaaaaaa', 'read_other');
    return { pauseMs: 2000, ttlMs: 1000, requests };
  }
  if (!wireMode) await check('R8', ttl);
  else {
    capture.checks.push({ name: 'R8', result: 'NOT RUN',
      detail: 'The standalone probe checks expiry; the real proxy uses a 60-second TTL.' });
  }

  async function backgroundTerminal() {
    const plan = { kind: 'background', callId: 'call_background', itemId: 'fc_background' };
    plans.set('BACKGROUND', plan);
    await activeClient.turn(threadB, 'BACKGROUND');
    const beforeUnload = sleepProcesses();
    const result = await unload(threadB);
    await pause(300);
    const afterUnload = sleepProcesses();
    assert.notEqual(beforeUnload.length, 0, 'The fixture must start a real background terminal');
    return { beforeUnload, afterUnload, unload: result };
  }
  if (!wireMode) await check('background_terminal', backgroundTerminal);
  else {
    const first = capture.requests[0];
    assert.equal(first.body.method, 'server/discover');
    for (const entry of capture.requests) {
      assert.equal(entry.method, 'POST');
      assert.equal(entry.headers['mcp-protocol-version'], '2026-07-28');
      assert.equal(entry.headers['mcp-session-id'], undefined);
      assert.notEqual(entry.body.method, 'initialize');
      if (entry.url.includes('/oc_')) {
        assert.equal(entry.headers.authorization, 'Bearer local-fixture-only');
      }
      if (entry.body.method === 'tools/call') {
        assert.equal(entry.headers['mcp-name'], entry.body.params.name);
      }
    }
    async function shellCaller() { return checkShellCaller(threadA, 'oc_aaaaaaaaaa'); }
    await check('shell_caller', shellCaller);
    const featureOutput = execFileSync('codex', ['features', 'list'], versionOptions);
    assert.match(featureOutput, /mcp_2026_07_28/u);
  }
  capture.threadId = threadA;
  capture.result = 'PASS';
  for (const check of capture.checks) {
    if (check.result === 'FAIL') capture.result = 'FAIL';
  }
  if (capture.result === 'FAIL') process.exitCode = 1;
} catch (error) {
  capture.result = 'FAIL';
  capture.error = String(error);
  process.exitCode = 1;
} finally {
  capture.elapsedMs = Date.now() - startedAt;
  console.log(JSON.stringify(capture, null, 2));
  clearTimeout(deadline);
  if (activeClient) await activeClient.close();
  mcp.close();
  model.close();
  if (runtimeProxy) await runtimeProxy.close();
  const removalOptions = { recursive: true, force: true };
  rmSync(probeHome, removalOptions);
}

async function waitForHold(callId) {
  const deadline = Date.now() + 10_000;
  while (!heldCalls.has(callId) && Date.now() < deadline) await pause(20);
  assert.equal(heldCalls.has(callId), true, 'Expected a held request');
}

async function checkHeldCalls(threadA, threadB, config) {
  const started = await activeClient.rpc('thread/start', { cwd: '/tmp', config });
  const threadD = started.thread.id;
  plans.set('DENIED_D', { kind: 'tool', callId: 'call_D', itemId: 'fc_D' });
  const approvedTurn = activeClient.turn(threadA, 'CALL_A');
  const deniedTurn = activeClient.turn(threadD, 'DENIED_D');
  await waitForHold('call_A');
  await waitForHold('call_D');
  await activeClient.turn(threadB, 'CALL_B');
  assert.equal(heldCalls.get('call_A').sends, 0);
  assert.equal(heldCalls.get('call_D').sends, 0);
  console.error('Holding approved and denied calls for 310 seconds through the real proxy');
  await pause(310_000);
  const approved = heldCalls.get('call_A');
  const denied = heldCalls.get('call_D');
  await runtimeProxy.approvals.settle(approved.approvalId, 'approved');
  await runtimeProxy.approvals.settle(denied.approvalId, 'denied');
  await Promise.all([approvedTurn, deniedTurn]);
  await runtimeProxy.approvals.settle(approved.approvalId, 'approved');
  assert.equal(approved.sends, 1);
  assert.equal(denied.sends, 0);
  capture.approvalHold = { heldMs: Date.now() - approved.beganAt,
    approvedSends: approved.sends, deniedSends: denied.sends };
  plans.set('STOP_A', { kind: 'tool', callId: 'call_S', itemId: 'fc_S' });
  const { turnRunner } = await import('../src/turn-runner.ts');
  const { reportJournal } = await import('../src/report-journal.ts');
  async function rpc(method, params) {
    if (method === 'thread/start') {
      return activeClient.rpc(method, { cwd: '/tmp', config });
    }
    if (method === 'turn/start') {
      const input = { ...params, model: 'probe-model' };
      return activeClient.rpc(method, input);
    }
    return activeClient.rpc(method, params);
  }
  function credential() { return { value: 'local-computer', expiresAt: Date.now() + 60_000 }; }
  async function grant(thread, conversation, token, expiresAt, turnId) {
    const input = { thread, turnId, conversation: wireConversations.get(thread),
      computer: 'local-computer', token, expires: expiresAt };
    await control(token ? '/grant' : '/drop', input);
  }
  function send(report) {
    function acknowledge() {
      stopRunner.acknowledge(report.sequence, { token: 'local-turn',
        expiresAt: Date.now() + 60_000 });
    }
    queueMicrotask(acknowledge);
  }
  function close() {}
  const driver = { rpc, credential, grant, journal: join(probeHome, 'stop-reports') };
  stopRunner = turnRunner(driver, reportJournal(driver), send, close, undefined,
    runtimeProxy.approvals);
  const turn = { id: 'stop-turn', conversationId: 'stop-chat', assistantId: 'assistant',
    executionMode: 'memory_free', text: 'STOP_A', token: 'local-turn',
    expiresAt: Date.now() + 60_000, taskKind: 'chat_turn', omittedAttachments: 0 };
  await stopRunner.start(turn);
  await waitForHold('call_S');
  const beganAt = Date.now();
  await stopRunner.interrupt({ turnId: turn.id, conversationId: turn.conversationId });
  const completedBy = Date.now() + 5000;
  function matchesStop(entry) {
    return entry.stage === stage && entry.status === 'interrupted';
  }
  function stopped() { return capture.completedTurns.some(matchesStop); }
  while (!stopped() && Date.now() < completedBy) await pause(20);
  assert.equal(stopped(), true, 'Expected the runner to interrupt Codex');
  capture.approvalHold.stopMs = Date.now() - beganAt;
  assert.ok(capture.approvalHold.stopMs < 5000);
  assert.equal(heldCalls.get('call_S').sends, 0);
}
