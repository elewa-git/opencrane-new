import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  privateProcessNames, probePrivateProcessInventory, readProcessIdentity,
  sameProcessIdentity,
} from './private-processes.ts';
import { runnerProtected } from './runner-protection.ts';

vi.mock('./runner-protection.ts', { spy: true });
vi.mock('node:fs', { spy: true });

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
}
it('detects PID reuse, UID changes, exec and foreign cgroups', detectsReplacement);

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
  const injected = { runner: readProcessIdentity(process.pid), serverDelivery: true };
  expect(probePrivateProcessInventory(injected)).toBe('private_process_missing');
}
it('does not accept caller observations as process proof', cannotInjectObservations);
