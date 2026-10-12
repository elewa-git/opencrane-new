import { spawn } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const targetRoot = `/proc/${input.pid}`;
const environment = readFileSync(`${targetRoot}/environ`);
const env = {};
for (const entry of environment.toString().split('\0')) {
  const separator = entry.indexOf('=');
  if (separator > 0) env[entry.slice(0, separator)] = entry.slice(separator + 1);
}
function processState(pid) {
  const root = `/proc/${pid}`;
  const status = readFileSync(`${root}/status`, 'utf8');
  const fields = {};
  for (const line of status.split('\n')) {
    const [key, value] = line.split(':');
    if (['Uid', 'Gid', 'Groups', 'CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb',
      'NoNewPrivs', 'Seccomp'].includes(key)) fields[key] = value.trim();
  }
  const limits = readFileSync(`${root}/limits`, 'utf8');
  fields.coreLimit = limits.match(/^Max core file size\s+(.+)$/mu)?.[1];
  fields.cwd = readlinkSync(`${root}/cwd`);
  const digest = createHash('sha256');
  digest.update(readFileSync(`${root}/environ`));
  fields.environmentSha256 = digest.digest('hex');
  return fields;
}
const target = processState(input.pid);
const child = spawn('/fixture/private-fault', [], {
  env, cwd: env.HOME + '/work', stdio: ['pipe', 'pipe', 'ignore'],
});
const deadline = setTimeout(expired, 5000);
function expired() {
  child.kill('SIGKILL');
  process.exitCode = 1;
}
child.stdin.write(input.canary + '\n');
const [ready] = await once(child.stdout, 'data');
if (ready.toString() !== 'ready\n') throw new Error('Fault helper did not become ready');
const helper = processState(child.pid);
child.stdin.end('fault\n');
const [code, signal] = await once(child, 'exit');
clearTimeout(deadline);
process.stdout.write(JSON.stringify({ target, helper, code, signal }) + '\n');
