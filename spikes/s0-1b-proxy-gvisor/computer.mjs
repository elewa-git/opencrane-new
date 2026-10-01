import { spawn } from 'node:child_process';
import { createServer as netServer, connect } from 'node:net';
import { createServer, request } from 'node:http';
import { mkdirSync, writeFileSync, chmodSync, chownSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { body, json } from './common.mjs';

if (process.argv[2] === 'connect') {
  const socket = connect('/run/codex/exec.sock');
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  socket.on('error', error => { console.error(error.message); process.exit(1); });
} else if (process.getuid() === 0) {
  // Only this small supervisor keeps root. No arbitrary command or arguments.
  process.umask(0o077);
  writeFileSync('/workspace/targets.json', JSON.stringify({ gateway: process.env.GATEWAY }), { mode: 0o644 });
  chmodSync('/workspace/targets.json', 0o644);
  const server = netServer(socket => {
    const child = spawn('/usr/local/bin/tool-user', [], { stdio: ['pipe', 'pipe', 'inherit'] });
    socket.pipe(child.stdin); child.stdout.pipe(socket);
    child.stdin.on('error', () => socket.destroy());
    socket.on('close', () => child.kill());
  });
  server.listen('/run/codex/exec.sock', () => {
    chmodSync('/run/codex/exec.sock', 0o600); chownSync('/run/codex/exec.sock', 1000, 1000);
    const child = spawn('node', ['/spike/computer.mjs'], { uid: 1000, gid: 1000, stdio: 'inherit',
      env: { PATH: process.env.PATH, HOME: '/home/codex', GATEWAY: process.env.GATEWAY, MODEL: process.env.MODEL ?? 'stub-model' } });
    child.on('exit', code => process.exit(code ?? 1));
  });
} else {
  process.umask(0o077);
  mkdirSync('/home/codex/.codex', { recursive: true });
  const caller = randomBytes(32).toString('hex');
  const callerExpires = Date.now() + 600_000;
  writeFileSync('/home/codex/caller', caller);
  writeFileSync('/home/codex/private', 'codex-private-file');
  writeFileSync('/home/codex/.codex/environments.toml', `default = "tools"\ninclude_local = false\n[[environments]]\nid = "tools"\nprogram = "node"\nargs = ["/spike/computer.mjs", "connect"]\ncwd = "/workspace"\n`);
  writeFileSync('/home/codex/.codex/config.toml', `model = "${process.env.MODEL}"\nmodel_provider = "local"\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\nweb_search = "disabled"\n[model_providers.local]\nname = "local authenticated proxy"\nbase_url = "http://127.0.0.1:8080/v1"\nwire_api = "responses"\nenv_key = "PROXY_CALLER_TOKEN"\nrequest_max_retries = 0\nstream_max_retries = 0\n[shell_environment_policy]\ninherit = "none"\n[features]\nmulti_agent = false\nmemories = false\napps = false\nplugins = false\nremote_plugin = false\ncode_mode_host = false\nshell_snapshot = false\n`);
  const turns = new Map();
  let computer;
  const control = createServer(async (req, res) => {
    try {
      const input = JSON.parse(await body(req));
      if (req.url === '/grant') {
        computer = input.computer;
        turns.set(input.thread, input);
        // Deliberate canary for the tool's file-read refusal checks.
        writeFileSync('/home/codex/tokens.json', JSON.stringify(input));
      } else if (req.url === '/drop') turns.delete(input.thread);
      else return json(res, { error: 'path' }, 404);
      json(res, { ok: true });
    } catch { json(res, { error: 'bad input' }, 400); }
  });
  control.listen('/run/codex/control.sock', () => chmodSync('/run/codex/control.sock', 0o600));
  createServer(async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${caller}`);
      if (Date.now() >= callerExpires || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, { error: 'caller' }, 401);
      const thread = req.headers['session-id'];
      const grant = turns.get(thread);
      if (!grant || Date.now() >= grant.expires) return json(res, { error: 'no live turn' }, 403);
      if (req.url !== '/v1/responses' || req.method !== 'POST') return json(res, { error: 'route' }, 404);
      const raw = await body(req);
      const outgoing = request(`${process.env.GATEWAY}/v1/responses`, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${computer}`,
        'x-turn-token': grant.token, 'session-id': thread,
      } }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
        res.on('close', () => upstream.destroy());
      });
      outgoing.setTimeout(120_000, () => outgoing.destroy());
      outgoing.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      outgoing.end(raw);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  }).listen(8080, '127.0.0.1', () => console.log('proxy ready uid=1000 caller TTL=600s'));
}
