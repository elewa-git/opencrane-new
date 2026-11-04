import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { record } from '../src/http.ts';
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

const inspectCallers = `
import { readdirSync, readFileSync } from 'node:fs';
const callers = new Set();
function isPrivateHome(value) { return value.startsWith('HOME=/home/private/turn-'); }
function isCaller(value) { return value.startsWith('PROXY_CALLER_TOKEN='); }
for (const pid of readdirSync('/proc')) {
  if (!/^[0-9]+$/.test(pid)) continue;
  try {
    const environment = readFileSync('/proc/' + pid + '/environ', 'utf8');
    const env = environment.split('\\0');
    if (!env.some(isPrivateHome)) continue;
    callers.add(env.find(isCaller));
  } catch {}
}
process.stdout.write(JSON.stringify({ distinct: callers.size }));
`;
const inspectCallerValues = inspectCallers.replace('JSON.stringify({ distinct: callers.size })',
  'JSON.stringify([...callers])');
const matrix = `
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const inspect = ${JSON.stringify(inspectCallerValues)};
const bytes = execFileSync('setpriv', ['--reuid=1003', '--regid=1003', '--clear-groups',
  'node', '--input-type=module', '-e', inspect]);
function callerValue(value) { return value.slice('PROXY_CALLER_TOKEN='.length); }
const values = JSON.parse(bytes);
const callers = values.map(callerValue);
callers.push(readFileSync('/home/codex/caller', 'utf8'));
callers.push('f'.repeat(64));
const threads = JSON.parse(process.argv[1]);
const rows = [];
for (const caller of callers) {
  const statuses = [];
  for (const thread of threads) {
    const input = { input: [{ role: 'user', content: 'fixture probe' }] };
    const headers = { authorization: 'Bearer ' + caller, 'session-id': thread };
    const options = { method: 'POST', headers, body: JSON.stringify(input) };
    const response = await fetch('http://127.0.0.1:8080/v1/responses', options);
    statuses.push(response.status);
    await response.body.cancel();
  }
  rows.push(statuses);
}
process.stdout.write(JSON.stringify(rows));
`;
const attempt = `
import { connect } from 'node:net';
import { request } from 'node:http';
const results = [];
function sendControl(resolve) {
  function received(response) {
    results.push(response.statusCode);
    response.resume();
    response.on('end', resolve);
  }
  function denied() { results.push('denied'); resolve(); }
  const options = { socketPath: '/run/codex/control.sock', method: 'POST', path: '/grant' };
  const outgoing = request(options, received);
  outgoing.on('error', denied);
  const grant = { thread: 'foreign', turnId: 'injected',
    computer: 'injected', token: 'injected', expires: Date.now() + 60000 };
  outgoing.end(JSON.stringify(grant));
}
await new Promise(sendControl);
function openPrivate(resolve) {
  const socket = connect('/run/executor/private.sock');
  function ignoreError() {}
  socket.on('error', ignoreError);
  socket.on('close', resolve);
  function challenged(bytes) {
    results.push(/^[a-f0-9]{64}\\n$/.test(bytes.toString()) ? 'challenge' : 'unexpected');
    const launch = { caller: 'injected', env: { NODE_OPTIONS: 'injected' } };
    socket.end(JSON.stringify(launch) + '\\n');
  }
  socket.on('data', challenged);
}
await new Promise(openPrivate);
process.stdout.write(JSON.stringify(results));
`;

type ProductionLaunches = Awaited<ReturnType<typeof productionLaunches>>;
const resumeFrame = { type: 'resume', since: 0 };

async function productionLaunches() {
  const computer = await uploadComputer();
  const options = { headers: { 'x-bridge-token': computer.credential.value } };
  const socket = new WebSocket(computer.url.replace('http:', 'ws:') + '/bridge', options);
  const reports: Record<string, unknown>[] = [];
  function receive(bytes: Buffer) { reports.push(record(JSON.parse(bytes.toString()))); }
  socket.on('message', receive);
  function isStart(report: Record<string, unknown>) {
    return report['type'] === 'agent.turn_started';
  }
  function starts() { return reports.filter(isStart); }
  function send(frame: Record<string, unknown>) { socket.send(JSON.stringify(frame)); }
  async function close() {
    socket.terminate();
    await computer.close();
  }
  try {
    await once(socket, 'open');
    send(resumeFrame);
  } catch (error) {
    await close();
    throw error;
  }
  return { computer, socket, reports, starts, send, close };
}

function privateTurn(id: string) {
  return { type: 'turn', id, conversationId: id,
    assistantId: 'assistant', requesterId: 'alice', executionMode: 'restricted',
    text: 'Say hello again.', token: 'pending', expiresAt: Date.now() + 110_000 };
}

