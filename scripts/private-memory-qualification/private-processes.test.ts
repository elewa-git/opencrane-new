import { readFileSync, readlinkSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  bridgeIdentity, checkLiveService, privateProcessNames, probePrivateProcessInventory,
  readProcessIdentity,
  sameProcessIdentity,
} from './private-processes.ts';
import { runnerProtected } from './runner-protection.ts';

vi.mock('./runner-protection.ts', { spy: true });
vi.mock('node:fs', { spy: true });

async function allowTheHostEntrypointSnapshot(): Promise<void> {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(readlinkSync).mockImplementation(function readLink(path, options) {
    if (path === '/proc/1/exe') {
      return '/usr/lib/systemd/systemd';
    }
    if (path === '/proc/1/ns/pid') {
      return actual.readlinkSync(`/proc/${process.pid}/ns/pid`);
    }
    return actual.readlinkSync(path, options);
  });
}
beforeEach(allowTheHostEntrypointSnapshot);

function readsCurrentProcess(): void {
  const identity = readProcessIdentity(process.pid);
  expect(identity.pid).toBe(process.pid);
  expect(identity.startTime).toMatch(/^[1-9][0-9]*$/u);
  expect(identity.executable).toBe(process.execPath);
  expect(identity.uid).toBe(process.getuid?.());
  expect(identity.cgroup).toMatch(/^0::\//u);
  expect(identity.containerIdentity).toMatch(/^pid:\[[0-9]+\]$/u);
  expect(sameProcessIdentity(identity, readProcessIdentity(process.pid))).toBe(true);
}
it('reads a current process identity from Linux proc files', readsCurrentProcess);

function refusesMissingProcess(): void {
  expect(() => readProcessIdentity(999_999_999)).toThrow('private_process_unreadable');
}
it('refuses a missing process', refusesMissingProcess);

function refusesMalformedStat(): void {
  vi.mocked(readFileSync).mockReturnValueOnce('123 (node) S 1 2\n');
  expect(() => readProcessIdentity(process.pid)).toThrow('private_process_unreadable');
}
it('refuses a stat record without a start time', refusesMalformedStat);

function detectsReplacement(): void {
  const original = readProcessIdentity(process.pid);
  const replacement = { ...original, startTime: String(Number(original.startTime) + 1) };
  expect(sameProcessIdentity(original, replacement)).toBe(false);
  const changedUid = { ...original, uid: original.uid + 1 };
  expect(sameProcessIdentity(original, changedUid)).toBe(false);
  const changedExecutable = { ...original, executable: '/other/node' };
  expect(sameProcessIdentity(original, changedExecutable)).toBe(false);
  const foreignGroup = { ...original, cgroup: '0::/foreign' };
  expect(sameProcessIdentity(original, foreignGroup)).toBe(false);
  const foreignNamespace = { ...original, containerIdentity: 'pid:[1]' };
  expect(sameProcessIdentity(original, foreignNamespace)).toBe(false);
  const changedCommand = { ...original, commandLine: 'node\0/other/script.ts\0' };
  expect(sameProcessIdentity(original, changedCommand)).toBe(false);
}
it('detects PID reuse, changed scripts, UID changes, exec and foreign cgroups',
  detectsReplacement);

function refusesUnprovedGroups(): void {
  vi.mocked(runnerProtected).mockReturnValue(true);
  expect(privateProcessNames).toEqual([
    'runner', 'serverDelivery', 'bridge', 'supervisor', 'proxy', 'nativeWrapper',
    'nativeChild', 'canaryHelper',
  ]);
  expect(probePrivateProcessInventory()).toBe('private_process_missing');
}
it('refuses the container before a journey when another private process is unproved',
  refusesUnprovedGroups);

function cannotInjectObservations(): void {
  vi.mocked(runnerProtected).mockReturnValue(true);
  const injected = { runner: readProcessIdentity(process.pid), serverDelivery: true,
    bridge: true, complete: true, result: 'PASS' };
  expect(probePrivateProcessInventory(injected)).toBe('private_process_missing');
}
it('does not accept caller observations or a forged saved receipt as process proof',
  cannotInjectObservations);

function refusesDeniedProcRead(): void {
  const identity = readProcessIdentity(process.pid);
  vi.mocked(readFileSync).mockImplementationOnce(function denied() {
    throw new Error('private test denial');
  });
  expect(checkLiveService('serverDelivery', identity)).toBe('private_process_unreadable');
}
it('refuses a service whose process files cannot be read', refusesDeniedProcRead);

async function snapshotsServerBeforeCheckingArguments(): Promise<void> {
  const reads: string[] = [];
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(readFileSync).mockImplementation(function recordRead(path, options) {
    const pathText = String(path);
    reads.push(pathText);
    return actual.readFileSync(path, options);
  });
  try {
    vi.mocked(runnerProtected).mockReturnValue(true);
    probePrivateProcessInventory();
  } finally {
    vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
  }
  const firstStat = reads.indexOf('/proc/1/stat');
  const firstArguments = reads.indexOf('/proc/1/cmdline');
  expect(firstStat, reads.join(', ')).toBeGreaterThanOrEqual(0);
  expect(firstArguments).toBeGreaterThan(firstStat);
}
it('takes the server identity snapshot before checking its command arguments',
  snapshotsServerBeforeCheckingArguments);

async function discoverBridgeWithLaunchRecord(recordStartTime: string,
  script = '/app/src/bridge.ts'): Promise<boolean> {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const expected = readProcessIdentity(process.pid);
  const recordPath = '/run/executor/supervisor/bridge-identity';
  const commandLine = `/usr/local/bin/node\0--disable-sigusr1\0` +
    `--experimental-strip-types\0${script}\0`;
  vi.mocked(readFileSync).mockImplementation(function bridgeFile(path, options) {
    if (path === '/proc/1/task/1/children') {
      return `${process.pid} `;
    }
    if (path === `/proc/${process.pid}/cmdline`) {
      return commandLine;
    }
    if (path === recordPath) {
      return `${process.pid} ${recordStartTime}\n`;
    }
    return actual.readFileSync(path, options);
  });
  try {
    return bridgeIdentity() !== undefined;
  } finally {
    vi.mocked(readFileSync).mockImplementation(actual.readFileSync);
  }
}

async function refusesReplacementBridgeChild(): Promise<void> {
  const identity = readProcessIdentity(process.pid);
  const previousStartTime = String(BigInt(identity.startTime) - 1n);
  expect(await discoverBridgeWithLaunchRecord(previousStartTime)).toBe(false);
}
it('refuses a bridge child that replaced the process recorded at launch',
  refusesReplacementBridgeChild);

async function refusesWrongBridgeScript(): Promise<void> {
  const identity = readProcessIdentity(process.pid);
  expect(await discoverBridgeWithLaunchRecord(identity.startTime, '/app/src/other.ts')).toBe(false);
}
it('refuses a launched child running a different script', refusesWrongBridgeScript);
