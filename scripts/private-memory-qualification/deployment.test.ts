import { statSync, openSync, fstatSync, readFileSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { collectDeployment } from './deployment.ts';
import { containerIdentity, proveComputerBridge, type ContainerIdentity } from './bridge-proof.ts';
import { proveComputerSupervisor } from './supervisor-proof.ts';
import { protectionMessages, type ProtectionFailure } from './protection-failure.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs', { spy: true });
vi.mock('./bridge-proof.ts', { spy: true });
vi.mock('./supervisor-proof.ts', { spy: true });
const containerId = 'c'.repeat(64);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const sourceSha = 'a'.repeat(40);
const names = ['privateTurns', 'nativeRecall', 'requesterIsolation', 'sessionIsolation',
  'invalidation', 'unrelatedActivity', 'stopReconnect', 'replacementReload', 'persistence',
  'P4-14', 'P4-15'];
let container: Record<string, unknown>;
let stream: { created: string; eventCount: number; lastSequence: number };
let host: string;
let responses: Record<string, unknown>[];
let alter: (value: Record<string, unknown>) => void;
let failChild: boolean;
let computer: ContainerIdentity;

function unchanged(): void {}

function docker(_file: unknown, args: unknown, options: unknown): string {
  expect(_file).toBe('/usr/bin/docker');
  const command = z.array(z.string()).parse(args);
  expect(command.slice(0, 2)).toEqual(['--host', 'unix:///var/run/docker.sock']);
  if (failChild) {
    throw new Error('private child output must not escape');
  }
  if (command[2] === 'info') {
    return JSON.stringify(host);
  }
  if (command[2] === 'inspect') {
    return JSON.stringify([container]);
  }
  if (command[2] === 'image') {
    return JSON.stringify([{ Id: imageDigest,
      Config: { Labels: { 'org.opencontainers.image.revision': sourceSha } } }]);
  }
  expect(command[2]).toBe('exec');
  expect(command).toContain(container['Id']);
  expect(command).toContain('NODE_OPTIONS=');
  expect(command).toContain('/usr/local/bin/node');
  if (command.includes('--eval')) {
    return JSON.stringify(stream);
  }
  expect(command.at(-1)).toBe('/app/scripts/private-memory-qualification/journey.mjs');
  const input = z.object({ input: z.string() }).parse(options).input;
  const parsed: unknown = JSON.parse(input);
  const request = z.record(z.string(), z.unknown()).parse(parsed);
  const response = { ...request, result: 'PASS', complete: true, observedAt: Date.now() };
  alter(response);
  responses.push(response);
  return JSON.stringify(response);
}

function prepare(): void {
  vi.mocked(proveComputerBridge).mockResolvedValue(true);
  vi.mocked(proveComputerSupervisor).mockResolvedValue(true);
  computer = { Id: 'a'.repeat(64), Image: `sha256:${'d'.repeat(64)}`,
    State: { Running: true, StartedAt: '2026-01-01T00:00:01Z', Pid: 4321 } };
  vi.mocked(containerIdentity).mockImplementation(function readComputer() {
    return computer;
  });
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawn).mockImplementation(spawnDocker);
  vi.mocked(openSync).mockReturnValue(42);
  vi.mocked(closeSync).mockReturnValue(undefined);
  vi.mocked(writeFileSync).mockReturnValue(undefined);
  vi.mocked(renameSync).mockReturnValue(undefined);
  const stat = Object.assign(statSync(import.meta.filename), {
    uid: 0, mode: 0o100600, size: 150, isFile: regularFile,
  });
  vi.mocked(fstatSync).mockReturnValue(stat);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ containerId,
    computerContainerId: 'a'.repeat(64), siloId: 'fixture-silo' }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:03Z'));
  container = {
    Id: containerId, Image: imageDigest, Created: '2026-01-01T00:00:00Z', RestartCount: 0,
    State: { Running: true, StartedAt: '2026-01-01T00:00:01Z' },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [],
    Config: { Env: ['SILO_ID=fixture-silo'] },
  };
  stream = { created: '2026-01-01T00:00:02Z', eventCount: 0, lastSequence: 0 };
  host = 'fixture-docker-host';
  responses = [];
  alter = unchanged;
  failChild = false;
  vi.mocked(execFileSync).mockImplementation(docker);
}
beforeEach(prepare);
afterEach(vi.useRealTimers);

