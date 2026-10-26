import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadComputer } from '../../server/test/support/upload-computer.ts';
import { pauseBridgeCodex } from './pause-bridge-codex.ts';

const binding = { generation: 1, podUid: 'fixture', takeoverId: 'identity-test',
  affectedTurnIds: [] };

async function startsPackagedProxy() {
  const script = `
import { proxy } from '/app/src/proxy.ts';
const options = { callerPath: '/tmp/caller', controlSocket: '/tmp/control.sock', port: 0 };
const service = await proxy('http://127.0.0.1:1', options);
try {
  const response = await fetch(service.url + '/v1/responses', { method: 'POST' });
  const body = await response.json();
  process.stdout.write(JSON.stringify({ status: response.status, body }));
} finally {
  await service.close();
}
`;
  const image = process.env['COMPUTER_TEST_IMAGE'] ?? 'ocn-upload-computer:test';
  // Use only packaged files so checkout mounts cannot hide a missing runtime module.
  const argumentsList = ['run', '--rm', '--network=none', '--entrypoint=node', image,
    '--experimental-strip-types', '--input-type=module', '-e', script];
  const execute = promisify(execFile);
  const result = await execute('docker', argumentsList, { timeout: 30_000 });
  expect(JSON.parse(result.stdout)).toEqual({ status: 401, body: { error: 'caller' } });
}
it('starts the packaged proxy and refuses an unauthenticated caller', startsPackagedProxy);

