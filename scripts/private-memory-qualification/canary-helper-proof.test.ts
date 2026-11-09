import { lstatSync, readFileSync, statfsSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import { probeHost } from './host-probe.ts';
import { readProcessIdentity, type ProcessIdentity } from './private-processes.ts';
import { runnerProtected } from './runner-protection.ts';
import {
  proveCanaryHelper, readCanaryHelperBinding, type CanaryHelperBinding,
} from './canary-helper-proof.ts';

vi.mock('node:fs', { spy: true });
vi.mock('./container-probe.ts', { spy: true });
vi.mock('./host-probe.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });
vi.mock('./runner-protection.ts', { spy: true });

const helper: ProcessIdentity = {
  pid: process.pid, startTime: '123', executable: '/usr/local/bin/node', uid: 0,
  cgroup: '0::/qualification\n', containerIdentity: 'pid:[123]',
  commandLine: '/usr/local/bin/node\0--experimental-strip-types\0' +
    '/app/scripts/private-memory-qualification/journey.mjs\0',
};
const supervisor: ProcessIdentity = {
  ...helper, pid: process.ppid, startTime: '100',
  commandLine: '/usr/local/bin/node\0--input-type=module\0--eval\0supervisor\0',
};
const imageDigest = `sha256:${'a'.repeat(64)}`;
const installationId = `sha256:${'b'.repeat(64)}`;
const binding: CanaryHelperBinding = { helper, supervisor, imageDigest, installationId };
let observed = { imageDigest, installationId };
let helperReads = 0;

function readIdentity(pid: number): ProcessIdentity {
  if (pid === helper.pid) {
    helperReads += 1;
    return helper;
  }
  return supervisor;
}
function readProc(path: unknown): string {
  if (path === `/proc/${helper.pid}/limits`) {
    return 'Max core file size        0        0        bytes\n';
  }
  if (path === `/proc/${helper.pid}/status`) {
    return 'CoreDumping:\t0\n';
  }
  throw new Error('private arguments and canary bytes');
}
function currentInstallation(): typeof observed {
  return observed;
}
function prepare(): void {
  helperReads = 0;
  observed = { imageDigest, installationId };
  vi.mocked(readProcessIdentity).mockReset();
  vi.mocked(readProcessIdentity).mockImplementation(readIdentity);
  vi.mocked(readFileSync).mockReset();
  vi.mocked(readFileSync).mockImplementation(readProc);
  vi.mocked(lstatSync).mockReset();
  vi.mocked(statfsSync).mockReset();
  vi.mocked(probeContainer).mockReset();
  vi.mocked(probeContainer).mockReturnValue(true);
  vi.mocked(probeHost).mockReset();
  vi.mocked(probeHost).mockReturnValue(false);
  vi.mocked(runnerProtected).mockReset();
  vi.mocked(runnerProtected).mockReturnValue(true);
}
beforeEach(prepare);

function protectedHelperPasses(): void {
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(true);
  expect(helperReads).toBeGreaterThanOrEqual(2);
  expect(runnerProtected).toHaveBeenCalledTimes(2);
}
it('accepts an ordinary protected supervised helper', protectedHelperPasses);

function changedBinding(field: keyof ProcessIdentity, value: string | number): void {
  const changed = { ...helper, [field]: value };
  const result = proveCanaryHelper({ ...binding, helper: changed }, currentInstallation);
  expect(result).toBe('private_process_identity_changed');
}
it.each([
  ['pid', process.pid + 1], ['startTime', '124'], ['executable', '/other/node'],
  ['uid', 1000], ['cgroup', '0::/foreign\n'], ['containerIdentity', 'pid:[999]'],
  ['commandLine', '/usr/local/bin/node\0/private/other.mjs\0'],
] as const)('refuses a wrong helper %s', changedBinding);

function refusesUnsupervisedIdentity(target: 'helper' | 'supervisor',
  field: string, value: string | number): void {
  let changedHelper = helper;
  let changedSupervisor = supervisor;
  if (target === 'helper') {
    changedHelper = { ...helper, [field]: value };
  } else {
    changedSupervisor = { ...supervisor, [field]: value };
  }
  const candidate: CanaryHelperBinding = {
    ...binding, helper: changedHelper, supervisor: changedSupervisor,
  };
  function readCandidate(pid: number): ProcessIdentity {
    if (pid === changedHelper.pid) {
      return changedHelper;
    }
    return changedSupervisor;
  }
  vi.mocked(readProcessIdentity).mockImplementation(readCandidate);
  expect(proveCanaryHelper(candidate, currentInstallation)).toBe(
    'private_process_identity_changed');
}
it.each([
  ['helper', 'pid', process.pid + 1000],
  ['supervisor', 'pid', process.ppid + 1000],
  ['helper', 'uid', 1000],
  ['supervisor', 'uid', 1000],
  ['helper', 'executable', '/other/node'],
  ['supervisor', 'executable', '/other/node'],
  ['helper', 'commandLine', '/usr/local/bin/node\0/private/other.mjs\0'],
  ['supervisor', 'commandLine', '/other/command\0'],
  ['helper', 'cgroup', '0::/foreign\n'],
  ['helper', 'containerIdentity', 'pid:[999]'],
] as const)('checks the preliminary supervised %s %s independently',
  refusesUnsupervisedIdentity);

function wrongInstallation(): void {
  observed = { imageDigest: `sha256:${'c'.repeat(64)}`, installationId };
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(
    'private_process_identity_changed');
  observed = { imageDigest, installationId: `sha256:${'d'.repeat(64)}` };
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(
    'private_process_identity_changed');
}
it('refuses a wrong image or replacement installation', wrongInstallation);

function badProtection(result: 'process_dumpable' | 'core_limit_not_zero' |
  'swap_not_disabled'): void {
  if (result === 'swap_not_disabled') {
    vi.mocked(probeContainer).mockReturnValue(result);
  } else if (result === 'core_limit_not_zero') {
    function nonzero(path: unknown): string {
      if (path === `/proc/${helper.pid}/limits`) {
        return 'Max core file size        1        1        bytes\n';
      }
      return readProc(path);
    }
    vi.mocked(readFileSync).mockImplementation(nonzero);
  } else {
    vi.mocked(runnerProtected).mockReturnValue(result);
  }
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(result);
}
it.each(['process_dumpable', 'core_limit_not_zero', 'swap_not_disabled'] as const)(
  'refuses %s in the helper itself', badProtection);

function unreadableOrGone(): void {
  function denied(): never {
    throw new Error('private arguments and canary bytes');
  }
  vi.mocked(readFileSync).mockImplementation(denied);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
  function gone(): never {
    throw new Error('private arguments and canary bytes');
  }
  vi.mocked(readProcessIdentity).mockImplementation(gone);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
}
it('returns a fixed reason for unreadable proc values and a disappearing helper',
  unreadableOrGone);

function replacementAtFinalRead(): void {
  function replaced(pid: number): ProcessIdentity {
    if (pid === helper.pid && helperReads++ > 0) {
      return { ...helper, startTime: '999' };
    }
    return pid === helper.pid ? helper : supervisor;
  }
  vi.mocked(readProcessIdentity).mockImplementation(replaced);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(
    'private_process_identity_changed');
}
it('refuses helper replacement after the first snapshot', replacementAtFinalRead);

function supervisorReplacementAfterFirstSnapshot(): void {
  let supervisorReads = 0;
  function readWithReplacement(pid: number): ProcessIdentity {
    if (pid === supervisor.pid && supervisorReads++ > 0) {
      return { ...supervisor, startTime: '999' };
    }
    return pid === helper.pid ? helper : supervisor;
  }
  vi.mocked(readProcessIdentity).mockImplementation(readWithReplacement);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(
    'private_process_identity_changed');
}
it('refuses supervisor replacement after the first snapshot',
  supervisorReplacementAfterFirstSnapshot);

function unsafeAtFinalRead(): void {
  vi.mocked(runnerProtected).mockReturnValueOnce(true);
  vi.mocked(runnerProtected).mockReturnValue('process_dumpable');
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('process_dumpable');
}
it('refuses a helper that becomes dumpable at the final read', unsafeAtFinalRead);

function thrownHelperCall(): void {
  function throws(): never {
    throw new Error('private arguments and canary bytes');
  }
  vi.mocked(runnerProtected).mockImplementation(throws);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
}
it('does not expose a thrown helper call', thrownHelperCall);

function malformedProcValue(): void {
  function malformed(path: unknown): string {
    if (path === `/proc/${helper.pid}/status`) {
      return 'CoreDumping:\tprivate arguments and canary bytes\n';
    }
    return readProc(path);
  }
  vi.mocked(readFileSync).mockImplementation(malformed);
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('process_dumpable');
}
it('does not expose an unreadable core-dump value', malformedProcValue);

function changedAtFinalProtection(): void {
  vi.mocked(probeContainer).mockReturnValueOnce(true);
  vi.mocked(probeContainer).mockReturnValue('swap_not_disabled');
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('swap_not_disabled');
}
it('refuses swap allowance or use found on the final check', changedAtFinalProtection);

async function savedLaunchRecord(): Promise<void> {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const directory = '/run/opencrane-memory-qualification.lock';
  const recordPath = `${directory}/helper-identity`;
  const challengeId = '11111111-1111-4111-8111-111111111111';
  const contents = `${challengeId} ${helper.pid} ${helper.startTime} ` +
    `${supervisor.pid} ${supervisor.startTime} ${imageDigest} ${installationId}\n`;
  const request = { challengeId, imageDigest, installationId };
  let unsafeRecord = false;
  function recordStat(path: unknown): ReturnType<typeof lstatSync> {
    const info = actual.lstatSync('/proc/self/stat');
    info.uid = unsafeRecord && path === recordPath ? 1000 : 0;
    info.mode = path === directory ? 0o040700 : 0o100600;
    info.size = contents.length;
    info.isDirectory = function directoryType(): boolean {
      return path === directory;
    };
    info.isFile = function fileType(): boolean {
      return path === recordPath;
    };
    return info;
  }
  vi.mocked(lstatSync).mockImplementation(recordStat);
  function tmpfs(): ReturnType<typeof statfsSync> {
    const info = actual.statfsSync('/run');
    info.type = 0x01021994;
    return info;
  }
  vi.mocked(statfsSync).mockImplementation(tmpfs);
  function recordFile(path: unknown): string {
    if (path === recordPath) {
      return contents;
    }
    return readProc(path);
  }
  vi.mocked(readFileSync).mockImplementation(recordFile);
  expect(readCanaryHelperBinding(request)).toEqual(binding);
  unsafeRecord = true;
  expect(() => readCanaryHelperBinding(request)).toThrow('private_process_unreadable');
}
it('accepts the saved launch identity and refuses an untrusted record owner',
  savedLaunchRecord);
