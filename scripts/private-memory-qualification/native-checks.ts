import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chownSync, existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync,
  statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { proveNativePair } from './native-process-proof.ts';

// Pin the Linux x64 executable from the integrity-checked Codex 0.159.2 npm release.
const nativeDigest = '1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e';
const object = z.record(z.string(), z.unknown());

function binaryDigest(binary: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(binary));
  return hash.digest('hex');
}

function pinnedBinary(): string {
  const wrapper = realpathSync('/usr/local/bin/codex');
  const binary = join(dirname(wrapper), '../../codex-linux-x64',
    'vendor/x86_64-unknown-linux-musl/bin/codex');
  assert.equal(binaryDigest(binary), nativeDigest);
  return realpathSync(binary);
}

function processIdentity(nativePid: number): string {
  const base = `/proc/${nativePid}`;
  const stat = readFileSync(`${base}/stat`, 'utf8');
  const fieldsText = stat.slice(stat.lastIndexOf(')') + 2);
  const fields = fieldsText.split(' ');
  assert.match(fields[19] ?? '', /^[0-9]+$/u);
  const runnerStat = readFileSync('/proc/self/stat', 'utf8');
  const runnerText = runnerStat.slice(runnerStat.lastIndexOf(')') + 2);
  const runnerFields = runnerText.split(' ');
  assert.equal(fields[2], runnerFields[2]);
  const limits = readFileSync(`${base}/limits`, 'utf8');
  assert.match(limits, /^Max core file size\s+0\s+0\s+bytes[ \t]*$/mu);
  const processes = /^Max processes\s+(\d+)\s+(\d+)\s+processes[ \t]*$/mu.exec(limits);
  assert(processes);
  const soft = Number(processes[1]);
  const hard = Number(processes[2]);
  assert(Number.isSafeInteger(hard) && soft > 0 && soft <= hard);
  const status = readFileSync(`${base}/status`, 'utf8');
  assert.match(status, /^Uid:\s+1003\s+1003\s+1003\s+1003$/mu);
  assert.match(status, /^NoNewPrivs:\s+1$/mu);
  return `${nativePid}:${fields[19]}:${fields[1]}:${fields[2]}`;
}

function nativeChild(
  wrapperPid: number, binary: string, home: string, childId: string,
): number {
  const children = readFileSync(`/proc/${wrapperPid}/task/${wrapperPid}/children`, 'utf8');
  const trimmed = children.trim();
  assert.match(trimmed, /^[1-9][0-9]*$/u);
  const nativePid = Number(trimmed);
  const base = `/proc/${nativePid}`;
  assert.equal(readlinkSync(`${base}/exe`), binary);
  const pinned = statSync(binary);
  const running = statSync(`${base}/exe`);
  assert.equal(running.dev, pinned.dev);
  assert.equal(running.ino, pinned.ino);
  assert.equal(readlinkSync(`${base}/cwd`), `${home}/work`);
  const environment = readFileSync(`${base}/environ`, 'utf8');
  const entries = environment.split('\0');
  for (const entry of [`HOME=${home}`, `CODEX_HOME=${home}/codex`,
    `CODEX_SQLITE_HOME=${home}/codex`, `TMPDIR=${home}/tmp`, `PROXY_CALLER_TOKEN=${childId}`]) {
    assert(entries.includes(entry));
  }
  return nativePid;
}

function checkConfiguration(value: unknown): void {
  const response = object.parse(value);
  const config = object.parse(response['config']);
  assert.equal(config['approval_policy'], 'never');
  assert.equal(config['sandbox_mode'], 'read-only');
  assert.equal(config['web_search'], 'disabled');
  assert.equal(config['project_doc_max_bytes'], 0);
  const features = object.parse(config['features']);
  for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host', 'apps',
    'plugins', 'remote_plugin', 'multi_agent', 'shell_snapshot', 'memories']) {
    assert.equal(features[feature], false);
  }
  const emptyConfiguration = {};
  assert.deepEqual(config['mcp_servers'], emptyConfiguration);
  assert.deepEqual(config['plugins'], emptyConfiguration);
  for (const key of ['tools', 'browser_use', 'computer_use', 'desktop', 'apps',
    'agents', 'notify', 'hooks']) {
    assert.equal(config[key], null);
  }
  const skills = object.parse(config['skills']);
  assert.equal(skills['include_instructions'], false);
  const history = object.parse(config['history']);
  assert.equal(history['persistence'], 'none');
}

function checkThread(value: unknown): string {
  const response = object.parse(value);
  const thread = object.parse(response['thread']);
  assert.equal(thread['ephemeral'], true);
  assert.equal(thread['path'], null);
  assert.deepEqual(thread['environments'], []);
  assert.deepEqual(thread['turns'], []);
  assert.equal(thread['cliVersion'], '0.159.2');
  return z.string().min(1).parse(thread['id']);
}

