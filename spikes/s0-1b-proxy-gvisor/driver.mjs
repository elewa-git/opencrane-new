import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { request } from 'node:http';
import { body } from './common.mjs';
// kubectl exec starts as root; the driver drops before launching Codex.
if (process.getuid() === 0) { process.setgroups([]); process.setgid(1000); process.setuid(1000); }
const mode = process.argv[2];
if (mode === 'grant' || mode === 'drop') {
  const data = await body(process.stdin);
  const req = request({ socketPath: '/run/codex/control.sock', path: `/${mode}`, method: 'POST' }, async res => {
    console.log((await body(res)).toString());
  });
  req.on('error', error => { console.error(error.message); process.exit(1); }); req.end(data);
} else {
  const child = spawn('codex', ['app-server', '--stdio'], { cwd: '/workspace', env: {
    PATH: process.env.PATH, HOME: '/home/codex', CODEX_HOME: '/home/codex/.codex',
    PROXY_CALLER_TOKEN: readFileSync('/home/codex/caller', 'utf8'),
  } });
  const pending = new Map(); let id = 0;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject }); send({ id, method, params });
  });
  child.stderr.on('data', data => process.stderr.write(data));
  const timer = setTimeout(() => { console.error('driver deadline'); process.exit(1); }, 120000);
  child.on('exit', code => { clearTimeout(timer); process.exit(code ?? 1); });
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error))); else waiter?.resolve(message.result);
    } else if (message.id !== undefined) {
      // No approval is an escape from the externally imposed user/filter boundary.
      send({ id: message.id, result: { decision: 'decline' } });
    } else {
      writeFileSync('/home/codex/notifications.jsonl', line + '\n', { flag: 'a' });
      console.log(line);
      if (message.method === 'turn/completed') {
        const req = request({ socketPath: '/run/codex/control.sock', path: '/drop', method: 'POST' });
        req.on('error', error => { console.error(error.message); process.exit(1); });
        req.end(JSON.stringify({ thread: message.params.threadId }));
      }
    }
  });
  await rpc('initialize', { clientInfo: { name: 's01b', version: '1' }, capabilities: { experimentalApi: true } });
  send({ method: 'initialized', params: {} });
  // stdin is a tiny owner-only control protocol: thread creation, then turn start.
  createInterface({ input: process.stdin }).on('line', async line => {
    try {
      const input = JSON.parse(line);
      const result = await rpc(input.method, input.params);
      console.log(JSON.stringify({ driver: input.tag, result }));
    } catch (error) { console.error(error.message); process.exit(1); }
  });
  console.log(JSON.stringify({ driver: 'ready' }));
}
