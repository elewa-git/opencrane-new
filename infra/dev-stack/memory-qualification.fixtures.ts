import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as files from 'node:fs';
import * as asyncFiles from 'node:fs/promises';
import { homedir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });
vi.mock('../../scripts/private-memory-qualification/bridge-proof.ts', { spy: true });
vi.mock('../../scripts/private-memory-qualification/supervisor-proof.ts', { spy: true });
const root = new URL('../../', import.meta.url).pathname.slice(0, -1);
const directory = `${homedir()}/.config/opencrane/dev-stack-1`;
const targetPath = '/etc/opencrane/private-memory-qualification.json';
const resultPath = '/etc/opencrane/private-memory-qualification-result.json';
const containerId = 'c'.repeat(64);
const sourceSha = 'a'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const originalStat = files.statSync(import.meta.filename);
let target: string;
let saved: string;
let pending: string;
let container: ReturnType<typeof freshContainer>;
let stream: { created: string; lastSequence: number; eventCount: number };
let host: string;
let revision: string;
let journeys: number;
let writes: number;
let change: (response: Record<string, unknown>) => void;
let release: (() => void) | undefined;
let pause: boolean;

function freshContainer() {
  return {
    Id: containerId, Image: imageDigest, Created: '2026-01-01T00:00:00Z', RestartCount: 0,
    State: { Running: true, StartedAt: '2026-01-01T00:00:01Z' },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [] as { Destination: string }[],
    Config: { Env: ['SILO_ID=fixture-silo'], Labels: {
      'com.docker.compose.project': 'opencrane-dev-1',
      'com.docker.compose.project.working_dir': `${root}/infra/dev-stack`,
    } },
  };
}
function unchanged(): void {}
function protectedStat() {
  const prototype = Object.getPrototypeOf(originalStat) as object | null;
  const stat = Object.create(prototype) as files.Stats;
  Object.assign(stat, originalStat);
  stat.uid = 0;
  stat.mode = 0o100600;
  stat.size = 150;
  return stat;
}
function readProtected(descriptor: unknown): string {
  if (descriptor === 42) {
    return target;
  }
  if (descriptor === 43) {
    return saved;
  }
  return originalSync.readFileSync(descriptor as string, 'utf8');
}
function openProtected(path: unknown): number {
  if (path === targetPath) {
    return 42;
  }
  if (path === resultPath) {
    return 43;
  }
  throw new Error('Unexpected private open');
}
async function readLocal(path: unknown): Promise<string> {
  if (path === `${directory}/stack-owner`) {
    return `worktree=${root}\npid=1\n`;
  }
  if (path === `${directory}/settings.env`) {
    return 'SILO_ID=fixture-silo\n';
  }
  if (path instanceof URL && path.pathname.endsWith('/supervisor.mjs')) {
    return supervisorSource;
  }
  throw new Error('Unexpected local read');
}
const supervisorSource = await asyncFiles.readFile(
  new URL('../../scripts/private-memory-qualification/supervisor.mjs', import.meta.url), 'utf8');