async function qualifiesObservedDeployment(): Promise<void> {
  const result = await collectDeployment();
  expect(result.result).toBe('PASS');
  expect(result).toMatchObject({ sourceSha, imageDigest });
  expect(responses.map(responseName)).toEqual(names);
  expect(JSON.stringify(result)).not.toContain('fixture-silo');
  expect(JSON.stringify(result)).not.toContain('fixture-docker-host');
}
function responseName(response: Record<string, unknown>): unknown {
  return response['name'];
}
it('qualifies the fixture deployment only after all eleven observed runs',
  qualifiesObservedDeployment);

async function savesOnlyFixedComputerRefusal(): Promise<void> {
  const computerContainerId = 'a'.repeat(64);
  const target = { containerId, computerContainerId, siloId: 'fixture-silo' };
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify(target));
  vi.mocked(proveComputerBridge).mockResolvedValue('private_process_unreadable');
  const result = await collectDeployment();
  expect(proveComputerBridge).toHaveBeenCalledWith(computerContainerId,
    expect.stringMatching(/^sha256:[a-f0-9]{64}$/u));
  expect(result).toEqual({ result: 'FAIL', reason: 'host_refused', complete: false,
    protectionFailure: 'private_process_unreadable',
    message: protectionMessages.private_process_unreadable });
  expect(responses).toHaveLength(0);
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String), JSON.stringify(result),
    { flag: 'wx', mode: 0o600 });
}
it('saves only a fixed refusal when the separate computer bridge cannot be proved',
  savesOnlyFixedComputerRefusal);

async function refusesSupervisorReplacementDuringWork(): Promise<void> {
  const computerContainerId = 'a'.repeat(64);
  vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
    containerId, computerContainerId, siloId: 'fixture-silo',
  }));
  vi.mocked(proveComputerSupervisor).mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce('private_process_identity_changed');
  const result = await collectDeployment();
  expect(result).toEqual({ result: 'FAIL', reason: 'host_refused', complete: false,
    protectionFailure: 'private_process_identity_changed',
    message: protectionMessages.private_process_identity_changed });
  expect(responses).toHaveLength(1);
}
it('refuses a supervisor replaced while the private journey was awaited',
  refusesSupervisorReplacementDuringWork);

async function refusesComputerReplacementDuringWork(): Promise<void> {
  function replaceComputer(): void {
    computer = { ...computer, State: { ...computer.State, Pid: 4322 } };
  }
  alter = replaceComputer;
  const result = await collectDeployment();
  expect(result).toEqual({ result: 'FAIL', reason: 'host_refused', complete: false,
    protectionFailure: 'private_process_identity_changed',
    message: protectionMessages.private_process_identity_changed });
  expect(responses).toHaveLength(1);
}
it('refuses a computer replacement during awaited work even if the new inspector passes',
  refusesComputerReplacementDuringWork);

async function refusesSupervisorExitWithLostReply(): Promise<void> {
  vi.mocked(proveComputerSupervisor).mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce('private_process_unreadable');
  function loseReply(): void {
    throw new Error('private arguments must stay in memory');
  }
  alter = loseReply;
  const result = await collectDeployment();
  expect(result).toEqual({ result: 'FAIL', reason: 'host_refused', complete: false,
    protectionFailure: 'private_process_unreadable',
    message: protectionMessages.private_process_unreadable });
  expect(JSON.stringify(result)).not.toContain('private arguments');
}
it('rechecks a lost supervisor after private work loses its reply',
  refusesSupervisorExitWithLostReply);

async function refusesInventedBundle(): Promise<void> {
  const invented = JSON.stringify({ result: 'PASS', sourceSha, imageDigest, checks: names });
  expect(await collectDeployment(invented)).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(execFileSync).not.toHaveBeenCalled();
}
it('refuses an invented evidence bundle before executing anything', refusesInventedBundle);

