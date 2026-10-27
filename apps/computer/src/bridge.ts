import { nativeRequests } from './native-requests.ts';
import { receiveFile } from './files.ts';
// Codex process supervision and the authenticated server event channel.
import { spawn } from 'node:child_process';
import { createServer as netServer, connect, type Socket } from 'node:net';
import { createServer } from 'node:http';
import { writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { codexConnection } from './codex-connection.ts';
import { memoryFreeConfig, memoryFreeEnvironments } from './codex-config.ts';
import { bridgeChannel } from './channel.ts';
import { proxy } from './proxy.ts';
import { proxyControl } from './proxy-control.ts';
import { json, record } from './http.ts';
import type { GateIdentity } from './bridge-gate-authority.ts';
function stopped(error: unknown) {
  const name = error instanceof Error ? error.name : 'Error';
  const safeName = /^[A-Za-z][A-Za-z0-9]{0,60}$/u.test(name) ? name : 'Error';
  process.stderr.write(`Bridge stopped: ${safeName}\n`);
  process.exit(1);
}
process.on('uncaughtException', stopped);
process.on('unhandledRejection', stopped);
process.umask(0o077);
const gateway = new URL(process.env['GATEWAY'] ?? 'http://127.0.0.1:3000');
if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.pathname !== '/') throw new Error('Invalid gateway');
function waiting(thread: string, approvalId: string) {
  return channel.approvalWaiting(thread, approvalId);
}
function renew(thread: string) { return channel.renew(thread); }
const approvalDriver = { waiting, renew };
const runtimeProxy = await proxy(gateway.origin, undefined,
  process.env['PROXY_CALLER_TOKEN'], approvalDriver);