async function refusesUncertainIdentity(fault: string) {
  const computer = await uploadComputer();
  try {
    const observer = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.readFileSync;
let observations = 0;
fs.readFileSync = function readObservedFile(path, ...rest) {
  const result = original(path, ...rest);
  if (path === '/proc/1/stat') {
    observations++;
    if (${JSON.stringify(fault)} === 'missing-start') return '1 (init) S';
    if (${JSON.stringify(fault)} === 'reused-pid' && observations === 2) {
      const end = result.lastIndexOf(')');
      const fields = result.slice(end + 2).split(' ');
      fields[19] = String(BigInt(fields[19]) + 1n);
      return result.slice(0, end + 2) + fields.join(' ');
    }
  }
  if (${JSON.stringify(fault)} === 'partial-uid' && String(path).endsWith('/status')) {
    return result.replace(/^Uid:.*$/m, 'Uid:\\t1000');
  }
  return result;
};
syncBuiltinESMExports();
fs.unlinkSync('/run/executor/supervisor/control.sock');
const { supervisorStop } = await import('file:///app/src/supervisor-stop.ts');
supervisorStop();
process.stdout.write('ready');
`;
    await computer.write('/workspace/identity-observer.mjs', observer);
    const start = `
import { spawn } from 'node:child_process';
const child = spawn('node', ['--experimental-strip-types', '/workspace/identity-observer.mjs'], {
  detached: true, stdio: ['ignore', 'pipe', 'ignore'],
});
function ready(bytes) {
  process.stdout.write(bytes);
  child.stdout.destroy();
  child.unref();
}
child.stdout.once('data', ready);
`;
    expect(await computer.exec('node', '--input-type=module', '-e', start)).toBe('ready');
    const request = `
import { request } from 'node:http';
function receive(response) {
  process.stdout.write(String(response.statusCode) + '\\n');
  response.pipe(process.stdout);
}
const options = { socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' };
const outgoing = request(options, receive);
outgoing.end(process.argv[1]);
`;
    const result = await computer.exec('node', '--input-type=module', '-e', request,
      JSON.stringify(binding));
    expect(result).toBe('400\n{"error":"Stop proof unavailable","controlEnabled":false}');
    expect(await computer.exec('pgrep', '-x', 'Xvnc')).toMatch(/^\d+$/u);
  } finally {
    await computer.close();
  }
}
it.each(['missing-start', 'reused-pid', 'partial-uid'])(
  'refuses a root receipt when process observation has %s', refusesUncertainIdentity, 60_000);

async function checksRealAutomation(uid: number) {
  const computer = await uploadComputer();
  try {
    const launch = `
import { spawn } from 'node:child_process';
const child = spawn('/usr/bin/chromium', ['--headless', '--no-sandbox',
  '--disable-background-networking', '--remote-debugging-port=0',
  '--user-data-dir=/tmp/automation-fixture', 'about:blank'], {
  uid: ${uid}, gid: ${uid}, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, HOME: '/tmp/automation-home' },
});
let output = '';
function ready(bytes) {
  output += bytes.toString();
  if (!output.includes('DevTools listening on')) return;
  child.stderr.off('data', ready);
  process.stdout.write('ready');
  child.stderr.destroy();
  child.unref();
}
child.stderr.on('data', ready);
`;
    expect(await computer.exec('node', '--input-type=module', '-e', launch)).toBe('ready');
    const before = await computer.exec('pgrep', '-u', String(uid), '-x', 'chromium');
    expect(before).toMatch(/\d+/u);
    await pauseBridgeCodex(computer);
    const request = `
import { request } from 'node:http';
function receive(response) { response.pipe(process.stdout); }
const options = { socketPath: '/run/executor/supervisor/control.sock',
  path: '/stop', method: 'POST' };
const outgoing = request(options, receive);
outgoing.end(process.argv[1]);
`;
    const result = await computer.exec('node', '--input-type=module', '-e', request,
      JSON.stringify(binding));
    const quietProof = uid === 1002 ? 'unavailable' : 'complete';
    const expected = { executionQuiet: true, executionInventory: [],
      quietProof, controlEnabled: false };
    expect(JSON.parse(result)).toMatchObject(expected);
    // Keep desktop automation alive and refuse complete proof while it remains.
    const inspect = `
import { readFileSync } from 'node:fs';
let live = false;
for (const pid of process.argv[1].split('\\n')) {
  try {
    const status = readFileSync('/proc/' + pid + '/status', 'utf8');
    if (!/State:\\s+[ZX]/.test(status)) live = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
process.stdout.write(String(live));
`;
    expect(await computer.exec('node', '--input-type=module', '-e', inspect, before))
      .toBe(String(uid === 1002));
    expect(await computer.exec('pgrep', '-x', 'Xvnc')).toMatch(/^\d+$/u);
  } finally {
    await computer.close();
  }
}
it.each([1001, 1002])('keeps automation under UID %s separate from full quiet proof',
  checksRealAutomation, 60_000);

async function checksWorkerRefusal() {
  const computer = await uploadComputer();
  try {
    const script = `
import assert from 'node:assert/strict';
import { workspaceProcess } from '/app/src/files.ts';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const check = "const net = require('node:net'); " +
  "const socket = net.connect(3000, '127.0.0.1'); " +
  "socket.on('error', function failed(error) { " +
  "process.stdout.write(JSON.stringify({uid: process.getuid(), code: error.code})); });";
const result = await workspaceProcess(['node', '-e', check], Buffer.alloc(0));
assert.equal(result.exitCode, 0);
assert.deepEqual(JSON.parse(result.output.toString()), {uid: 1001, code: 'EPERM'});
const socket = connect('/run/executor/exec.sock');
const lines = createInterface({ input: socket });
async function rpc(method, params) {
  socket.write(JSON.stringify({id: 7, method, params}) + '\\n');
  const [line] = await once(lines, 'line');
  return JSON.parse(line);
}
await rpc('initialize', { clientName: 'worker-refusal-test' });
for (const argv of [ ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  ['git', 'clone', '--no-checkout', 'https://github.com/a/b.git'] ]) {
  const response = await rpc('process/start', { processId: 'worker', argv,
    cwd: 'file:///workspace', env: {}, tty: false, pipeStdin: false, arg0: null,
    metadata: {threadId: 'thread-1', toolCallId: 'call-1'} });
  assert.deepEqual(response, {id: 7,
    error: {code: -32000, message: 'worker_execution_disabled'}});
}
lines.close();
socket.destroy();
process.stdout.write('ordinary-denied worker-disabled');
`;
    const result = await computer.exec('node', '--experimental-strip-types',
      '--input-type=module', '-e', script);
    expect(result).toBe('ordinary-denied worker-disabled');
  } finally {
    await computer.close();
  }
}
it('refuses worker launch while ordinary execution remains socket-denied', checksWorkerRefusal, 60_000);
