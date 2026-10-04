// Codex process supervision and the authenticated server event channel.
import { spawn } from 'node:child_process';
import { createServer as netServer, connect, type Socket } from 'node:net';
import { createServer, request } from 'node:http';
import { writeFileSync, chmodSync, renameSync, readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { createInterface } from 'node:readline';
import { bridgeChannel } from './channel.ts';
import { proxy } from './proxy.ts';
import { body, json, record } from './http.ts';
process.umask(0o077);
const gateway = new URL(process.env['GATEWAY'] ?? 'http://127.0.0.1:3000');
if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.pathname !== '/') throw new Error('Invalid gateway');
const { caller } = await proxy(gateway.origin);
writeFileSync('/home/codex/.codex/environments.toml', `default = "tools"
include_local = false
[[environments]]
id = "tools"
program = "node"
args = ["--experimental-strip-types", "/app/src/entrypoint.ts", "connect"]
cwd = "/workspace"
`);
writeFileSync('/home/codex/.codex/config.toml', `model = ${JSON.stringify(process.env['MODEL'])}
model_provider = "local"
approval_policy = "on-request"
sandbox_mode = "danger-full-access"
web_search = "disabled"
[model_providers.local]
name = "local authenticated proxy"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "PROXY_CALLER_TOKEN"
request_max_retries = 0
stream_max_retries = 0
[shell_environment_policy]
inherit = "none"
[features]
multi_agent = false
memories = false
apps = false
plugins = false
remote_plugin = false
code_mode_host = false
shell_snapshot = false
`);
const child = spawn('codex', ['app-server', '--stdio'], { cwd: '/workspace', env: {
  PATH: process.env['PATH'], HOME: '/home/codex', CODEX_HOME: '/home/codex/.codex', PROXY_CALLER_TOKEN: caller,
}, stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', () => process.exit(1)); child.on('exit', () => process.exit(1));
child.stdin.on('error', () => process.exit(1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
let initialised = false;
let reported = false;
let client: Socket | undefined;
let nextRpc = 0;
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
createInterface({ input: child.stdout }).on('line', line => {
  const message = record(JSON.parse(line) as unknown);
  if (message['id'] === 'boot') {
    if (message['error']) process.exit(1);
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    initialised = true;
  } else if (typeof message['id'] === 'string' && pending.has(message['id'])) {
    const call = pending.get(message['id'])!; pending.delete(message['id']);
    if (message['error']) call.reject(new Error('Codex request failed')); else call.resolve(message['result']);
  } else {
    channel.notification(message);
    if (client) client.write(line + '\n');
  }
});
child.stdin.write(JSON.stringify({ id: 'boot', method: 'initialize', params: {
  clientInfo: { name: 'opencrane-computer', version: '1' }, capabilities: { experimentalApi: true },
} }) + '\n');
// Private transport for the future bridge and the image checks; never a TCP API.
netServer(socket => {
  if (client) { socket.destroy(); return; }
  client = socket; socket.pipe(child.stdin, { end: false });
  socket.on('drain', () => child.stdout.resume());
  socket.on('error', () => socket.destroy());
  socket.on('close', () => { client = undefined; child.stdout.resume(); });
}).listen('/run/codex/app.sock', () => chmodSync('/run/codex/app.sock', 0o600));
const server = createServer((req, res) => {
  if (req.method === 'POST' && ['/pause', '/resume'].includes(req.url ?? '')) {
    void (async () => {
      const credential = record(JSON.parse(readFileSync('/run/codex/computer.json', 'utf8')) as unknown);
      const expected = Buffer.from(String(credential['value'])), actual = Buffer.from(String(req.headers['x-bridge-token'] ?? ''));
      if (typeof credential['expiresAt'] !== 'number' || credential['expiresAt'] <= Date.now() || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Not authorised');
      const input = record(await body(req)), leaseId = input['leaseId'];
      if (typeof leaseId !== 'string' || !/^[\w-]{1,200}$/u.test(leaseId)) throw new Error('Invalid pause id');
      const version = input['version'];
      if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Error('Invalid takeover version');
      if (req.url === '/pause') await channel.pause(leaseId, version); else await channel.release(leaseId, version);
      json(res, { quiescent: true });
    })().catch(() => json(res, { error: 'paused' }, 503)); return;
  }
  if (req.url === '/credentials' && req.method === 'POST') {
    void (async () => {
      const token = record(await body(req));
      if (typeof token['value'] !== 'string' || typeof token['id'] !== 'string' ||
          typeof token['expiresAt'] !== 'number' || token['expiresAt'] <= Date.now()) throw new Error('Invalid credential');
      writeFileSync('/run/codex/computer.json.tmp', JSON.stringify(token), { mode: 0o600 });
      renameSync('/run/codex/computer.json.tmp', '/run/codex/computer.json');
      json(res, { ok: true });
    })().catch(() => json(res, { error: 'invalid credential' }, 400));
    return;
  }
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

const channel = bridgeChannel(server, {
  journal: '/home/agent/codex/bridge-reports.jsonl',
  async localControl(action, leaseId) {
    const call = (socketPath: string) => new Promise<void>((resolve, reject) => {
      const req = request({ socketPath, path: `/${action}`, method: 'POST', headers: { 'x-pause-id': leaseId } }, res => {
        res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Local control refused')));
      });
      req.on('error', reject); req.setTimeout(6000, () => req.destroy(new Error('Local control timeout'))); req.end('{}');
    });
    await call('/run/codex/control.sock');
    await call('/run/executor/pause.sock');
  },
  credential() {
    const value = record(JSON.parse(readFileSync('/run/codex/computer.json', 'utf8')) as unknown);
    if (typeof value['value'] !== 'string' || typeof value['expiresAt'] !== 'number') throw new Error('Missing credential');
    return { value: value['value'], expiresAt: value['expiresAt'] };
  },
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = `bridge-${++nextRpc}`;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Codex request timed out')); }, 30_000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  },
  grant(thread, conversation, token, expiresAt) {
    return new Promise<void>((resolve, reject) => {
      const computer = record(JSON.parse(readFileSync('/run/codex/computer.json', 'utf8')) as unknown);
      const req = request({ socketPath: '/run/codex/control.sock', path: token ? '/grant' : '/drop', method: 'POST' }, res => {
        res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Grant refused')));
      });
      req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Grant timeout')));
      req.end(JSON.stringify({ thread, conversation, computer: computer['value'], token, expires: expiresAt }));
    });
  },
});