const { caller } = runtimeProxy;
writeFileSync('/home/codex/.codex/environments.toml', memoryFreeEnvironments());
writeFileSync('/home/codex/.codex/config.toml', memoryFreeConfig(process.env['MODEL'] ?? 'stub-model'));
const codexArgs = ['--disable-sigusr1', '/usr/local/bin/codex', 'app-server', '--stdio'];
const codexEnvironment = {
  PATH: process.env['PATH'], HOME: '/home/codex', CODEX_HOME: '/home/codex/.codex',
  PROXY_CALLER_TOKEN: caller,
};
const codexOptions = {
  cwd: '/workspace', env: codexEnvironment, stdio: ['pipe', 'pipe', 'inherit'] as ['pipe', 'pipe', 'inherit'],
};
const child = spawn('/usr/local/bin/node', codexArgs, codexOptions);
child.on('error', () => process.exit(1)); child.on('exit', () => process.exit(1));
child.stdin.on('error', () => process.exit(1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
let initialised = false;
let reported = false;
let client: Socket | undefined;
function memoryFreeMessage(message: Record<string, unknown>, line: string) {
  if (answerNativeRequest(message)) return;
  channel.notification(message);
  if (client) client.write(line + '\n');
}
function invalidMemoryFreeOutput() {
  process.stderr.write('Codex output was not valid JSON\n');
  process.exit(1);
}
const persistent = codexConnection(child.stdin, child.stdout,
  { message: memoryFreeMessage, failed: invalidMemoryFreeOutput });
function reportNativeRequest(message: Record<string, unknown>) { channel.notification(message); }
const answerNativeRequest = nativeRequests(persistent.respond, reportNativeRequest);
const initialiseParams = {
  clientInfo: { name: 'opencrane-computer', version: '1' },
  capabilities: { experimentalApi: true },
};
async function initialise() {
  await persistent.rpc('initialize', initialiseParams);
  persistent.notify('initialized', {});
  initialised = true;
}
void initialise().catch(invalidMemoryFreeOutput);

async function privateSession() {
  const socket = connect('/run/executor/private.sock');
  function close() { socket.destroy(); }
  function closedPromise(resolve: () => void) { socket.once('close', resolve); }
  const closed = new Promise<void>(closedPromise);
  let threadId: string | undefined;
  function dispatchPrivateMessage(message: Record<string, unknown>) {
    if (answerPrivateRequest(message)) return;
    const params = message['params'];
    if (!params || typeof params !== 'object' || !('threadId' in params)
      || params.threadId !== threadId) return;
    channel.notification(message);
  }
  function privateMessage(message: Record<string, unknown>) {
    try { dispatchPrivateMessage(message); }
    catch { close(); }
  }
  const connection = codexConnection(socket, socket, { message: privateMessage, failed: close });
  function reportPrivateRequest(message: Record<string, unknown>) {
    if (message['method'] === 'mcpServer/elicitation/request' &&
        record(message['params'])['threadId'] === threadId) channel.notification(message);
  }
  const answerPrivateRequest = nativeRequests(connection.respond, reportPrivateRequest, true);
  socket.on('error', close);
  try {
    await once(socket, 'connect');
    await connection.rpc('initialize', initialiseParams);
    connection.notify('initialized', {});
  } catch {
    close();
    throw new Error('Private Codex unavailable');
  }
  async function rpc(method: string, params: Record<string, unknown>) {
    const result = await connection.rpc(method, params);
    if (method === 'thread/start') {
      const thread = record(record(result)['thread']);
      if (typeof thread['id'] === 'string') threadId = thread['id'];
    }
    return result;
  }
  return { rpc, close, closed };
}
// Keep the persistent Codex connection local to the computer and its image checks.
netServer(socket => {
  if (client) { socket.destroy(); return; }
  client = socket; socket.pipe(child.stdin, { end: false });
  socket.on('drain', () => child.stdout.resume());
  socket.on('error', () => socket.destroy());
  socket.on('close', () => { client = undefined; child.stdout.resume(); });
}).listen('/run/codex/app.sock', () => chmodSync('/run/codex/app.sock', 0o600));
const server = createServer((req, res) => {
  if (req.url !== '/health' || req.method !== 'GET') { json(res, { error: 'path' }, 404); return; }
  const desktop = connect(6901, '127.0.0.1');
  let answered = false;
  const reply = (ready: boolean) => {
    if (answered) return;
    answered = true; desktop.destroy();
    if (ready && !reported) {
      reported = true;
      process.stdout.write(JSON.stringify({ report: 'ready', bridge: 'ready', codexUid: 1000 }) + '\n');
    }
    json(res, { ready, bridge: 'ready' }, ready ? 200 : 503);
  };
  desktop.setTimeout(500, () => reply(false));
  desktop.on('error', () => reply(false));
  desktop.on('connect', () => reply(initialised));
}).listen(8081, '0.0.0.0');

let computerCredential = '';
const channel = bridgeChannel(server, {
  file: receiveFile,
  journal: '/home/agent/codex/bridge-reports.jsonl',
  credential() {
    const path = '/run/executor/credentials/computer.json';
    const saved = record(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    if (typeof saved['digest'] !== 'string' || typeof saved['expiresAt'] !== 'number') {
      throw new Error('Missing credential');
    }
    let gateIdentity: GateIdentity | undefined;
    const verifier = saved['verifier'];
    const issuer = saved['issuer'];
    const silo = saved['silo'];
    const computer = saved['computer'];
    const assistant = saved['assistant'];
    const generation = saved['generation'];
    const podUid = saved['podUid'];
    if (verifier && typeof verifier === 'object' && !Array.isArray(verifier)
      && typeof issuer === 'string' && typeof silo === 'string'
      && typeof computer === 'string' && typeof assistant === 'string'
      && typeof generation === 'number' && Number.isSafeInteger(generation)
      && typeof podUid === 'string' && podUid === process.env['POD_UID']) {
      gateIdentity = { verifier, issuer, silo, computer,
        assistant, generation, podUid };
    }
    return { digest: saved['digest'], expiresAt: saved['expiresAt'], gateIdentity };
  },
  authenticated(value) {
    // Retain the authenticated server's pass only in memory for gateway requests.
    computerCredential = value;
  },
  rpc: persistent.rpc,
  privateSession,
  catalogue(loadKey, conversation, tools, thread, turnId, generations) {
    const input = { loadKey, conversation, tools, thread, turnId, ...generations };
    return proxyControl('/catalogue', input);
  },
  discovered(loadKey) {
    return proxyControl('/catalogue/ready', { loadKey });
  },
  dropCatalogue(loadKey) {
    return proxyControl('/catalogue/drop', { loadKey });
  },
  grant(thread, conversation, token, expiresAt, turnId) {
    const path = token ? '/grant' : '/drop';
    const input = { thread, turnId, conversation, computer: computerCredential,
      token, expires: expiresAt };
    return proxyControl(path, input);
  },
}, runtimeProxy.approvals);
