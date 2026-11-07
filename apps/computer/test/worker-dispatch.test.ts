import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { workerRegistrations } from '../src/worker-registrations.ts';
import { dispatchWorker } from '../src/worker-dispatch.ts';
import { record } from '../src/http.ts';

const npmArgs = ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'];
const gitArgs = ['git', 'clone', '--no-checkout', 'https://github.com/example/demo.git'];
const lockfile = '{"lockfileVersion":3,"packages":{"":{"dependencies":{"demo":"1.2.3"}},' +
  '"node_modules/demo":{"version":"1.2.3",' +
  '"resolved":"https://registry.npmjs.org/demo/-/demo-1.2.3.tgz",' +
  '"integrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAA=="}}}';
const roots: string[] = [];

function fixture(argv = gitArgs, input = '') {
  const root = fs.mkdtempSync(`${homedir()}/worker-dispatch-`);
  roots.push(root);
  const binding = { executorId: 'executor-1', siloId: 'silo-1', personId: 'person-1',
    computerId: 'computer-1', processId: 'process-1', generation: 3 };
  const params = { processId: binding.processId, argv, cwd: 'file:///workspace', env: {},
    tty: false, pipeStdin: false, arg0: null,
    metadata: { threadId: 'thread-1', toolCallId: 'call-1' } };
  const hash = createHash('sha256');
  hash.update(JSON.stringify([argv, params.cwd, input]));
  const registration = { ...binding, ...params.metadata, turnId: 'turn-1',
    operationId: 'operation-1', operationDigest: hash.digest('hex'),
    host: argv[0] === 'npm' ? 'registry.npmjs.org' : 'github.com',
    port: 443, expiresAt: 2000 };
  const store = workerRegistrations(binding, now);
  store.register(registration, input);
  const frame = Buffer.from(`${JSON.stringify({ id: 1, method: 'process/start', params })}\n`);
  const starts: string[] = [];
  function launch(plan: unknown, path: string) {
    starts.push(path);
    expect(JSON.stringify(plan)).not.toContain('package-lock.json');
    return { exit: Promise.resolve(0), kill() {} };
  }
  function active(identity: { turnId: string; operationId: string }) {
    return identity.turnId === 'turn-1' && identity.operationId === 'operation-1';
  }
  const ready = { isolated: true, scanner: true, egress: true };
  const state = { root, binding, params, registration, store, frame, starts, launch,
    active, ready };
  function dispatch() {
    return dispatchWorker({ frame: state.frame, binding, lookup: store.lookup, parent: root,
      active: state.active, ready, launch: state.launch, now });
  }
  return { ...state, dispatch, state };
}

function now() { return 1000; }
function openDescriptorCount() {
  return fs.readdirSync('/proc/self/fd').length;
}
function cleanup() {
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}
afterEach(cleanup);

async function startsOneFixedOperation(argv: string[], input: string) {
  const test = fixture(argv, input);
  const descriptorsBefore = openDescriptorCount();
  const result = await test.dispatch();
  expect(result).toBe('awaiting_scan');
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1/operation`)).toBe(true);
  expect(test.starts).toEqual([`${test.root}/operation-1`]);
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toHaveLength(1);
}
it('starts one checked Git operation and never starts it again', async () => {
  await startsOneFixedOperation(gitArgs, '');
});
it('starts one checked npm operation with only prepared input', async () => {
  await startsOneFixedOperation(npmArgs, lockfile);
});

async function refusesForeign(field: string) {
  const test = fixture();
  if (field === 'missing registration') test.store.disconnect(test.binding.executorId);
  if (field === 'forged registration') {
    const request = record(JSON.parse(test.frame.toString('utf8')));
    const params = record(request['params']);
    params['registration'] = { ...test.registration, executorId: 'forged' };
    test.state.frame = Buffer.from(`${JSON.stringify(request)}\n`);
  }
  if (field === 'wrong computer') test.binding.computerId = 'another-computer';
  if (field === 'wrong turn') test.state.active = identity => identity.turnId === 'another-turn';
  if (field === 'wrong operation') {
    test.state.active = identity => identity.operationId === 'another-operation';
  }
  if (field === 'sibling command') test.binding.executorId = 'sibling-executor';
  if (field === 'ended turn') test.state.active = () => false;
  if (field === 'revoked turn') test.state.active = () => false;
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toEqual([]);
}
it.each(['missing registration', 'forged registration', 'wrong computer', 'wrong turn', 'wrong operation',
  'sibling command', 'ended turn', 'revoked turn'])(
  'starts no process for %s', refusesForeign);

async function refusesUnready(field: keyof ReturnType<typeof fixture>['ready']) {
  const test = fixture();
  test.ready[field] = false;
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toEqual([]);
}
it.each(['isolated', 'scanner', 'egress'] as const)(
  'starts no process without %s readiness', refusesUnready);

async function removesInputAfterFinalRefusal() {
  const test = fixture();
  const descriptorsBefore = openDescriptorCount();
  let activeChecks = 0;
  function activeOnlyBeforePreparation() {
    activeChecks += 1;
    return activeChecks === 1;
  }
  test.state.active = activeOnlyBeforePreparation;
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(activeChecks).toBe(2);
  expect(test.starts).toEqual([]);
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1`)).toBe(false);
}
it('removes prepared input when the final turn check refuses launch',
  removesInputAfterFinalRefusal);

