import { readFileSync, realpathSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import { runnerProtected } from './runner-protection.ts';

vi.mock('node:fs', { spy: true });
vi.mock('./runner-protection.ts', { spy: true });
let files: Map<string, string>;
const mount = '29 23 0:26 / /sys/fs/cgroup ro - cgroup2 cgroup rw\n';
function read(path: unknown): string {
  const value = files.get(String(path));
  if (value === undefined) throw new Error('private observation unavailable');
  return value;
}
function unchangedPath(path: unknown): string {
  return String(path);
}
function prepare(): void {
  files = new Map([
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
}
beforeEach(prepare);
function acceptsOwnGroup(): void {
  expect(probeContainer()).toBe(true);
  expect(runnerProtected).toHaveBeenCalled();
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
function refusesUnsafe(path: string, value: string): void {
  files.set(path, value);
  expect(probeContainer()).toBe(false);
}
it.each(unsafe)('refuses an unsafe container observation %s: %s', refusesUnsafe);
function refusesMissing(path: string): void {
  files.delete(path);
  expect(probeContainer()).toBe(false);
}
it.each(['/proc/self/cgroup', '/proc/self/mountinfo', '/sys/fs/cgroup/cgroup.procs',
  '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max',
  '/sys/fs/cgroup/memory.swap.current', '/sys/kernel/kexec_crash_loaded'])(
  'refuses missing container controls %s', refusesMissing);
function refusesProcess(): void {
  vi.mocked(runnerProtected).mockReturnValue(false);
  expect(probeContainer()).toBe(false);
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
    if (String(path).endsWith('memory.max')) files.set('/proc/self/cgroup', '0::/other\n');
    return value;
  }
  vi.mocked(readFileSync).mockImplementation(readAndMove);
  expect(probeContainer()).toBe(false);
}
it('refuses membership that moves while controls are read', refusesMovedGroup);