function stopTurn(id: string) {
  return { type: 'stop', turnId: id, conversationId: id };
}

async function waitForStarts(test: ProductionLaunches, count: number) {
  function started() { expect(test.starts()).toHaveLength(count); }
  await vi.waitFor(started, { timeout: 15_000 });
}

async function startTwoPrivate(test: ProductionLaunches) {
  test.send(privateTurn('first'));
  test.send(privateTurn('second'));
  await waitForStarts(test, 2);
}

function admit(test: ProductionLaunches, report: Record<string, unknown>) {
  const frame = { type: 'ack', sequence: report['sequence'],
    token: 'admitted', expiresAt: Date.now() + 40_000 };
  test.send(frame);
}

async function waitForRequests(test: ProductionLaunches, count: number) {
  async function forwarded() {
    const requests = await test.computer.requests();
    const trimmed = requests.trim();
    const lines = trimmed.split('\n');
    expect(lines).toHaveLength(count);
  }
  await vi.waitFor(forwarded, { timeout: 15_000 });
}

async function admitBoth(test: ProductionLaunches) {
  for (const report of test.starts()) admit(test, report);
  await waitForRequests(test, 2);
}

async function expectPrivateCallers(test: ProductionLaunches, count: number) {
  // Inspect only fixture processes; return decisions, never the callers themselves.
  const observed = await test.computer.exec('setpriv', '--reuid=1003', '--regid=1003',
    '--clear-groups', 'node', '--input-type=module', '-e', inspectCallers);
  expect(JSON.parse(observed)).toEqual({ distinct: count });
}

async function checksPrivateAdmissionAndCapacity() {
  const test = await productionLaunches();
  try {
    await startTwoPrivate(test);
    test.send(privateTurn('third'));
    const pong = once(test.socket, 'pong');
    test.socket.ping();
    await pong;
    expect(test.starts()).toHaveLength(2);
    await expectPrivateCallers(test, 2);
    let requests = '';
    try { requests = await test.computer.requests(); }
    catch { /* No model request before admission. */ }
    expect(requests).toBe('');
    await admitBoth(test);
  } finally {
    await test.close();
  }
}
it('gives two private launches distinct callers and waits for admission at capacity',
  checksPrivateAdmissionAndCapacity, 60_000);

async function checksPrivateCallerMatrix() {
  const test = await productionLaunches();
  try {
    await startTwoPrivate(test);
    await admitBoth(test);
    function nativeId(report: Record<string, unknown>) { return report['threadId']; }
    const starts = test.starts();
    const threads = starts.map(nativeId);
    const result = await test.computer.exec('node', '--input-type=module', '-e',
      matrix, JSON.stringify(threads));
    const rows: unknown = JSON.parse(result);
    if (!Array.isArray(rows)) throw new Error('Missing fixture statuses');
    expect(rows.slice(0, 2)).toEqual(expect.arrayContaining([[200, 403], [403, 200]]));
    expect(rows[2]).toEqual([403, 403]);
    expect(rows[3]).toEqual([401, 401]);
    await waitForRequests(test, 4);
  } finally {
    await test.close();
  }
}
it('allows only each private caller to use its own admitted thread',
  checksPrivateCallerMatrix, 60_000);

async function refusesUntrustedLaunchControl() {
  const test = await productionLaunches();
  try {
    await startTwoPrivate(test);
    await admitBoth(test);
    for (const uid of [1000, 1002]) {
      const result = await test.computer.exec('setpriv', `--reuid=${uid}`, `--regid=${uid}`,
        '--clear-groups', 'node', '--input-type=module', '-e', attempt);
      const expected = uid === 1000 ? [401, 'challenge'] : ['denied'];
      expect(JSON.parse(result)).toEqual(expected);
    }
    await waitForRequests(test, 2);
  } finally {
    await test.close();
  }
}
it('refuses private launch and grant control from ordinary and desktop processes',
  refusesUntrustedLaunchControl, 60_000);

async function prepareRoutine(test: ProductionLaunches) {
  const frame = { type: 'routine_prepare', id: 'routine', conversationId: 'routine',
    assistantId: 'assistant', requesterId: 'alice', expiresAt: Date.now() + 60_000 };
  test.send(frame);
  function isPrepared(report: Record<string, unknown>) {
    return report['type'] === 'routine_prepared';
  }
  function preparedRoutine() {
    const prepared = test.reports.find(isPrepared);
    expect(prepared).toBeDefined();
    return prepared!;
  }
  return vi.waitFor(preparedRoutine, { timeout: 10_000 });
}

