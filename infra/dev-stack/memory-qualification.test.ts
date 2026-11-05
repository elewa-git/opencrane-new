import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import * as files from 'node:fs';
import * as asyncFiles from 'node:fs/promises';
import { homedir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });
vi.mock('node:child_process', { spy: true });
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
      'com.docker.compose.project.working_dir': root,
    } },
  };
}
function unchanged(): void {}
function protectedStat() {
  return Object.assign(new files.Stats(), originalStat, { uid: 0, mode: 0o100600, size: 150 });
}
function readProtected(descriptor: unknown): string {
  if (descriptor === 42) return target;
  if (descriptor === 43) return saved;
  throw new Error('Unexpected private read');
}
function openProtected(path: unknown): number {
  if (path === targetPath) return 42;
  if (path === resultPath) return 43;
  throw new Error('Unexpected private open');
}
async function readLocal(path: unknown): Promise<string> {
  if (path === `${directory}/stack-owner`) return `worktree=${root}\npid=1\n`;
  if (path === `${directory}/settings.env`) return 'SILO_ID=fixture-silo\n';
  return await originalFiles.readFile(path as string, 'utf8');
}
const originalFiles = await vi.importActual<typeof asyncFiles>('node:fs/promises');
function writeResult(_path: unknown, content: unknown): void {
  pending = String(content);
  writes += 1;
}
function renameResult(): void { saved = pending; }
function docker(file: unknown, args: unknown): string {
  if (file === '/usr/bin/git') return sourceSha;
  expect(file).toBe('/usr/bin/docker');
  const command = args as string[];
  expect(command.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
  if (command[2] === 'info') return JSON.stringify(host);
  if (command[2] === 'inspect') return JSON.stringify([container]);
  expect(command.slice(2, 4)).toEqual(['image', 'inspect']);
  return JSON.stringify([{ Id: container.Image,
    Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]);
}
function spawnDocker(file: string, args: readonly string[] = []): ReturnType<typeof spawn> {
  expect(file).toBe('/usr/bin/docker');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
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
      stdout.emit('data', Buffer.from(JSON.stringify(response)));
      child.emit('close', 0);
    }
    if (pause) {
      release = reply;
    } else {
      queueMicrotask(reply);
    }
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
  target = JSON.stringify({ containerId, siloId: 'fixture-silo' });
  saved = 'prior evidence';
  pending = '';
  container = freshContainer();
  stream = { created: '2026-01-01T00:00:02Z', eventCount: 0, lastSequence: 0 };
  host = 'fixture-host';
  journeys = 0;
  writes = 0;
  change = unchanged;
  pause = false;
  release = undefined;
  vi.mocked(files.openSync).mockImplementation(openProtected);
  vi.mocked(files.readFileSync).mockImplementation(readProtected);
  vi.mocked(files.fstatSync).mockImplementation(protectedStat);
  vi.mocked(files.closeSync).mockReturnValue(undefined);
  vi.mocked(files.writeFileSync).mockImplementation(writeResult);
  vi.mocked(files.renameSync).mockImplementation(renameResult);
  vi.mocked(asyncFiles.readFile).mockImplementation(readLocal);
  async function realpath(path: unknown): Promise<string> { return String(path); }
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
  if (kind === 'claim') vi.stubEnv('MEMORY_CLAIMED_ID', '2');
  if (kind === 'owner') vi.stubEnv('DEV_STACK_ID', '0');
  if (kind === 'worktree') {
    async function foreign(): Promise<string> { return 'worktree=/other\n'; }
    vi.mocked(asyncFiles.readFile).mockImplementation(foreign);
  }
  if (kind === 'container') container.Id = 'd'.repeat(64);
  if (kind === 'project') container.Config.Labels['com.docker.compose.project'] = 'owner';
  if (kind === 'container worktree') {
    container.Config.Labels['com.docker.compose.project.working_dir'] = '/other';
  }
  if (kind === 'silo') target = JSON.stringify({ containerId, siloId: 'other' });
  if (kind === 'unsafe') {
    function unsafe() { return Object.assign(protectedStat(), { uid: 1000 }); }
    vi.mocked(files.fstatSync).mockImplementation(unsafe);
  }
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(writes).toBe(0);
  expect(journeys).toBe(0);
  expect(saved).toBe('prior evidence');
}
it.each(['claim', 'owner', 'worktree', 'container', 'project', 'container worktree',
  'silo', 'unsafe'])('refuses %s before collection and preserves prior evidence', refusesLocalTarget);
async function refusesBeforeJourney(kind: string): Promise<void> {
  if (kind === 'mounted') container.Mounts = [{ Destination: '/app' }];
  if (kind === 'writable') container.HostConfig.ReadonlyRootfs = false;
  if (kind === 'used') stream.eventCount = 1;
  if (kind === 'purged') stream.lastSequence = 5;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(journeys).toBe(0);
}
it.each(['mounted', 'writable', 'used', 'purged'])(
  'refuses %s installation before any journey or bootstrap', refusesBeforeJourney);
async function refusesReplacement(kind: string): Promise<void> {
  function replace(): void {
    if (kind === 'host') host = 'replacement-host';
    if (kind === 'image') container.Image = `sha256:${'d'.repeat(64)}`;
    if (kind === 'start') container.State.StartedAt = '2026-01-01T00:00:02Z';
    if (kind === 'stream') stream.created = '2026-01-01T00:00:03Z';
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
    if (status === 'malformed') delete receipt['challengeId'];
  }
  change = incomplete;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(JSON.parse(saved)).not.toHaveProperty('result', 'PASS');
}
it.each(['PARTIAL', 'NOT RUN', 'malformed'])(
  'never continues from %s results', refusesIncomplete);
async function withdrawsEarlierPass(): Promise<void> {
  await launch();
  expect(JSON.parse(saved)).toHaveProperty('result', 'PASS');
  vi.resetModules();
  stream.eventCount = 0;
  stream.lastSequence = 0;
  function fail(receipt: Record<string, unknown>): void { delete receipt['challengeId']; }
  change = fail;
  await expect(launch()).rejects.toThrow('memory_qualification_refused');
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it('a fresh failed collection withdraws an earlier saved PASS', withdrawsEarlierPass);
async function waitsForCleanup(): Promise<void> {
  pause = true;
  const controller = new AbortController();
  let settled = false;
  function finished(): void { settled = true; }
  const operation = launch(controller.signal);
  const outcome = expect(operation).rejects.toThrow('memory_qualification_refused');
  void operation.then(finished, finished);
  await vi.waitFor(function waiting() { expect(release).toBeTypeOf('function'); });
  controller.abort();
  expect(settled).toBe(false);
  pause = false;
  release!();
  await outcome;
  expect(JSON.parse(saved)).toHaveProperty('result', 'FAIL');
}
it('cancellation waits for collector cleanup and withdraws its result', waitsForCleanup);