function prepareHome(
  home: string,
  configuration: typeof import('../../apps/computer/src/codex-config.ts'),
): void {
  assert.equal(statfsSync(home).type, 0x01021994);
  const directoryOptions = { mode: 0o700 };
  for (const directory of ['codex', 'work', 'tmp']) {
    mkdirSync(`${home}/${directory}`, directoryOptions);
    chownSync(`${home}/${directory}`, 1003, 1003);
  }
  const fileOptions = { mode: 0o444 };
  const config = configuration.privateConfig('gpt-6.1-sol');
  writeFileSync(`${home}/codex/config.toml`, config, fileOptions);
  const environments = configuration.privateEnvironments();
  writeFileSync(`${home}/codex/environments.toml`, environments, fileOptions);
  chownSync(home, 1003, 1003);
}

function superviseChild(
  child: ChildProcessByStdio<Writable, Readable, null>,
  codexConnection: typeof import('../../apps/computer/src/codex-connection.ts').codexConnection,
  home: string,
  childId: string,
  challengeId: string,
  recordPath: string,
) {
  let size = 0;
  const state = {
    failed: false,
    nativePid: undefined as number | undefined,
    nativeStart: undefined as string | undefined,
    wrapperStart: undefined as string | undefined,
    recordPath,
    cleanup: undefined as Promise<void> | undefined,
  };
  function fail(): void {
    state.failed = true;
    child.stdout.destroy();
    // Leave termination to cleanup so it can first record any native child.
  }
  function boundOutput(chunk: Buffer): void {
    size += chunk.length;
    if (size > 65_536) {
      fail();
    }
  }
  function closed(resolve: () => void): void {
    child.once('close', resolve);
  }
  const stopped = new Promise<void>(closed);
  child.on('error', fail);
  child.stdout.on('data', boundOutput);
  function message(value: Record<string, unknown>): void {
    if (value['id'] !== undefined) {
      fail();
    }
  }
  const handlers = { message, failed: fail };
  const connection = codexConnection(child.stdin, child.stdout, handlers);
  return { child, state, stopped, connection, home, childId, challengeId };
}

type SupervisedChild = ReturnType<typeof superviseChild>;

function checkPairProtection(supervised: SupervisedChild, binary: string): void {
  const { child, state } = supervised;
  assert(child.pid && state.nativePid && state.recordPath);
  const binding = { challengeId: supervised.challengeId,
    wrapperPid: child.pid, childPid: state.nativePid,
    recordPath: state.recordPath, childBinary: binary };
  assert.equal(proveNativePair(binding), true);
}

function recordNativeLaunch(supervised: SupervisedChild): void {
  const { child, state } = supervised;
  assert(child.pid && state.nativePid);
  const wrapperStart = processStart(child.pid)?.split(':')[1];
  const nativeStart = processStart(state.nativePid)?.split(':')[1];
  assert(wrapperStart && nativeStart);
  const contents = `${supervised.challengeId} ${child.pid} ${wrapperStart} ` +
    `${state.nativePid} ${nativeStart}\n`;
  writeFileSync(state.recordPath, contents, { flag: 'w' });
}

async function checkNativeRpc(
  supervised: SupervisedChild,
  binary: string,
) {
  const { child, state, connection, home, childId } = supervised;
  assert.equal(state.failed, false);
  const initialise = {
    clientInfo: { name: 'qualification', version: `${supervised.challengeId}.${childId}` },
    capabilities: { experimentalApi: true },
  };
  await connection.rpc('initialize', initialise);
  const initialized = {};
  connection.notify('initialized', initialized);
  assert(child.pid);
  const nativePid = nativeChild(child.pid, binary, home, childId);
  state.nativePid = nativePid;
  state.nativeStart = processStart(nativePid);
  recordNativeLaunch(supervised);
  checkPairProtection(supervised, binary);
  const wrapperIdentity = processIdentity(child.pid);
  const identity = processIdentity(nativePid);
  const configParams = { includeLayers: false };
  const configResponse = await connection.rpc('config/read', configParams);
  checkPairProtection(supervised, binary);
  checkConfiguration(configResponse);
  const startParams = {
    model: 'gpt-6.1-sol', ephemeral: true, environments: [],
    approvalPolicy: 'never', sandbox: 'read-only',
  };
  const startResponse = await connection.rpc('thread/start', startParams);
  checkPairProtection(supervised, binary);
  const threadId = checkThread(startResponse);
  const observation = { nativePid, identity, wrapperIdentity, threadId };
  await checkStillRunning(supervised, binary, observation);
  return observation;
}

type NativeObservation = Awaited<ReturnType<typeof checkNativeRpc>>;

