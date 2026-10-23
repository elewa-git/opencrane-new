// Run only in the labelled offline container. No production feature is enabled.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { memoryFreeConfig } from '../src/codex-config.ts';

assert.equal(process.env.OFFLINE_ANCESTRY_FIXTURE, '1');
const version = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
assert.equal(version, 'codex-cli 0.159.2');
const directory = mkdtempSync(join(tmpdir(), 'native-ancestry-'));
const observations = [];
const aliases = new Map();
const pending = new Map();
const calls = new Map();
const depths = new Map();
const methods = new Set();
const reads = new Set();
let sequence = 0;
let nextRpc = 0;
let child;
let lines;
let failure = false;

function alias(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!aliases.has(value)) aliases.set(value, `id-${aliases.size + 1}`);
  return aliases.get(value);
}
function record(kind, fields) {
  const observation = { order: ++sequence, kind, ...fields };
  observations.push(observation);
  return observation;
}
function send(value) {
  child.stdin.write(`${JSON.stringify(value)}\n`);
}
function rpc(method, params) {
  const id = ++nextRpc;
  function wait(resolve, reject) {
    function expired() { reject(new Error('Fixture RPC expired')); }
    const timeout = setTimeout(expired, 10000);
    pending.set(id, { resolve, reject, timeout });
    send({ id, method, params });
  }
  return new Promise(wait);
}
async function readThread(threadId) {
  if (reads.has(threadId)) return;
  reads.add(threadId);
  try {
    const result = await rpc('thread/read', { threadId, includeTurns: false });
    record('read', { thread: alias(result.thread.id), parent: alias(result.thread.parentThreadId) });
  } catch {
    record('read-unavailable', { thread: alias(threadId) });
  }
}
function receive(line) {
  const value = JSON.parse(line);
  if (value.id !== undefined && !value.method) {
    const waiting = pending.get(value.id);
    if (!waiting) return;
    clearTimeout(waiting.timeout);
    pending.delete(value.id);
    if (value.error) waiting.reject(new Error('Fixture RPC refused'));
    else waiting.resolve(value.result);
    return;
  }
  const params = value.params ?? {};
  if (value.method) methods.add(value.method);
  if (value.method === 'thread/started') {
    record('thread-started', { thread: alias(params.thread.id),
      parent: alias(params.thread.parentThreadId) });
    void readThread(params.thread.id);
  }
  if (params.item?.type === 'subAgentActivity') {
    record('activity', { type: 'subAgentActivity', method: value.method, spawn: alias(params.item.id),
      activity: params.item.kind, sender: alias(params.threadId),
      receiver: alias(params.item.agentThreadId), parentTurn: alias(params.turnId) });
    if (params.item.agentThreadId) void readThread(params.item.agentThreadId);
  }
  if (params.item?.type === 'collabAgentToolCall') {
    const item = params.item;
    const receivers = item.receiverThreadIds.map(alias);
    record('spawn', { method: value.method, spawn: alias(item.id),
      sender: alias(item.senderThreadId), receivers, parentTurn: alias(params.turnId),
      status: item.status });
    for (const receiver of item.receiverThreadIds) void readThread(receiver);
  }
  if (value.method === 'turn/started' || value.method === 'turn/completed') {
    record(value.method, { thread: alias(params.threadId), turn: alias(params.turn.id) });
  }
  if (value.id !== undefined) {
    const error = { code: -32601, message: 'Offline fixture refuses requests' };
    send({ id: value.id, error });
  }
}
function sendEvent(response, event) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
function latestInput(body) {
  let text = '';
  for (const item of body.input ?? []) {
    if (item.role !== 'user') continue;
    text = '';
    for (const part of item.content ?? []) {
      if (typeof part.text === 'string') text += part.text;
    }
  }
  return text;
}
function spawnTool(tools) {
  for (const tool of tools ?? []) {
    if (tool.name === 'spawn_agent') return { name: tool.name };
    for (const nested of tool.tools ?? []) {
      if (nested.name === 'spawn_agent') {
        return { name: nested.name, namespace: tool.name };
      }
    }
  }
  throw new Error('Native spawn tool absent');
}
async function model(request, response) {
  const arrival = record('call', { identities: {} });
  const identifiers = ['session_id', 'conversation_id', 'x-client-request-id',
    'x-request-id', 'idempotency-key', 'x-codex-turn-metadata', 'session-id',
    'thread-id', 'x-codex-parent-thread-id'];
  for (const name of identifiers) arrival.identities[name] = alias(request.headers[name]);
  arrival.subagent = request.headers['x-openai-subagent'] === 'collab_spawn';
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const body = JSON.parse(bytes.toString());
  const input = latestInput(body);
  const tools = [...(body.tools ?? [])];
  for (const item of body.input ?? []) {
    if (item.type === 'additional_tools') tools.push(...item.tools);
  }
  for (const item of body.input ?? []) {
    if (item.type === 'function_call_output') {
      record('model-visible-result', { spawn: alias(item.call_id) });
    }
  }
  const thread = request.headers['x-client-request-id'];
  const parent = request.headers['x-codex-parent-thread-id'];
  let depth = 0;
  if (parent) depth = (depths.get(parent) ?? 0) + 1;
  depths.set(thread, depth);
  arrival.metadata = {};
  for (const field of ['turn_id', 'parent_turn_id', 'root_turn_id']) {
    arrival.metadata[field] = alias(body.client_metadata?.[field]);
  }
  arrival.depth = depth;
  arrival.sameInput = alias(input);
  arrival.bytes = alias(createHash('sha256').update(bytes).digest('hex'));
  arrival.thread = alias(thread);
  const count = (calls.get(thread) ?? 0) + 1;
  calls.set(thread, count);
  if (thread) void readThread(thread);
  // Lose one response before any bytes return. Let Codex perform its own HTTP retry.
  if (depth === 2 && count === 1) {
    arrival.lostReply = true;
    response.destroy();
    return;
  }
  if (depth < 2 && count > 1) {
    const deadline = Date.now() + 10000;
    while (calls.size < 6 && Date.now() < deadline) await pause(10);
  }
  const responseId = `response_${arrival.order}`;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sendEvent(response, { type: 'response.created', response: { id: responseId } });
  let item;
  if (depth < 2 && count === 1) {
    const tool = spawnTool(tools);
    let nextInput = 'offline-child';
    if (depth === 1) nextInput = 'offline-grandchild';
    const spawnArguments = { message: nextInput, task_name: 'offline_child', fork_turns: 'none' };
    const argumentsText = JSON.stringify(spawnArguments);
    record('model-written-spawn', { spawn: alias(`spawn_${arrival.order}`),
      sender: alias(thread) });
    item = { type: 'function_call', id: `spawn_${arrival.order}`,
      call_id: `spawn_${arrival.order}`, ...tool, arguments: argumentsText };
  } else {
    item = { type: 'message', id: `answer_${arrival.order}`, role: 'assistant',
      content: [{ type: 'output_text', text: 'Offline fixture finished.' }] };
  }
  sendEvent(response, { type: 'response.output_item.done', item });
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  sendEvent(response, { type: 'response.completed',
    response: { id: responseId, status: 'completed', usage } });
  response.end();
}
function serve(request, response) {
  function failed() {
    failure = true;
    response.destroy();
  }
  void model(request, response).catch(failed);
}
const server = createServer(serve);
function expired() { process.exit(2); }
const deadline = setTimeout(expired, 35000);
try {
  function listen(resolve) { server.listen(8080, '127.0.0.1', resolve); }
  await new Promise(listen);
  let config = memoryFreeConfig('gpt-6.1-sol');
  config = config.replace('multi_agent = false', 'multi_agent = true');
  config = config.replace('request_max_retries = 0', 'request_max_retries = 1');
  writeFileSync(join(directory, 'config.toml'), config);
  const env = { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory,
    PROXY_CALLER_TOKEN: 'offline-credential-canary' };
  child = spawn('codex', ['app-server', '--stdio', '--strict-config'],
    { env, stdio: ['pipe', 'pipe', 'ignore'] });
  lines = createInterface({ input: child.stdout });
  lines.on('line', receive);
  const clientInfo = { name: 'offline_ancestry', version: '1' };
  await rpc('initialize', { clientInfo, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  const roots = [];
  for (let index = 0; index < 2; index++) {
    const result = await rpc('thread/start', { cwd: '/tmp' });
    roots.push(result.thread.id);
  }
  const starts = [];
  for (const threadId of roots) {
    const input = [{ type: 'text', text: 'offline-root', text_elements: [] }];
    starts.push(rpc('turn/start', { threadId, input }));
  }
  await Promise.all(starts);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && calls.size < 6) await pause(50);
  await pause(2000);
  assert.equal(failure, false);
  assert.equal(calls.size, 6);
} catch {
  failure = true;
} finally {
  clearTimeout(deadline);
  child?.kill('SIGTERM');
  lines?.close();
  for (const waiting of pending.values()) clearTimeout(waiting.timeout);
  server.closeAllConnections();
  server.close();
  rmSync(directory, { recursive: true, force: true });
}
const capture = { version, model: 'gpt-6.1-sol', offline: true, failure,
  methods: [...methods], observations };
console.log(JSON.stringify(capture));
if (failure) process.exitCode = 1;
