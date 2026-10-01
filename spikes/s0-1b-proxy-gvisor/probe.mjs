// Run by a model-requested Codex exec_command, never substituted by kubectl.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
const results = {};
assert.equal(process.getuid(), 1001);
results.uid = process.getuid();
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /NoNewPrivs:\s+1/);
assert.match(status, /CapEff:\s+0+\n/);
results.noNewPrivs = true;
assert.throws(() => process.setuid(1000), { code: 'EPERM' });
results.cannotBecomeCodex = true;
assert.equal(process.env.PROXY_CALLER_TOKEN, undefined);
results.callerAbsentFromEnvironment = true;
for (const path of ['/home/codex/private', '/home/codex/caller', '/home/codex/tokens.json', '/home/codex/.codex/config.toml']) {
  assert.throws(() => readFileSync(path), { code: 'EACCES' }); results[path] = 'EACCES';
}
let protectedProcesses = 0;
for (const pid of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
  let info;
  try { info = readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { continue; }
  if (!/Uid:\s+1000\s/.test(info)) continue;
  assert.throws(() => readFileSync(`/proc/${pid}/environ`), error => ['EACCES', 'EPERM'].includes(error.code));
  protectedProcesses++;
}
assert.ok(protectedProcesses >= 2);
results.protectedProcesses = protectedProcesses;
const { gateway } = JSON.parse(readFileSync('/workspace/targets.json', 'utf8'));
const host = new URL(gateway).hostname;
for (const [name, target] of Object.entries({
  proxy: { host: '127.0.0.1', port: 8080 },
  gateway: { host, port: 3000 }, model: { host, port: 9003 }, issuer: { host, port: 9001 },
  ipv6: { host: '::1', port: 8080 },
  control: { path: '/run/codex/control.sock' }, executor: { path: '/run/codex/exec.sock' },
})) {
  await new Promise((resolve, reject) => {
    const socket = connect(target);
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error(`${name}: timeout is not proof of seccomp`)); });
    socket.on('connect', () => { socket.destroy(); reject(new Error(`${name}: unexpectedly connected`)); });
    socket.on('error', error => {
      try { assert.ok(['EPERM', 'EACCES'].includes(error.code), error.message); results[name] = error.code; resolve(); } catch (failure) { reject(failure); }
    });
  });
}
console.log('ISOLATION_PASS ' + JSON.stringify(results));