async function heldModel(): Promise<{ bind(caller: string, thread: string): void;
  wait(): Promise<void>; close(): Promise<void> }> {
  let received: (() => void) | undefined;
  let expectedCaller: string | undefined;
  let expectedThread: string | undefined;
  const requestReceived = new Promise<void>(function ready(resolve): void {
    received = resolve;
  });
  function accept(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse): void {
    if (!expectedCaller || !expectedThread || request.method !== 'POST' ||
        request.url !== '/v1/responses' ||
        request.headers.authorization !== `Bearer ${expectedCaller}` ||
        request.headers['session-id'] !== expectedThread) {
      response.destroy();
      return;
    }
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    received?.();
  }
  const server: Server = createServer(accept);
  await new Promise<void>(function listen(resolve, reject): void {
    server.once('error', reject);
    server.listen(8080, '127.0.0.1', function listening(): void {
      server.off('error', reject);
      resolve();
    });
  });
  async function wait(): Promise<void> {
    await new Promise<void>(function held(resolve, reject): void {
      function expired(): void {
        reject(new Error('native_turn_not_held'));
      }
      const timer = setTimeout(expired, 10_000);
      function ready(): void {
        clearTimeout(timer);
        resolve();
      }
      requestReceived.then(ready, reject);
    });
  }
  async function close(): Promise<void> {
    server.closeAllConnections();
    await new Promise<void>(function stopped(resolve): void {
      server.close(function closed(): void { resolve(); });
    });
  }
  function bind(caller: string, thread: string): void {
    assert(!expectedCaller && !expectedThread);
    expectedCaller = caller;
    expectedThread = thread;
  }
  return { bind, wait, close };
}

async function checkStillRunning(
  supervised: SupervisedChild, binary: string, observation: NativeObservation,
): Promise<void> {
  const { child, state, connection, home, childId } = supervised;
  const { nativePid, identity, wrapperIdentity, threadId } = observation;
  // Read live metadata; fetching saved turns would require a rollout on disk.
  const readParams = { threadId, includeTurns: false };
  checkPairProtection(supervised, binary);
  const readResponse = await connection.rpc('thread/read', readParams);
  checkPairProtection(supervised, binary);
  assert.equal(checkThread(readResponse), threadId);
  assert(child.pid);
  assert.equal(nativeChild(child.pid, binary, home, childId), nativePid);
  assert.equal(processIdentity(nativePid), identity);
  assert.equal(processIdentity(child.pid), wrapperIdentity);
  assert.equal(statfsSync(home).type, 0x01021994);
  assert.equal(state.failed, false);
}

function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fieldsText = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = fieldsText.split(' ');
    const start = fields[19];
    assert.match(start ?? '', /^[0-9]+$/u);
    // Keep the birth identity stable even if an exiting wrapper leaves an orphan.
    return `${pid}:${start}`;
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

function sameProcess(pid: number, start: string | undefined): boolean {
  return start !== undefined && processStart(pid) === start;
}

function signalOwnedProcess(
  pid: number, start: string | undefined, signal: NodeJS.Signals,
): boolean {
  if (sameProcess(pid, start)) {
    signalProcess(pid, signal);
    return true;
  }
  return false;
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function processState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2];
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      throw error;
    }
    return undefined;
  }
}

async function freezeWrapper(pid: number, start: string): Promise<number[]> {
  if (!signalOwnedProcess(pid, start, 'SIGSTOP')) {
    return [];
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!sameProcess(pid, start)) {
      return [];
    }
    const state = processState(pid);
    if (state === undefined || state === 'Z') {
      return [];
    }
    if (state === 'T') {
      const text = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
      const trimmed = text.trim();
      if (trimmed === '') {
        return [];
      }
      assert.match(trimmed, /^[1-9][0-9]*$/u);
      return [Number(trimmed)];
    }
    await delay(10);
  }
  throw new Error('native_cleanup_failed');
}

async function checkGone(pid: number, start: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!sameProcess(pid, start)) {
      return;
    }
    await delay(10);
  }
  throw new Error('native_cleanup_failed');
}

function rememberProcess(processes: Map<number, string>, pid: number): void {
  if (processes.has(pid)) {
    return;
  }
  const start = processStart(pid);
  if (start !== undefined) {
    processes.set(pid, start);
  }
}

async function stopOwnedChild(supervised: SupervisedChild): Promise<void> {
  const { child, state, stopped } = supervised;
  const processes = new Map<number, string>();
  if (state.nativePid !== undefined && state.nativeStart !== undefined) {
    processes.set(state.nativePid, state.nativeStart);
  }
  try {
    if (child.pid !== undefined && state.wrapperStart !== undefined) {
      // Stop the wrapper before reading its children, so startup cannot race cleanup.
      const children = await freezeWrapper(child.pid, state.wrapperStart);
      for (const pid of children) {
        rememberProcess(processes, pid);
      }
    }
    for (const [pid, start] of processes) {
      signalOwnedProcess(pid, start, 'SIGKILL');
    }
  } finally {
    child.stdin.destroy();
    if (child.pid !== undefined) {
      signalOwnedProcess(child.pid, state.wrapperStart, 'SIGKILL');
    }
    await stopped;
  }
  if (child.pid !== undefined && state.wrapperStart !== undefined) {
    processes.set(child.pid, state.wrapperStart);
  }
  for (const [pid, start] of processes) {
    await checkGone(pid, start);
  }
}