async function refusesUnsafe(argv: string[], input: string) {
  const test = fixture(argv, input);
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toEqual([]);
}
it('refuses caller arguments, scripts, filters and workspace traversal', async () => {
  await refusesUnsafe(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund',
    '--script-shell=/bin/sh'], lockfile);
  await refusesUnsafe(['git', '-c', 'filter.x.clean=/bin/sh', 'clone',
    'https://github.com/example/demo.git'], '');
  await refusesUnsafe(['git', 'clone', '--no-checkout',
    'https://github.com/example/../demo.git'], '');
});

async function unknownAfterCrash() {
  const test = fixture();
  const descriptorsBefore = openDescriptorCount();
  test.state.launch = (_plan, path) => {
    test.starts.push(path);
    return { exit: Promise.reject(new Error('private canary')), kill() {} };
  };
  await expect(test.dispatch()).resolves.toBe('unknown');
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1/operation`)).toBe(true);
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toHaveLength(1);
}
it('leaves a crashed worker unknown and never resends the command', unknownAfterCrash);

async function unknownAfterLostExit() {
  vi.useFakeTimers();
  const test = fixture();
  const descriptorsBefore = openDescriptorCount();
  let killed = false;
  test.state.launch = (_plan, path) => {
    test.starts.push(path);
    return { exit: new Promise<number>(() => {}), kill() { killed = true; } };
  };
  const result = test.dispatch();
  await vi.advanceTimersByTimeAsync(300_000);
  await expect(result).resolves.toBe('unknown');
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1/operation`)).toBe(true);
  expect(killed).toBe(true);
  await expect(test.dispatch()).resolves.toBe('refused');
  expect(test.starts).toHaveLength(1);
}
it('leaves a missing exit unknown and never resends after its wall limit', unknownAfterLostExit);

async function unknownAfterLaunchFailure() {
  const test = fixture();
  const descriptorsBefore = openDescriptorCount();
  function failLaunch(): never {
    throw new Error('private canary');
  }
  test.state.launch = failLaunch;
  await expect(test.dispatch()).resolves.toBe('unknown');
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1/operation`)).toBe(true);
  await expect(test.dispatch()).resolves.toBe('refused');
}
it('closes preparation descriptors when the launcher throws', unknownAfterLaunchFailure);

async function unknownAfterNonZeroExit() {
  const test = fixture();
  const descriptorsBefore = openDescriptorCount();
  function failedProcess() {
    return { exit: Promise.resolve(1), kill() {} };
  }
  test.state.launch = failedProcess;
  await expect(test.dispatch()).resolves.toBe('unknown');
  expect(openDescriptorCount()).toBe(descriptorsBefore);
  expect(fs.existsSync(`${test.root}/operation-1/operation`)).toBe(true);
}
it('closes preparation descriptors after a non-zero exit', unknownAfterNonZeroExit);

async function recordingProcess() {
  const test = fixture();
  const marker = `${test.root}/recorded`;
  test.state.launch = (_plan, _path) => {
    const child = spawn(process.execPath, ['-e',
      'require("node:fs").writeFileSync(process.argv[1], "started")', marker],
    { stdio: 'ignore' });
    return { exit: new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    }), kill() { child.kill('SIGKILL'); } };
  };
  await expect(test.dispatch()).resolves.toBe('awaiting_scan');
  expect(fs.readFileSync(marker, 'utf8')).toBe('started');
}
it('starts a recording process only after a checked dispatch', recordingProcess);
