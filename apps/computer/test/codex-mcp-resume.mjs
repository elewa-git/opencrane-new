import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const home = mkdtempSync(join(tmpdir(), 'codex-resume-'));
const startedAt = Date.now();
const versionOutput = execFileSync('codex', ['--version'], { encoding: 'utf8' });
const capture = { measuredAt: new Date(startedAt).toISOString(), version: versionOutput.trim(),
  requests: [], modelTools: [], rpc: [], replies: [], completedTurns: [], stderr: [] };
let stage = 'start';
let activeClient;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function reply(response, id, result) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function handleMcp(request, response) {
  const body = await readBody(request);
  const entry = { stage, method: request.method, url: request.url,
    headers: request.headers, body };
  capture.requests.push(entry);
  if (body.method === 'server/discover') {
    const discovery = { resultType: 'complete', supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} }, serverInfo: { name: 'resume fixture', version: '1' },
      ttlMs: 60000, cacheScope: 'public' };
    reply(response, body.id, discovery);
    return;
  }
  if (body.method === 'tools/list') {
    let name = 'read_before';
    if (request.url === '/after') name = 'read_after';
    const definition = { name, description: name, inputSchema: { type: 'object' } };
    reply(response, body.id, { tools: [definition] });
    return;
  }
  response.writeHead(400);
  response.end();
}

function sendEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function handleModel(request, response) {
  const body = await readBody(request);
  const namespaces = [];
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace' && tool.name.startsWith('mcp__')) namespaces.push(tool);
  }
  capture.modelTools.push({ stage, namespaces });
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const created = { type: 'response.created', response: { id: `response_${stage}` } };
  const message = { type: 'response.output_item.done', item: { type: 'message',
    id: `message_${stage}`, role: 'assistant',
    content: [{ type: 'output_text', text: 'Local stub finished.' }] } };
  const completed = { type: 'response.completed', response: { id: `response_${stage}`,
    status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } };
  sendEvent(response, created);
  sendEvent(response, message);
  sendEvent(response, completed);
  response.end();
}

async function listen(server) {
  function start(resolve) {
    server.listen(0, '127.0.0.1', resolve);
  }
  await new Promise(start);
  return server.address().port;
}

function startClient() {
  const environment = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home,
    PROXY_CALLER_TOKEN: 'local-fixture-only' };
  const options = { env: environment, stdio: ['pipe', 'pipe', 'pipe'] };
  const child = spawn('codex', ['app-server', '--stdio', '--strict-config'], options);
  const pending = new Map();
  const turns = new Map();
  let nextId = 0;
  const lines = createInterface({ input: child.stdout });

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function receive(line) {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      const accepted = { stage, id: message.id, error: message.error ?? null,
        threadId: message.result?.thread?.id };
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
      send({ id: message.id, error });
    }
    if (message.method === 'turn/completed') {
      const threadId = message.params.threadId;
      const completed = { stage, threadId, status: message.params.turn.status };
      capture.completedTurns.push(completed);
      turns.get(threadId)?.(message.params.turn);
      turns.delete(threadId);
    }
  }

  function recordStderr(chunk) {
    capture.stderr.push({ stage, text: chunk.toString() });
  }
  lines.on('line', receive);
  child.stderr.on('data', recordStderr);

  function rpc(method, params) {
    const id = ++nextId;
    capture.rpc.push({ stage, method, params });
    function wait(resolve, reject) {
      function expired() {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }
      const timeout = setTimeout(expired, 20000);
      pending.set(id, { resolve, reject, timeout });
      send({ id, method, params });
    }
    return new Promise(wait);
  }

  async function turn(threadId) {
    function wait(resolve) {
      turns.set(threadId, resolve);
    }
    const finished = new Promise(wait);
    const input = [{ type: 'text', text: `Local probe: ${stage}`, text_elements: [] }];
    await rpc('turn/start', { threadId, input });
    const result = await finished;
    assert.equal(result.status, 'completed');
  }

  async function initialise() {
    const clientInfo = { name: 'resume_probe', version: '1' };
    await rpc('initialize', { clientInfo, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
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

const mcp = createServer(handleMcp);
const model = createServer(handleModel);
const deadline = setTimeout(expireProbe, 60000);
function expireProbe() {
  console.error('Resume probe exceeded 60 seconds');
  process.exit(2);
}

try {
  const mcpPort = await listen(mcp);
  const modelPort = await listen(model);
  const config = `model = "probe-model"
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
  writeFileSync(join(home, 'config.toml'), config);
  assert.equal(capture.version, 'codex-cli 0.159.2');
  activeClient = startClient();
  await activeClient.initialise();
  const before = threadConfig(mcpPort, 'oc_aaaaaaaaaa', 'before');
  const after = threadConfig(mcpPort, 'oc_bbbbbbbbbb', 'after');
  const started = await activeClient.rpc('thread/start', { cwd: '/tmp', config: before });
  const threadId = started.thread.id;
  await activeClient.turn(threadId);
  stage = 'loaded_resume';
  await activeClient.rpc('thread/resume', { threadId, config: after });
  await activeClient.turn(threadId);
  await activeClient.close();
  activeClient = undefined;
  stage = 'unloaded_resume';
  activeClient = startClient();
  await activeClient.initialise();
  await activeClient.rpc('thread/resume', { threadId, config: after });
  await activeClient.turn(threadId);
  capture.threadId = threadId;
  const checks = [];
  for (const observed of capture.modelTools) {
    const names = [];
    for (const namespace of observed.namespaces) names.push(namespace.name);
    let expected = 'mcp__oc_bbbbbbbbbb';
    if (observed.stage === 'start') expected = 'mcp__oc_aaaaaaaaaa';
    const passed = names.length === 1 && names[0] === expected;
    checks.push({ stage: observed.stage, expected: [expected], actual: names, passed });
  }
  capture.checks = checks;
  assert.equal(checks.length, 3, 'Each turn must reach the local model stub');
  for (const check of checks) {
    assert.deepEqual(check.actual, check.expected, `${check.stage}: next model request tools`);
  }
  capture.result = 'PASS';
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
  rmSync(home, { recursive: true, force: true });
}