async function savesHostRefusal(): Promise<void> {
  function refuseHost(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    receipt['result'] = 'FAIL';
    receipt['reason'] = 'host_refused';
  }
  alter = refuseHost;
  const expected = {
    result: 'FAIL', reason: 'host_refused',
    message: 'Host safety checks failed: swap and core dumps must be disabled.',
  };
  expect(await collectDeployment()).toEqual(expected);
  const options = { flag: 'wx', mode: 0o600 };
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String),
    JSON.stringify(expected), options);
  expect(responses).toHaveLength(1);
}
it('returns and saves the host refusal before any later check', savesHostRefusal);

async function substitutes(field: string, status = 'PASS', name?: string): Promise<void> {
  const foreign: Record<string, string> = {
    sourceSha: 'd'.repeat(40), imageDigest: `sha256:${'d'.repeat(64)}`,
    environmentId: 'd'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
    installationId: `sha256:${'d'.repeat(64)}`, runId: '11111111-1111-4111-8111-111111111111',
  };
  function change(response: Record<string, unknown>): void {
    if (name && response['name'] !== name) return;
    response[field] = foreign[field];
    response['result'] = status;
    response['complete'] = status === 'PASS';
  }
  alter = change;
  expect((await collectDeployment()).result).toBe('FAIL');
}
it.each(['sourceSha', 'imageDigest', 'environmentId', 'siloId', 'installationId', 'runId'])(
  'refuses a receipt from another %s', substitutes,
);

async function staleOrReplayed(kind: string): Promise<void> {
  function change(response: Record<string, unknown>): void {
    if (kind === 'stale') {
      response['observedAt'] = Date.now() - 1;
    }
    if (kind === 'future') {
      response['observedAt'] = Date.now() + 1;
    }
    if (kind === 'replayed' && responses.length > 0) {
      response['challengeId'] = responses[0]!['challengeId'];
    }
    if (kind === 'edited') {
      response['complete'] = false;
    }
  }
  alter = change;
  expect((await collectDeployment()).result).toBe('FAIL');
}
it.each(['stale', 'future', 'replayed', 'edited'])('refuses %s receipts', staleOrReplayed);

async function refusesMissingCheck(name: string): Promise<void> {
  function change(response: Record<string, unknown>): void {
    if (response['name'] === name) {
      response['result'] = 'NOT RUN';
    }
  }
  alter = change;
  expect((await collectDeployment()).result).toBe('FAIL');
}
it.each(names)('refuses missing check %s', refusesMissingCheck);

async function refusesCopiedRun(): Promise<void> {
  expect((await collectDeployment()).result).toBe('PASS');
  const copied = structuredClone(responses);
  let index = 0;
  function replay(response: Record<string, unknown>): void {
    Object.assign(response, copied[index]);
    index += 1;
  }
  alter = replay;
  expect((await collectDeployment()).result).toBe('FAIL');
}
it('refuses a complete copied bundle on the same deployment', refusesCopiedRun);

async function refusesDeploymentChange(field: string): Promise<void> {
  function change(): void {
    if (field === 'image') {
      container['Image'] = `sha256:${'d'.repeat(64)}`;
    }
    if (field === 'host') {
      host = 'another-host';
    }
    if (field === 'silo') {
      container['Config'] = { Env: ['SILO_ID=another-silo'] };
    }
    if (field === 'event-store') {
      stream.created = '2026-01-01T00:00:03Z';
    }
    if (field === 'restart') {
      container['RestartCount'] = 1;
    }
  }
  alter = change;
  expect((await collectDeployment()).result).toBe('FAIL');
}
it.each(['image', 'host', 'silo', 'restart', 'event-store'])(
  'refuses a deployment whose %s changes during a run', refusesDeploymentChange,
);

async function refusesOldInstallation(kind: string): Promise<void> {
  if (kind === 'events') {
    stream.eventCount = 1;
  }
  if (kind === 'purged') {
    stream.lastSequence = 5;
  }
  if (kind === 'old') {
    stream.created = '2025-01-01T00:00:00Z';
  }
  if (kind === 'future') {
    stream.created = '2027-01-01T00:00:00Z';
  }
  expect((await collectDeployment()).result).toBe('FAIL');
  expect(responses).toHaveLength(0);
}
it.each(['events', 'purged', 'old', 'future'])(
  'refuses %s event-store state before journeys start', refusesOldInstallation,
);

