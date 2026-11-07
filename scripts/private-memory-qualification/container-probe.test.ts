import { readFileSync, realpathSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import { runnerProtected } from './runner-protection.ts';
import { probePrivateProcessInventory } from './private-processes.ts';
import { runJourney } from './journey.ts';

vi.mock('node:fs', { spy: true });
vi.mock('./runner-protection.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });
let files: Map<string, string>;
const mount = '29 23 0:26 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n';
const requestData = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64), siloId: `sha256:${'d'.repeat(64)}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222', name: 'privateTurns',
};
const request = JSON.stringify(requestData);
function read(path: unknown): string {
  const value = files.get(String(path));
  if (value === undefined) {
    throw new Error('private observation unavailable');
  }
  return value;
}
function unchangedPath(path: unknown): string {
  return String(path);
}
function prepare(): void {
  files = new Map([
    ['/proc/swaps', 'Filename Type Size Used Priority\n/private/swap file 1 0 -2\n'],
    ['/proc/sys/kernel/core_pattern', '|/private/collector %p\n'],
    ['/proc/sys/fs/suid_dumpable', '0\n'],
    ['/proc/self/cgroup', '0::/\n'], ['/proc/self/mountinfo', mount],
    ['/sys/fs/cgroup/cgroup.procs', `${process.pid}\n`],
    ['/sys/fs/cgroup/memory.max', '268435456\n'],
    ['/sys/fs/cgroup/memory.swap.max', '0\n'],
    ['/sys/fs/cgroup/memory.swap.current', '0\n'],
    ['/sys/kernel/kexec_crash_loaded', '0\n'],
  ]);
  vi.mocked(readFileSync).mockImplementation(read);
  vi.mocked(realpathSync).mockImplementation(unchangedPath);
  vi.mocked(runnerProtected).mockReturnValue(true);
  vi.mocked(probePrivateProcessInventory).mockReturnValue('private_process_missing');
}
beforeEach(prepare);
async function acceptsOwnGroup(): Promise<void> {
  expect(probeContainer()).toBe(true);
  expect(runnerProtected).toHaveBeenCalled();
  expect(await runJourney(request)).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'private_process_missing',
    complete: false,
  });
}
it('measures the current runner and its own finite no-swap cgroup', acceptsOwnGroup);

const unsafe = [
  ['/proc/self/cgroup', '0::/other\n'], ['/proc/self/cgroup', '0::/../private\n'],
  ['/proc/self/cgroup', '0::/\n0::/\n'], ['/proc/self/cgroup', '2:memory:/\n'],
  ['/proc/self/mountinfo', mount + mount],
  ['/proc/self/mountinfo', mount.replace('cgroup2', 'tmpfs')],
  ['/proc/self/mountinfo', mount.replace(' / /sys', ' /other /sys')],
  ['/proc/self/mountinfo', mount + '30 29 0:27 / /sys/fs/cgroup/memory.max ro - tmpfs x rw\n'],
  ['/sys/fs/cgroup/cgroup.procs', '0\n'],
  ['/sys/fs/cgroup/memory.max', 'max\n'], ['/sys/fs/cgroup/memory.max', '0\n'],
  ['/sys/fs/cgroup/memory.max', '-1\n'], ['/sys/fs/cgroup/memory.max', '1e9\n'],
  ['/sys/fs/cgroup/memory.swap.max', '1\n'], ['/sys/fs/cgroup/memory.swap.max', 'max\n'],
  ['/sys/fs/cgroup/memory.swap.current', '1\n'],
  ['/sys/kernel/kexec_crash_loaded', '1\n'],
];
async function refusesUnsafe(path: string, value: string): Promise<void> {
  const expected = failureFor(path);
  files.set(path, value);
  expect(probeContainer()).toBe(expected);
  expect(await runJourney(request)).toEqual({ result: 'FAIL', reason: 'host_refused', protectionFailure: expected });
}
it.each(unsafe)('refuses an unsafe container observation %s: %s', refusesUnsafe);
async function refusesMissing(path: string): Promise<void> {
  const expected = missingFailureFor(path);
  files.delete(path);
  expect(probeContainer()).toBe(expected);
  expect(await runJourney(request)).toEqual({ result: 'FAIL', reason: 'host_refused', protectionFailure: expected });
}
it.each(['/proc/self/cgroup', '/proc/self/mountinfo', '/sys/fs/cgroup/cgroup.procs',
  '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max',
  '/sys/fs/cgroup/memory.swap.current', '/sys/kernel/kexec_crash_loaded'])(
  'refuses missing container controls %s', refusesMissing);
function refusesProcess(): void {
  vi.mocked(runnerProtected).mockReturnValue('process_dumpable');
  expect(probeContainer()).toBe('process_dumpable');
}
it('refuses a dumpable, unlimited or unmeasurable runner', refusesProcess);
function resolvesSubgroup(): void {
  files.set('/proc/self/cgroup', '0::/parent/child\n');
  files.set('/proc/self/mountinfo', mount.replace(' / /sys', ' /parent /sys'));
  for (const name of ['cgroup.procs', 'memory.max', 'memory.swap.max', 'memory.swap.current']) {
    files.set(`/sys/fs/cgroup/child/${name}`, files.get(`/sys/fs/cgroup/${name}`)!);
    files.delete(`/sys/fs/cgroup/${name}`);
  }
  expect(probeContainer()).toBe(true);
}
it('resolves membership relative to the mounted cgroup root', resolvesSubgroup);
function refusesMovedGroup(): void {
  function readAndMove(path: unknown): string {
    const value = read(path);
    if (String(path).endsWith('memory.max')) {
      files.set('/proc/self/cgroup', '0::/other\n');
    }
    return value;
  }
  vi.mocked(readFileSync).mockImplementation(readAndMove);
  expect(probeContainer()).toBe('swap_measurement_failed');
}
it('refuses membership that moves while controls are read', refusesMovedGroup);
function refusesRedirect(): void {
  vi.mocked(realpathSync).mockReturnValue('/different');
  expect(probeContainer()).toBe('swap_measurement_failed');
}
it('refuses a cgroup path that resolves elsewhere', refusesRedirect);

function missingFailureFor(path: string): string {
  if (path.endsWith('memory.max')) {
    return 'memory_limit_unproved';
  }
  if (path.endsWith('kexec_crash_loaded')) {
    return 'crash_kernel_unproved';
  }
  return 'swap_measurement_failed';
}
function failureFor(path: string): string {
  if (path.includes('memory.swap.')) {
    return 'swap_not_disabled';
  }
  return missingFailureFor(path);
}
async function namesRunnerFailure(protectionFailure: 'helper_unavailable' | 'core_limit_not_zero' |
  'process_dumpable'): Promise<void> {
  vi.mocked(runnerProtected).mockReturnValue(protectionFailure);
  expect(probeContainer()).toBe(protectionFailure);
  expect(await runJourney(request)).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure,
  });
}
it.each(['helper_unavailable', 'core_limit_not_zero', 'process_dumpable'] as const)(
  'preserves %s when swap and memory controls are safe', namesRunnerFailure);

async function refusesCoreHelper(): Promise<void> {
  files.set('/proc/sys/fs/suid_dumpable', '2\n');
  const expected = {
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'core_helper_enabled',
  };
  expect(await runJourney(request)).toEqual(expected);
}
it.each(['1\n', '2\n'])(
  'refuses a core_pattern helper when suid_dumpable is %s', refusesCoreHelper,
);

const coreSettings = [
  ['/proc/sys/kernel/core_pattern', 'core_pattern_unreadable'],
  ['/proc/sys/fs/suid_dumpable', 'suid_dumpable_unreadable'],
];
async function refusesUnreadableCoreSetting(path: string, protectionFailure: string): Promise<void> {
  files.delete(path);
  const expected = { result: 'FAIL', reason: 'host_refused', protectionFailure };
  expect(await runJourney(request)).toEqual(expected);
}
it.each(coreSettings)(
  'refuses an unreadable core dump setting %s', refusesUnreadableCoreSetting);

async function allowsCoreSetting(pattern: string, privileged: string): Promise<void> {
  files.set('/proc/sys/kernel/core_pattern', pattern);
  files.set('/proc/sys/fs/suid_dumpable', privileged);
  expect(await runJourney(request)).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'private_process_missing',
    complete: false,
  });
  vi.mocked(runnerProtected).mockReturnValue('core_limit_not_zero');
  expect(await runJourney(request)).toEqual({
    result: 'FAIL', reason: 'host_refused', protectionFailure: 'core_limit_not_zero',
  });
}
const allowedCoreSettings = [
  ['|/private/collector %p\n', '0\n'],
  ['core.%p\n', '2\n'],
  ['\n', '0\n'],
];
it.each(allowedCoreSettings)(
  'allows core dump settings case %# only with zero core limits', allowsCoreSetting);

async function refusesUnknownCoreSetting(
  path: string, value: string, protectionFailure: string,
): Promise<void> {
  files.set(path, value);
  const expected = { result: 'FAIL', reason: 'host_refused', protectionFailure };
  expect(await runJourney(request)).toEqual(expected);
}
const unknownCoreSettings = [
  ['/proc/sys/kernel/core_pattern', '', 'core_pattern_unreadable'],
  ['/proc/sys/fs/suid_dumpable', '', 'suid_dumpable_unreadable'],
  ['/proc/sys/fs/suid_dumpable', 'unknown\n', 'suid_dumpable_unreadable'],
];
it.each(unknownCoreSettings)(
  'refuses an unknown core dump setting case %#', refusesUnknownCoreSetting);
