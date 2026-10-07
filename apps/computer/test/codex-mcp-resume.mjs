import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const homePrefix = join(tmpdir(), 'codex-resume-');
const probeHome = mkdtempSync(homePrefix);
const startedAt = Date.now();
const versionOptions = { encoding: 'utf8' };
const versionOutput = execFileSync('codex', ['--version'], versionOptions);
const version = versionOutput.trim();
const measurementDate = new Date(startedAt);
const measuredAt = measurementDate.toISOString();
const capture = { measuredAt, version,
  requests: [], modelTools: [], rpc: [], replies: [], completedTurns: [], stderr: [] };
let stage = 'start';
let activeClient;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString();
  return JSON.parse(text);
}

function reply(response, id, result) {
  const headers = { 'content-type': 'application/json' };
  response.writeHead(200, headers);
  const message = { jsonrpc: '2.0', id, result };
  const text = JSON.stringify(message);
  response.end(text);
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
    const result = { tools: [definition] };
    reply(response, body.id, result);
    return;
  }
  response.writeHead(400);
  response.end();
}

function sendEvent(response, event) {
  const text = JSON.stringify(event);
  response.write(`event: ${event.type}\ndata: ${text}\n\n`);
}

async function handleModel(request, response) {
  const body = await readBody(request);
  const namespaces = [];
  for (const tool of body.tools ?? []) {
    if (tool.type === 'namespace' && tool.name.startsWith('mcp__')) namespaces.push(tool);
  }
  const observedTools = { stage, namespaces };
  capture.modelTools.push(observedTools);
  const headers = { 'content-type': 'text/event-stream' };
  response.writeHead(200, headers);
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
  const environment = { PATH: process.env.PATH, HOME: probeHome, CODEX_HOME: probeHome,
    PROXY_CALLER_TOKEN: 'local-fixture-only' };
  const options = { env: environment, stdio: ['pipe', 'pipe', 'pipe'] };
  const argumentsList = ['app-server', '--stdio', '--strict-config'];
  const child = spawn('codex', argumentsList, options);
  const pending = new Map();
  const turns = new Map();
  let nextId = 0;
  const lineOptions = { input: child.stdout };
  const lines = createInterface(lineOptions);

  function send(message) {
    const text = JSON.stringify(message);
    child.stdin.write(`${text}\n`);
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
      if (message.error) {
        const errorText = JSON.stringify(message.error);
        const error = new Error(errorText);
        waiting.reject(error);
      } else {
        waiting.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined) {
      const error = { code: -32601, message: 'Not supported by the local fixture' };
      const refused = { id: message.id, error };
      send(refused);
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
    const entry = { stage, text: chunk.toString() };
    capture.stderr.push(entry);
  }
  lines.on('line', receive);
  child.stderr.on('data', recordStderr);

  function rpc(method, params) {
    const id = ++nextId;
    const entry = { stage, method, params };
    capture.rpc.push(entry);
    function wait(resolve, reject) {
      function expired() {
        pending.delete(id);
        const error = new Error(`Timed out: ${method}`);
        reject(error);
      }
      const timeout = setTimeout(expired, 20000);
      const waiting = { resolve, reject, timeout };
      pending.set(id, waiting);
      const request = { id, method, params };
      send(request);
    }
    return new Promise(wait);
  }

  async function turn(threadId) {
    function wait(resolve) {
      turns.set(threadId, resolve);
    }
    const finished = new Promise(wait);
    const input = [{ type: 'text', text: `Local probe: ${stage}`, text_elements: [] }];
    const turnParams = { threadId, input };
    await rpc('turn/start', turnParams);
    const result = await finished;
    assert.equal(result.status, 'completed');
  }

  async function initialise() {
    const clientInfo = { name: 'resume_probe', version: '1' };
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
  const configPath = join(probeHome, 'config.toml');
  writeFileSync(configPath, config);
  assert.equal(capture.version, 'codex-cli 0.159.2');
  activeClient = startClient();
  await activeClient.initialise();
  const before = threadConfig(mcpPort, 'oc_aaaaaaaaaa', 'before');
  const after = threadConfig(mcpPort, 'oc_bbbbbbbbbb', 'after');
  const startParams = { cwd: '/tmp', config: before };
  const started = await activeClient.rpc('thread/start', startParams);
  const threadId = started.thread.id;
  await activeClient.turn(threadId);
  stage = 'loaded_resume';
  const resumeParams = { threadId, config: after };
  await activeClient.rpc('thread/resume', resumeParams);
  await activeClient.turn(threadId);
  await activeClient.close();
  activeClient = undefined;
  stage = 'unloaded_resume';
  activeClient = startClient();
  await activeClient.initialise();
  await activeClient.rpc('thread/resume', resumeParams);
  await activeClient.turn(threadId);
  capture.threadId = threadId;
  const checks = [];
  for (const observed of capture.modelTools) {
    const names = [];
    for (const namespace of observed.namespaces) names.push(namespace.name);
    let expected = 'mcp__oc_bbbbbbbbbb';
    if (observed.stage === 'start') expected = 'mcp__oc_aaaaaaaaaa';
    const passed = names.length === 1 && names[0] === expected;
    const check = { stage: observed.stage, expected: [expected], actual: names, passed };
    checks.push(check);
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
  const text = JSON.stringify(capture, null, 2);
  console.log(text);
  clearTimeout(deadline);
  if (activeClient) await activeClient.close();
  mcp.close();
  model.close();
  const removalOptions = { recursive: true, force: true };
  rmSync(probeHome, removalOptions);
}
