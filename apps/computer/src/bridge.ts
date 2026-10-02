// P2-1 process stub only. P2-3 owns the server protocol, turns and event dispatch.
import { spawn } from 'node:child_process';
import { createServer as netServer, connect, type Socket } from 'node:net';
import { createServer } from 'node:http';
import { writeFileSync, chmodSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { proxy } from './proxy.ts';
import { json, record } from './http.ts';
process.umask(0o077);
const gateway = new URL(process.env['GATEWAY'] ?? 'http://127.0.0.1:3000');
if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.pathname !== '/') throw new Error('Invalid gateway');
const caller = await proxy(gateway.origin);
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
createInterface({ input: child.stdout }).on('line', line => {
  const message = record(JSON.parse(line) as unknown);
  if (message['id'] === 'boot') {
    if (message['error']) process.exit(1);
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    initialised = true;
  } else if (client && !client.write(line + '\n')) child.stdout.pause();
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
createServer((req, res) => {
  if (req.url !== '/health' || req.method !== 'GET') { json(res, { error: 'path' }, 404); return; }
  const desktop = connect(6901, '127.0.0.1');
  let answered = false;
  const reply = (ready: boolean) => {
    if (answered) return;
    answered = true; desktop.destroy();
    if (ready && !reported) {
      reported = true;
      process.stdout.write(JSON.stringify({ report: 'ready', bridge: 'stub', codexUid: 1000 }) + '\n');
    }
    json(res, { ready, bridge: 'stub' }, ready ? 200 : 503);
  };
  desktop.setTimeout(500, () => reply(false));
  desktop.on('error', () => reply(false));
  desktop.on('connect', () => reply(initialised));
}).listen(8081, '0.0.0.0');
