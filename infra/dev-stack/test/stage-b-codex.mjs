import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import { chown, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { memoryFreeConfig, memoryFreeEnvironments } from '../../../apps/computer/src/codex-config.ts';
import { codexConnection } from '../../../apps/computer/src/codex-connection.ts';
import { threadLoads } from '../../../apps/computer/src/thread-loads.ts';
import { proxy } from '../../../apps/computer/src/proxy.ts';
import { proxyControl } from '../../../apps/computer/src/proxy-control.ts';
import { nativeRequests } from '../../../apps/computer/src/native-requests.ts';

const directory = await mkdtemp('/tmp/read-turn-');
if (process.env.CAPTURE_MISSING_HOME === '1') {
  await rm('/home/tool/.codex', { recursive: true, force: true });
}
const capture = { executorHomePresent: existsSync('/home/tool/.codex'), version: execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim(),
  notifications: [], stderr: [], nativeRequests: [] };
const children = [];
const servers = [];
let runtime;
let loads;
let client;
let completed;
let connection;
function waiting(resolve) { completed = resolve; }
function expired() { completed({ status: 'timeout' }); }
const terminal = new Promise(waiting);
const limit = setTimeout(expired, 45_000);

function forward(incoming, response) {
  const options = { socketPath: '/capture/gateway.sock', path: incoming.url,
    method: incoming.method, headers: incoming.headers };
  function receive(upstream) {
    function interrupted() { response.destroy(); }
    upstream.on('error', interrupted);
    response.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(response);
  }
  const outgoing = request(options, receive);
  function failed() { response.destroy(); }
  outgoing.on('error', failed);
  incoming.pipe(outgoing);
}

async function startExecutor(name, args) {
  function connect(socket) {
    const child = spawn('/usr/local/bin/tool-user', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    function disconnected() { child.stdin.destroy(); }
    function failed() { socket.destroy(); }
    function record(chunk) { capture.stderr.push(chunk.toString()); }
    socket.on('error', disconnected);
    socket.on('close', disconnected);
    child.stdin.on('error', failed);
    child.stderr.on('data', record);
  }
  const server = socketServer(connect);
  servers.push(server);
  server.listen(`/run/executor/${name}.sock`);
  await once(server, 'listening');
}

try {
  assert.equal(capture.version, 'codex-cli 0.159.2');
  await mkdir('/run/executor', { recursive: true });
  await mkdir('/home/agent/workspace', { recursive: true });
  await startExecutor('host', ['host']);
  await startExecutor('exec', []);
  const relay = createServer(forward);
  servers.push(relay);
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const origin = `http://127.0.0.1:${relay.address().port}`;
  const controlSocket = `${directory}/control.sock`;
  const options = { port: 8080, callerPath: `${directory}/caller`, controlSocket };
  runtime = await proxy(origin, options, 'local-only');
  await writeFile(`${directory}/config.toml`, memoryFreeConfig('gpt-6.1-sol'));
  await writeFile(`${directory}/environments.toml`, memoryFreeEnvironments());
  const env = { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory,
    PROXY_CALLER_TOKEN: 'local-only' };
  client = spawn('codex', ['app-server', '--stdio', '--strict-config'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(client);
  function send(reply) { connection.respond(reply); }
  function recordNative(message) { capture.nativeRequests.push(message); }
  const handleNative = nativeRequests(send, recordNative);
  function message(value) {
    capture.notifications.push(value);
    handleNative(value);
    if (value.method === 'turn/completed') completed(value.params.turn);
  }
  function failed() { completed({ status: 'connection_failed' }); }
  connection = codexConnection(client.stdin, client.stdout, { message, failed });
  function record(chunk) { capture.stderr.push(chunk.toString()); }
  client.stderr.on('data', record);
  await connection.rpc('initialize', { clientInfo: { name: 'opencrane-computer', version: '1' },
    capabilities: { experimentalApi: true } });
  connection.notify('initialized', {});
  async function catalogue(loadKey, conversation, tools, thread, turnId) {
    await proxyControl('/catalogue', { loadKey, conversation, tools, thread, turnId }, controlSocket);
  }
  async function dropCatalogue(loadKey) {
    await proxyControl('/catalogue/drop', { loadKey }, controlSocket);
  }
  async function discovered(loadKey) {
    await proxyControl('/catalogue/ready', { loadKey }, controlSocket);
  }
  loads = threadLoads({ rpc: connection.rpc, catalogue, dropCatalogue, discovered });
  const tools = JSON.parse(await readFile('/capture/tools.json', 'utf8'));
  const turn = { id: 'read-turn', conversationId: 'conversation', assistantId: 'assistant',
    executionMode: 'memory_free', text: 'STAGE_B_READ Read the synthetic quote.', tools };
  const started = await loads.load(turn, undefined, { cwd: '/workspace' });
  const thread = started.thread.id;
  const binding = { thread, turnId: turn.id };
  const requestOptions = { method: 'POST', body: JSON.stringify(binding) };
  const response = await fetch(`${origin}/bind`, requestOptions);
  assert.equal(response.status, 200);
  const credentials = await response.json();
  const grant = { ...binding, ...credentials, conversation: 'conversation',
    expires: Date.now() + 120_000 };
  await proxyControl('/grant', grant, controlSocket);
  await connection.rpc('turn/start', { threadId: thread,
    input: [{ type: 'text', text: turn.text }], model: 'gpt-6.1-sol' });
  capture.turn = await terminal;
} catch (error) {
  capture.error = String(error);
} finally {
  clearTimeout(limit);
  await writeFile('/capture/codex.json', JSON.stringify(capture, null, 2), { mode: 0o600 });
  await chown('/capture/codex.json', Number(process.env.CAPTURE_UID),
    Number(process.env.CAPTURE_GID));
  await loads?.stop();
  for (const child of children) child.kill('SIGKILL');
  await runtime?.close();
  for (const server of servers) server.close();
}
