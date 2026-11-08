import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import { readProcessIdentity, type ProcessIdentity } from './private-processes.ts';
import { runnerProtected } from './runner-protection.ts';
import { proveCanaryHelper, type CanaryHelperBinding } from './canary-helper-proof.ts';

vi.mock('node:fs', { spy: true });
vi.mock('./container-probe.ts', { spy: true });
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
  vi.mocked(readFileSync).mockImplementation(readProc as typeof readFileSync);
  vi.mocked(probeContainer).mockReset();
  vi.mocked(probeContainer).mockReturnValue(true);
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
    vi.mocked(readFileSync).mockImplementation(function nonzero(path): string {
      if (path === `/proc/${helper.pid}/limits`) {
        return 'Max core file size        1        1        bytes\n';
      }
      return readProc(path);
    } as typeof readFileSync);
  } else {
    vi.mocked(runnerProtected).mockReturnValue(result);
  }
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(result);
}
it.each(['process_dumpable', 'core_limit_not_zero', 'swap_not_disabled'] as const)(
  'refuses %s in the helper itself', badProtection);

function unreadableOrGone(): void {
  vi.mocked(readFileSync).mockImplementation(function denied(): never {
    throw new Error('private arguments and canary bytes');
  });
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
  vi.mocked(readProcessIdentity).mockImplementation(function gone(): never {
    throw new Error('private arguments and canary bytes');
  });
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
}
it('returns a fixed reason for unreadable proc values and a disappearing helper',
  unreadableOrGone);

function replacementAtFinalRead(): void {
  vi.mocked(readProcessIdentity).mockImplementation(function replaced(pid): ProcessIdentity {
    if (pid === helper.pid && helperReads++ > 0) {
      return { ...helper, startTime: '999' };
    }
    return pid === helper.pid ? helper : supervisor;
  });
  expect(proveCanaryHelper(binding, currentInstallation)).toBe(
    'private_process_identity_changed');
}
it('refuses helper replacement after the first snapshot', replacementAtFinalRead);

function unsafeAtFinalRead(): void {
  vi.mocked(runnerProtected).mockReturnValueOnce(true).mockReturnValue('process_dumpable');
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('process_dumpable');
}
it('refuses a helper that becomes dumpable at the final read', unsafeAtFinalRead);

function thrownHelperCall(): void {
  vi.mocked(runnerProtected).mockImplementation(function throws(): never {
    throw new Error('private arguments and canary bytes');
  });
  expect(proveCanaryHelper(binding, currentInstallation)).toBe('private_process_unreadable');
}
it('does not expose a thrown helper call', thrownHelperCall);