const originalSync = await vi.importActual<typeof files>('node:fs');
function writeResult(_path: unknown, content: unknown): void {
  pending = String(content);
  writes += 1;
}
function renameResult(): void {
  saved = pending;
}
function docker(file: unknown, args: unknown): string {
  if (file === '/usr/bin/git') {
    return sourceSha;
  }
  expect(file).toBe('/usr/bin/docker');
  const command = args as string[];
  expect(command.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
  if (command[2] === 'info') {
    return JSON.stringify(host);
  }
  if (command[2] === 'inspect') {
    const containers = [container];
    return JSON.stringify(containers);
  }
  expect(command.slice(2, 4)).toEqual(['image', 'inspect']);
  const image = { Id: container.Image,
    Config: { Labels: { 'org.opencontainers.image.revision': revision } } };
  const images = [image];
  return JSON.stringify(images);
}
function spawnDocker(file: string, args: readonly string[] = []): ReturnType<typeof spawn> {
  expect(file).toBe('/usr/bin/docker');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const streams = { stdin, stdout, stderr };
  const childProcess = new ChildProcess();
  const child = Object.assign(childProcess, streams);
  function receive(buffer: Buffer): void {
    function reply(): void {
      const command = JSON.parse(args.at(-1)!) as string[];
      let response: unknown = stream;
      if (!command.includes('--eval')) {
        expect(command.at(-1)).toBe('/app/scripts/private-memory-qualification/journey.mjs');
        const input = JSON.parse(buffer.toString()) as string;
        const request = JSON.parse(input) as Record<string, unknown>;
        const receipt = { ...request, observedAt: Date.now(), result: 'PASS', complete: true };
        journeys += 1;
        stream.eventCount = 1;
        stream.lastSequence = 1;
        change(receipt);
        response = receipt;
      }
      function cleanedUp(): void {
        stdout.emit('data', Buffer.from(JSON.stringify(response)));
        child.emit('close', 0);
      }
      if (pause && !command.includes('--eval')) {
        release = cleanedUp;
        return;
      }
      cleanedUp();
    }
    queueMicrotask(reply);
  }
  stdin.on('data', receive);
  return child;
}
function prepare(): void {
  vi.resetModules();
  vi.stubEnv('DEV_STACK_ID', '1');
  vi.stubEnv('MEMORY_CLAIMED_ID', '1');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
  target = JSON.stringify({ containerId, computerContainerId: 'd'.repeat(64),
    siloId: 'fixture-silo' });
  saved = 'prior evidence';
  pending = '';
  container = freshContainer();
  stream = { created: '2026-01-01T00:00:02Z', eventCount: 0, lastSequence: 0 };
  host = 'fixture-host';
  revision = sourceSha;
  journeys = 0;
  writes = 0;
  change = unchanged;
  pause = false;
  release = undefined;
  vi.mocked(files.openSync).mockImplementation(openProtected);
  vi.mocked(files.readFileSync).mockImplementation(readProtected);
  vi.mocked(files.fstatSync).mockImplementation(protectedStat);
  function parentStat() {
    const stat = protectedStat();
    stat.mode = 0o40755;
    return stat;
  }
  vi.mocked(files.lstatSync).mockImplementation(parentStat);
  vi.mocked(files.closeSync).mockReturnValue(undefined);
  vi.mocked(files.writeFileSync).mockImplementation(writeResult);
  vi.mocked(files.renameSync).mockImplementation(renameResult);
  vi.mocked(asyncFiles.readFile).mockImplementation(readLocal);
  async function realpath(path: unknown): Promise<string> {
    return String(path);
  }
  vi.mocked(asyncFiles.realpath).mockImplementation(realpath);
  vi.mocked(execFileSync).mockImplementation(docker);
  vi.mocked(spawn).mockImplementation(spawnDocker);
}
function restore(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
}
beforeEach(prepare);
afterEach(restore);
async function launch(signal?: AbortSignal): Promise<void> {
  const bridgeProof = await import('../../scripts/private-memory-qualification/bridge-proof.ts');
  const supervisorProof = await import(
    '../../scripts/private-memory-qualification/supervisor-proof.ts');
  vi.mocked(bridgeProof.containerIdentity).mockReturnValue({
    Id: 'd'.repeat(64), Image: imageDigest,
    State: { Running: true, StartedAt: container.State.StartedAt, Pid: 4321 },
  });
  vi.mocked(bridgeProof.proveComputerBridge).mockResolvedValue(true);
  vi.mocked(supervisorProof.proveComputerSupervisor).mockResolvedValue(true);
  const launcher = await import('./memory-qualification.ts');
  await launcher.prepareMemoryQualification(signal);
}
async function collectsOnceBeforeContinuation(): Promise<void> {
  await launch();
  expect(journeys).toBe(11);
  expect(JSON.parse(saved)).toHaveProperty('result', 'PASS');
  expect(stream.lastSequence).toBe(1);
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(journeys).toBe(11);
}
it('collects once and leaves the populated install without a second bootstrap',
  collectsOnceBeforeContinuation);
async function refusesLocalTarget(kind: string): Promise<void> {
  if (kind === 'claim') {
    vi.stubEnv('MEMORY_CLAIMED_ID', '2');
  }
  if (kind === 'owner') {
    vi.stubEnv('DEV_STACK_ID', '0');
  }
  if (kind === 'worktree') {
    async function foreign(): Promise<string> {
      return 'worktree=/other\n';
    }
    vi.mocked(asyncFiles.readFile).mockImplementation(foreign);
  }
  if (kind === 'container') {
    container.Id = 'd'.repeat(64);
  }
  if (kind === 'source') {
    revision = 'd'.repeat(40);
  }
  if (kind === 'container silo') {
    container.Config.Env = ['SILO_ID=other'];
  }
  if (kind === 'malformed target') {
    target = '{}';
  }
  if (kind === 'project') {
    container.Config.Labels['com.docker.compose.project'] = 'owner';
  }
  if (kind === 'container worktree') {
    container.Config.Labels['com.docker.compose.project.working_dir'] = '/other';
  }
  if (kind === 'silo') {
    target = JSON.stringify({ containerId, siloId: 'other' });
  }
  if (kind === 'unsafe' || kind === 'writable target') {
    function unsafe() {
      const stat = protectedStat();
      if (kind === 'unsafe') {
        stat.uid = 1000;
      }
      if (kind === 'writable target') {
        stat.mode = 0o100620;
      }
      return stat;
    }
    vi.mocked(files.fstatSync).mockImplementation(unsafe);
  }
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(writes).toBe(0);
  expect(journeys).toBe(0);
  expect(saved).toBe('prior evidence');
}
it.each(['claim', 'owner', 'worktree', 'container', 'project', 'container worktree',
  'silo', 'unsafe', 'source', 'container silo', 'malformed target', 'writable target'])('refuses %s before collection and preserves prior evidence', refusesLocalTarget);
async function refusesBeforeJourney(kind: string): Promise<void> {
  if (kind === 'mounted') {
    container.Mounts = [{ Destination: '/app' }];
  }
  if (kind === 'writable') {
    container.HostConfig.ReadonlyRootfs = false;
  }
  if (kind === 'used') {
    stream.eventCount = 1;
  }
  if (kind === 'purged') {
    stream.lastSequence = 5;
  }
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(journeys).toBe(0);
}
it.each(['mounted', 'writable', 'used', 'purged'])(
  'refuses %s installation before any journey or bootstrap', refusesBeforeJourney);
async function refusesReplacement(kind: string): Promise<void> {
  function replace(): void {
    if (kind === 'host') {
      host = 'replacement-host';
    }
    if (kind === 'image') {
      container.Image = `sha256:${'d'.repeat(64)}`;
    }
    if (kind === 'start') {
      container.State.StartedAt = '2026-01-01T00:00:02Z';
    }
    if (kind === 'stream') {
      stream.created = '2026-01-01T00:00:03Z';
    }
  }
  change = replace;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(journeys).toBe(1);
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it.each(['host', 'image', 'start', 'stream'])(
  'stops on replaced %s identity', refusesReplacement);
async function refusesIncomplete(status: string): Promise<void> {
  function incomplete(receipt: Record<string, unknown>): void {
    receipt['result'] = status;
    receipt['complete'] = false;
    if (status === 'malformed') {
      delete receipt['challengeId'];
    }
  }
  change = incomplete;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(JSON.parse(saved)).not.toHaveProperty('result', 'PASS');
}
it.each(['PARTIAL', 'NOT RUN', 'malformed'])(
  'never continues from %s results', refusesIncomplete);

async function explainsUnsafeHost(setting: string): Promise<void> {
  const observations = new Map([
    ['/proc/swaps', 'Filename Type Size Used Priority\n'],
    ['/proc/sys/kernel/core_pattern', '\n'],
    ['/proc/sys/kernel/core_uses_pid', '0\n'],
    ['/proc/sys/fs/suid_dumpable', '0\n'],
    ['/sys/kernel/kexec_crash_loaded', '0\n'],
    ['/proc/self/limits', 'Max core file size 0 0 bytes\n'],
    ['/proc/1/limits', 'Max core file size 0 0 bytes\n'],
  ]);
  const readDirectoryNames: (path: string) => string[] = files.readdirSync;
  vi.mocked(readDirectoryNames).mockReturnValue(['1', 'self']);
  if (setting === 'swap') {
    observations.set('/proc/swaps',
      'Filename Type Size Used Priority\n/private/swap file 1 0 -2\n');
  } else {
    observations.set('/proc/sys/kernel/core_pattern', '|/private/core-collector %p\n');
  }
  function readObservation(path: unknown): string {
    if (path === '/proc/self/cgroup') {
      throw new Error('Fixture cgroup is unavailable');
    }
    const observation = observations.get(String(path));
    if (observation !== undefined) {
      return observation;
    }
    return readProtected(path);
  }
  vi.mocked(files.readFileSync).mockImplementation(readObservation);
  const request = {
    sourceSha, imageDigest, environmentId: 'c'.repeat(64),
    siloId: `sha256:${'d'.repeat(64)}`, installationId: `sha256:${'e'.repeat(64)}`,
    freshInstall: true, name: 'privateTurns',
    runId: '11111111-1111-4111-8111-111111111111',
    challengeId: '22222222-2222-4222-8222-222222222222',
  };
  const { runJourney } = await import('../../scripts/private-memory-qualification/journey.ts');
  const refusal = await runJourney(JSON.stringify(request));
  const expectedRefusal = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'swap_measurement_failed' };
  expect(refusal).toEqual(expectedRefusal);
  function refuseHost(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    Object.assign(receipt, refusal);
  }
  change = refuseHost;
  const message = 'Container swap protection could not be measured.';
  const expectedError = new Error(`memory_qualification_refused: host_refused. ${message}`);
  await expect(launch()).rejects.toThrow(expectedError);
  const expectedResult = { ...expectedRefusal, message };
  expect(JSON.parse(saved)).toEqual(expectedResult);
  expect(journeys).toBe(1);
}
it.each(['swap', 'core dumps'])(
  'explains enabled %s in the launcher error and saved refusal', explainsUnsafeHost);

async function withdrawsEarlierPass(): Promise<void> {
  await launch();
  expect(JSON.parse(saved)).toHaveProperty('result', 'PASS');
  vi.resetModules();
  stream.eventCount = 0;
  stream.lastSequence = 0;
  function fail(receipt: Record<string, unknown>): void {
    delete receipt['challengeId'];
  }
  change = fail;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it('a fresh failed collection withdraws an earlier saved PASS', withdrawsEarlierPass);
async function waitsForCleanup(kind: string): Promise<void> {
  pause = true;
  const controller = new AbortController();
  let settled = false;
  function finished(): void {
    settled = true;
  }
  const operation = launch(controller.signal);
  const outcome = expect(operation).rejects.toThrow('memory_qualification_refused');
  void operation.then(finished, finished);
  function waiting(): void {
    expect(release).toBeTypeOf('function');
  }
  await vi.waitFor(waiting);
  if (kind === 'signal') {
    process.emit('SIGTERM');
  }
  if (kind === 'abort') {
    controller.abort();
  }
  expect(settled).toBe(false);
  pause = false;
  release!();
  await outcome;
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it.each(['signal', 'abort'])(
  '%s cancellation waits for collector cleanup and withdraws its result', waitsForCleanup);

async function refusesSavedResult(kind: string): Promise<void> {
  function replaceResult(): void {
    saved = pending;
    if (JSON.parse(pending).result === 'PASS') {
      saved = kind;
    }
  }
  vi.mocked(files.renameSync).mockImplementation(replaceResult);
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(journeys).toBe(11);
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it.each(['', '{malformed'])(
  'refuses missing or malformed saved result %s before continuation', refusesSavedResult);

const protectionCases = [
  ['swap_measurement_failed', 'Container swap protection could not be measured.'],
  ['swap_not_disabled', 'Container swap allowance and current use must both be zero.'],
  ['memory_limit_unproved', 'A finite positive container memory limit could not be proved.'],
  ['crash_kernel_unproved', 'A disabled kernel crash dump could not be proved.'],
  ['core_limit_measurement_failed', 'The runner core dump limits could not be measured.'],
  ['core_limit_not_zero', 'The runner soft and hard core dump limits must both be zero.'],
  ['dumpability_measurement_failed', 'The runner dumpability could not be measured.'],
  ['dumpability_protection_failed', 'The runner could not disable process dumps.'],
  ['process_dumpable', 'The runner is still dumpable.'],
  ['process_identity_changed', 'The runner identity changed after dump protection was set.'],
  ['helper_unavailable', 'The native runner protection helper is unavailable.'],
];
async function explainsProtectionFailure(protectionFailure: string, message: string): Promise<void> {
  const refusal = { result: 'FAIL', reason: 'host_refused', protectionFailure };
  function refuse(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    Object.assign(receipt, refusal);
  }
  change = refuse;
  const expectedError = new Error(`memory_qualification_refused: host_refused. ${message}`);
  await expect(launch()).rejects.toThrow(expectedError);
  const expected = { ...refusal, message };
  expect(JSON.parse(saved)).toEqual(expected);
  expect(journeys).toBe(1);
}
it.each(protectionCases)(
  'names the failed protection %s in the launcher and saved result', explainsProtectionFailure);