function stopChild(supervised: SupervisedChild): Promise<void> {
  // Reuse failures too: another cleanup must never signal released process IDs.
  supervised.state.cleanup ??= stopOwnedChild(supervised);
  return supervised.state.cleanup;
}

function removeHome(home: string): void {
  const removalOptions = { recursive: true, force: true };
  rmSync(home, removalOptions);
  assert.equal(existsSync(home), false);
}

async function checkPair(
  first: SupervisedChild, second: SupervisedChild, binary: string,
  model: Awaited<ReturnType<typeof heldModel>>,
  firstObservation: NativeObservation, secondObservation: NativeObservation,
): Promise<void> {
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.childId, second.childId);
  assert.notEqual(first.child.pid, second.child.pid);
  assert.notEqual(firstObservation.nativePid, secondObservation.nativePid);
  assert.notEqual(firstObservation.identity, secondObservation.identity);
  assert.notEqual(firstObservation.wrapperIdentity, secondObservation.wrapperIdentity);
  assert.notEqual(firstObservation.threadId, secondObservation.threadId);
  model.bind(first.childId, firstObservation.threadId);
  const input = [{ type: 'text', text: 'qualification', text_elements: [] }];
  const turn = { threadId: firstObservation.threadId, input };
  await first.connection.rpc('turn/start', turn);
  await model.wait();
  checkPairProtection(first, binary);
  checkPairProtection(second, binary);
  await checkStillRunning(first, binary, firstObservation);
  await stopChild(first);
  removeHome(first.home);
  await checkStillRunning(second, binary, secondObservation);
  await stopChild(second);
  removeHome(second.home);
}

async function cleanup(children: SupervisedChild[], homes: string[],
  records: string[]): Promise<void> {
  const stops = children.map(stopChild);
  const results = await Promise.allSettled(stops);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw new Error('native_cleanup_failed');
    }
  }
  for (const home of homes) {
    removeHome(home);
  }
  for (const record of records) {
    rmSync(record, { force: true });
  }
}

export async function checkNative(challengeId: string): Promise<void> {
  z.uuid().parse(challengeId);
  const binary = pinnedBinary();
  // Keep the supervisor's lock and scratch files off persistent storage.
  assert.equal(statfsSync('/run').type, 0x01021994);
  // Load only shipped production helpers, after refusing a missing or replaced executable.
  const { privateCodexLaunch } = await import('../../apps/computer/src/private-codex.ts');
  const configuration = await import('../../apps/computer/src/codex-config.ts');
  const { codexConnection } = await import('../../apps/computer/src/codex-connection.ts');
  assert.equal(statfsSync('/home/private').type, 0x01021994);
  const children: SupervisedChild[] = [];
  const homes: string[] = [];
  const records: string[] = [];
  const observations: NativeObservation[] = [];
  const model = await heldModel();
  try {
    for (let index = 0; index < 2; index++) {
      const childId = randomUUID();
      const home = `/home/private/turn-${childId}`;
      const recordPath = `/run/opencrane-native-${childId}.identity`;
      // Record ownership before a crash can interrupt home creation.
      writeFileSync(recordPath, `${challengeId}\n`, { flag: 'wx', mode: 0o600 });
      records.push(recordPath);
      const directoryOptions = { mode: 0o700 };
      // Refuse an existing home before cleanup can remove it.
      mkdirSync(home, directoryOptions);
      homes.push(home);
      prepareHome(home, configuration);
      const launch = privateCodexLaunch(home, childId);
      // Keep native children in the supervisor's process group for collector-loss cleanup.
      const child = spawn(launch.command, launch.args, launch.options);
      const supervised = superviseChild(
        child, codexConnection, home, childId, challengeId, recordPath,
      );
      children.push(supervised);
      if (child.pid !== undefined) {
        supervised.state.wrapperStart = processStart(child.pid);
      }
      // Measure each native child before starting another wrapper, so cleanup knows what to stop.
      observations.push(await checkNativeRpc(supervised, binary));
    }
    const [first, second] = children;
    const [firstObservation, secondObservation] = observations;
    assert(first && second && firstObservation && secondObservation);
    await checkPair(first, second, binary, model, firstObservation, secondObservation);
  } finally {
    try {
      await cleanup(children, homes, records);
    } finally {
      await model.close();
    }
  }
}