async function refusesMutableRunner(kind: string): Promise<void> {
  if (kind === 'writable') {
    container['HostConfig'] = { ReadonlyRootfs: false };
  }
  if (kind === 'mounted') {
    container['Mounts'] = [{ Destination: '/app/scripts' }];
  }
  expect((await collectDeployment()).result).toBe('FAIL');
}
it.each(['writable', 'mounted'])('refuses %s deployment code', refusesMutableRunner);

async function hidesFailures(): Promise<void> {
  failChild = true;
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('keeps child output out of failures', hidesFailures);

async function refusesNonPassingChild(status: string): Promise<void> {
  function change(response: Record<string, unknown>): void {
    response['result'] = status;
  }
  alter = change;
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it.each(['FAIL', 'PARTIAL'])('refuses a child reporting %s', refusesNonPassingChild);

async function refusesExtraChildOutput(): Promise<void> {
  function change(response: Record<string, unknown>): void {
    response['extra'] = 'fixture output that must stay private';
  }
  alter = change;
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('refuses extra child fields without exposing their values', refusesExtraChildOutput);

async function refusesAnotherLocalSilo(): Promise<void> {
  const otherContainerId = 'd'.repeat(64);
  container['Id'] = otherContainerId;
  container['Config'] = { Env: ['SILO_ID=other-local-silo'] };
  expect(await collectDeployment(otherContainerId)).toEqual({
    result: 'FAIL', reason: 'collection_failed',
  });
  expect(execFileSync).not.toHaveBeenCalled();
}
it('refuses a caller selecting another local silo before Docker runs', refusesAnotherLocalSilo);

async function refusesWrongConfiguredSilo(): Promise<void> {
  container['Config'] = { Env: ['SILO_ID=other-local-silo'] };
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(responses).toHaveLength(0);
}
it('refuses a configured container whose silo does not match', refusesWrongConfiguredSilo);

async function refusesUnsafeConfiguration(kind: string): Promise<void> {
  const stat = Object.assign(statSync(import.meta.filename), {
    uid: 0, mode: 0o100600, size: 150, isFile: regularFile,
  });
  if (kind === 'owner') {
    stat.uid = 1000;
  }
  if (kind === 'writable') {
    stat.mode = 0o100620;
  }
  if (kind === 'oversized') {
    stat.size = 1025;
  }
  if (kind === 'non-file') {
    stat.isFile = notRegularFile;
  }
  vi.mocked(fstatSync).mockReturnValue(stat);
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(execFileSync).not.toHaveBeenCalled();
  expect(closeSync).toHaveBeenCalledWith(42);
}
function regularFile(): boolean {
  return true;
}
function notRegularFile(): boolean {
  return false;
}
it.each(['owner', 'writable', 'oversized', 'non-file'])(
  'refuses unsafe target configuration: %s', refusesUnsafeConfiguration,
);

function spawnDocker(_file: string, args: readonly string[] = []): ReturnType<typeof spawn> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new ChildProcess(), { stdin, stdout, stderr });
  function inputReceived(buffer: Buffer): void {
    function reply(): void {
      try {
        const innerArgs = z.array(z.string()).parse(JSON.parse(args.at(-1)!));
        const containerIndex = args.indexOf('-i') + 1;
        const command = [...args.slice(0, containerIndex + 1), ...innerArgs];
        const input: unknown = JSON.parse(buffer.toString('utf8'));
        const output = docker(_file, command, { input });
        stdout.emit('data', Buffer.from(output));
        child.emit('close', 0);
      } catch {
        child.emit('close', 1);
      }
    }
    queueMicrotask(reply);
  }
  stdin.on('data', inputReceived);
  return child;
}

async function savesOwnResult(): Promise<void> {
  const result = await collectDeployment();
  expect(result.result).toBe('PASS');
  expect(writeFileSync).toHaveBeenLastCalledWith(
    expect.stringMatching(/^\/etc\/opencrane\/private-memory-qualification-result\.json\./u),
    JSON.stringify(result), { flag: 'wx', mode: 0o600 },
  );
  expect(renameSync).toHaveBeenLastCalledWith(expect.any(String),
    '/etc/opencrane/private-memory-qualification-result.json');
}
it('writes only its own complete result to the protected deployment file', savesOwnResult);

async function withdrawsPassForPartialRunner(): Promise<void> {
  let pending = '';
  let saved = '';
  function write(_path: unknown, data: unknown): void {
    pending = z.string().parse(data);
  }
  function rename(): void {
    saved = pending;
  }
  vi.mocked(writeFileSync).mockImplementation(write);
  vi.mocked(renameSync).mockImplementation(rename);
  expect((await collectDeployment()).result).toBe('PASS');
  expect(JSON.parse(saved)).toHaveProperty('result', 'PASS');
  let expectedFailure: Record<string, unknown> | undefined;
  function partial(response: Record<string, unknown>): void {
    // Strip the fixture's invented success before invoking the actual entry.
    const request = { ...response };
    delete request['result'];
    delete request['complete'];
    delete request['observedAt'];
    const options = { input: JSON.stringify(request), encoding: 'utf8' as const, timeout: 5000 };
    const child = spawnSync(process.execPath, ['--experimental-strip-types',
      'scripts/private-memory-qualification/journey.mjs'], options);
    expect(child.status).toBe(1);
    expect(child.stderr).toBe('');
    const refusal: unknown = JSON.parse(child.stdout);
    const observed = z.object({ protectionFailure: z.string() }).parse(refusal);
    function matchesFailure(entry: string[]): boolean {
      return entry[0] === observed.protectionFailure;
    }
    const knownFailure = protectionCases.find(matchesFailure);
    expect(knownFailure).toBeDefined();
    const expectedRefusal = { result: 'FAIL', reason: 'host_refused',
      protectionFailure: knownFailure![0] };
    expect(refusal).toEqual(expectedRefusal);
    expectedFailure = { ...expectedRefusal, message: knownFailure![1] };
    for (const key of Object.keys(response)) delete response[key];
    Object.assign(response, refusal);
  }
  alter = partial;
  const result = await collectDeployment();
  expect(expectedFailure).toBeDefined();
  expect(result).toEqual(expectedFailure);
  expect(JSON.parse(saved)).toEqual(expectedFailure);
  expect(responses).toHaveLength(12);
}
it('withdraws earlier saved PASS when the real runner refuses the host', withdrawsPassForPartialRunner);

async function retainsMissingJourneys(): Promise<void> {
  function incomplete(response: Record<string, unknown>): void {
    response['result'] = 'NOT RUN';
    response['complete'] = false;
  }
  alter = incomplete;
  const result = await collectDeployment();
  expect(result).toMatchObject({ result: 'PARTIAL',
    checks: { privateTurns: 'NOT RUN', invalidation: 'NOT RUN' },
    qualifications: { 'P4-14': 'NOT RUN', 'P4-15': 'NOT RUN' } });
  expect(responses).toHaveLength(11);
}
it('keeps missing journeys NOT RUN without qualifying the deployment', retainsMissingJourneys);

async function foreignPartial(field: string): Promise<void> {
  await substitutes(field, 'PARTIAL');
}
it.each(['imageDigest', 'environmentId', 'siloId'])(
  'refuses incomplete evidence from another %s', foreignPartial);

async function foreignIsolation(name: string, field: string): Promise<void> {
  await substitutes(field, 'PARTIAL', name);
}
const isolationSubstitutions = [
  ['requesterIsolation', 'imageDigest'], ['requesterIsolation', 'environmentId'],
  ['requesterIsolation', 'siloId'], ['sessionIsolation', 'imageDigest'],
  ['sessionIsolation', 'environmentId'], ['sessionIsolation', 'siloId'],
];
it.each(isolationSubstitutions)(
  'refuses %s results from another %s', foreignIsolation);

async function savesPartialCheck(name: string): Promise<void> {
  function partial(response: Record<string, unknown>) {
    if (response['name'] === name) {
      response['result'] = 'PARTIAL';
      response['complete'] = false;
    }
  }
  let saved = '';
  function write(_file: unknown, value: unknown) {
    saved = String(value);
  }
  alter = partial;
  vi.mocked(writeFileSync).mockImplementation(write);
  const result = await collectDeployment();
  expect(result).toMatchObject({ result: 'PARTIAL', checks: { [name]: 'PARTIAL' } });
  expect(JSON.parse(saved)).toEqual(result);
}
it.each(['stopReconnect', 'replacementReload'])(
  'saves only PARTIAL when %s is incomplete', savesPartialCheck);

async function refusesCompleteReplacement(): Promise<void> {
  function falselyComplete(response: Record<string, unknown>) {
    if (response['name'] === 'replacementReload') {
      response['result'] = 'PARTIAL';
      response['complete'] = true;
    }
  }
  alter = falselyComplete;
  const result = await collectDeployment();
  expect(result).toEqual({ result: 'FAIL', reason: 'collection_failed' });
}
it('refuses a replacement child that claims its PARTIAL check is complete',
  refusesCompleteReplacement);

const protectionCases = [
  ['core_pattern_unreadable', 'kernel.core_pattern could not be read as a known setting.'],
  ['suid_dumpable_unreadable', 'fs.suid_dumpable could not be read as a known setting.'],
  ['core_helper_enabled',
    'kernel.core_pattern sends core dumps to a helper program while fs.suid_dumpable is not 0.'],
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
async function savesProtectionFailure(protectionFailure: string, message: string): Promise<void> {
  function refuse(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    const refusal = { result: 'FAIL', reason: 'host_refused', protectionFailure };
    Object.assign(receipt, refusal);
  }
  alter = refuse;
  const expected = { result: 'FAIL', reason: 'host_refused', protectionFailure, message };
  expect(await collectDeployment()).toEqual(expected);
  const options = { flag: 'wx', mode: 0o600 };
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String), JSON.stringify(expected), options);
  expect(responses).toHaveLength(1);
}
it.each(protectionCases)('saves and reports the fixed message for %s', savesProtectionFailure);