async function startPreparedRoutine(test: ProductionLaunches) {
  const prepared = await prepareRoutine(test);
  const frame = { ...privateTurn('routine'), expiresAt: Date.now() + 50_000,
    threadId: prepared['threadId'], messageId: 'routine-input', rootId: 'routine-root',
    senderAttemptId: 'attempt' };
  test.send(frame);
  await waitForStarts(test, 3);
  const routineStart = test.starts()[2]!;
  expect(routineStart['threadId']).toBe(prepared['threadId']);
  admit(test, routineStart);
}

async function startsRoutineAndOrdinaryAfterStop() {
  const test = await productionLaunches();
  try {
    await startTwoPrivate(test);
    await admitBoth(test);
    test.send(stopTurn('first'));
    const onlySecondRemains = expectPrivateCallers.bind(undefined, test, 1);
    await vi.waitFor(onlySecondRemains, { timeout: 10_000 });
    await startPreparedRoutine(test);
    const ordinary = { type: 'turn', id: 'ordinary', conversationId: 'ordinary',
      assistantId: 'assistant', text: 'Say hello again.', token: 'pending',
      expiresAt: Date.now() + 50_000 };
    test.send(ordinary);
    await waitForStarts(test, 4);
    admit(test, test.starts()[3]!);
    await waitForRequests(test, 4);
  } finally {
    await test.close();
  }
}
it('keeps the other private turn while Stop frees space for routine and ordinary work',
  startsRoutineAndOrdinaryAfterStop, 60_000);

async function closesFailedNativeStart(fault: string) {
  const computer = await uploadComputer();
  const socket = new WebSocket(computer.url.replace('http:', 'ws:') + '/bridge',
    { headers: { 'x-bridge-token': computer.credential.value } });
  const opened = once(socket, 'open');
  const reports: Record<string, unknown>[] = [];
  function receive(bytes: Buffer) { reports.push(record(JSON.parse(bytes.toString()))); }
  socket.on('message', receive);
  try {
    // Replace only this disposable container's native boundary with a scripted child.
    const child = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
function receiveNative(line) {
  const message = JSON.parse(line);
  let result = {};
  if (message.method === 'thread/start') {
    writeFileSync('/tmp/fixture-start', 'ready');
    const fault = ${JSON.stringify(fault)};
    if (fault !== 'invalid native id' && fault !== 'foreign native id') return;
    const id = fault === 'foreign native id' ? 'already-bound' : '';
    result = { thread: { id, ephemeral: true, path: null, environments: [] } };
  }
  if (message.id) process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
}
lines.on('line', receiveNative);
`;
    const install = `require('node:fs').writeFileSync('/usr/local/bin/codex', process.argv[1]);`;
    await computer.exec('node', '-e', install, child);
    await opened;
    socket.send(JSON.stringify(resumeFrame));
    if (fault === 'foreign native id') {
      const owner = { ...privateTurn('owner'), expiresAt: Date.now() + 60_000 };
      socket.send(JSON.stringify(owner));
      function ownerStarted() {
        expect(reports).toContainEqual(expect.objectContaining({
          type: 'agent.turn_started', turnId: 'owner', threadId: 'already-bound' }));
      }
      await vi.waitFor(ownerStarted, { timeout: 10_000 });
    }
    const lifetime = fault === 'expiry' ? 3000 : 60_000;
    const failedTurn = { ...privateTurn('failed'), expiresAt: Date.now() + lifetime };
    socket.send(JSON.stringify(failedTurn));
    async function nativeStarted() {
      expect(await computer.read('/tmp/fixture-start')).toBe('ready');
    }
    await vi.waitFor(nativeStarted, { timeout: 10_000 });
    if (fault === 'disconnect') {
      socket.terminate();
    } else {
      function failed() {
        function isFailure(report: Record<string, unknown>) {
          return report['type'] === 'agent.turn_failed';
        }
        expect(reports.some(isFailure)).toBe(true);
      }
      await vi.waitFor(failed, { timeout: 10_000 });
    }
    if (fault === 'foreign native id') {
      socket.send(JSON.stringify(stopTurn('owner')));
    }
    async function noPrivateChild() {
      const result = await computer.exec('node', '-e', `
const { readdirSync, readFileSync } = require('node:fs');
let count = 0;
for (const pid of readdirSync('/proc')) {
  try { if (/^Uid:\\s+1003\\s/m.test(readFileSync('/proc/' + pid + '/status', 'utf8'))) count++; }
  catch {}
}
process.stdout.write(String(count));`);
      expect(result).toBe('0');
    }
    await vi.waitFor(noPrivateChild, { timeout: 10_000 });
  } finally {
    socket.terminate();
    await computer.close();
  }
}
it.each(['invalid native id', 'foreign native id', 'disconnect', 'expiry'])(
  'closes a pending production launch after %s', closesFailedNativeStart, 60_000);