async function savesIncompleteProcessRefusal(protectionFailure: ProtectionFailure): Promise<void> {
  function refuse(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    Object.assign(receipt, {
      result: 'FAIL', reason: 'host_refused',
      protectionFailure, complete: false,
    });
  }
  alter = refuse;
  const result = await collectDeployment();
  expect(result).toEqual({
    result: 'FAIL', reason: 'host_refused',
    protectionFailure, complete: false,
    message: protectionMessages[protectionFailure],
  });
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String), JSON.stringify(result),
    { flag: 'wx', mode: 0o600 });
}
it.each(['private_process_missing', 'private_process_unreadable',
  'private_process_identity_changed'] as const)(
  'saves incomplete private process proof for %s', savesIncompleteProcessRefusal);

async function rejectsProcessRefusalWithoutIncompleteStatus(
  protectionFailure: ProtectionFailure): Promise<void> {
  function refuse(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    Object.assign(receipt, {
      result: 'FAIL', reason: 'host_refused', protectionFailure,
    });
  }
  alter = refuse;
  const expected = { result: 'FAIL', reason: 'collection_failed' };
  expect(await collectDeployment()).toEqual(expected);
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String), JSON.stringify(expected),
    { flag: 'wx', mode: 0o600 });
}
it.each(['private_process_missing', 'private_process_unreadable',
  'private_process_identity_changed'] as const)(
  'rejects missing incomplete status for %s', rejectsProcessRefusalWithoutIncompleteStatus);

async function rejectsUnknownProtection(protectionFailure: unknown): Promise<void> {
  function refuse(receipt: Record<string, unknown>): void {
    for (const key of Object.keys(receipt)) {
      delete receipt[key];
    }
    const refusal = { result: 'FAIL', reason: 'host_refused', protectionFailure };
    Object.assign(receipt, refusal);
  }
  alter = refuse;
  expect(await collectDeployment()).toEqual({ result: 'FAIL', reason: 'collection_failed' });
  expect(writeFileSync).toHaveBeenLastCalledWith(expect.any(String),
    '{"result":"FAIL","reason":"collection_failed"}', { flag: 'wx', mode: 0o600 });
}
it.each(['/private/helper', '', null, true, ['helper_unavailable']])(
  'rejects an unknown protection failure %#', rejectsUnknownProtection);
