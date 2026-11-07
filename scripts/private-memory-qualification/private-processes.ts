import { readFileSync, readlinkSync } from 'node:fs';
import { runnerProtected } from './runner-protection.ts';
import type { ProtectionFailure } from './protection-failure.ts';

export const privateProcessNames = [
  'runner', 'serverDelivery', 'bridge', 'supervisor', 'proxy', 'nativeWrapper',
  'nativeChild', 'canaryHelper',
] as const;
type PrivateProcessName = typeof privateProcessNames[number];

export type ProcessIdentity = {
  pid: number;
  startTime: string;
  executable: string;
  uid: number;
  cgroup: string;
  containerIdentity: string;
};

function startTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(') ');
  if (commandEnd < 0) {
    throw new Error('private_process_unreadable');
  }
  const fieldsText = stat.slice(commandEnd + 2);
  const trimmedFieldsText = fieldsText.trimEnd();
  const fields = trimmedFieldsText.split(' ');
  const value = fields[19];
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error('private_process_unreadable');
  }
  return value;
}

function processUid(status: string): number {
  const match = /^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/mu.exec(status);
  if (!match || match[1] !== match[2] || match[2] !== match[3] ||
      match[3] !== match[4]) {
    throw new Error('private_process_unreadable');
  }
  const uid = Number(match[1]);
  if (!Number.isSafeInteger(uid)) {
    throw new Error('private_process_unreadable');
  }
  return uid;
}

export function readProcessIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('private_process_unreadable');
  }
  try {
    const prefix = `/proc/${pid}`;
    const stat = readFileSync(`${prefix}/stat`, 'utf8');
    const status = readFileSync(`${prefix}/status`, 'utf8');
    const cgroup = readFileSync(`${prefix}/cgroup`, 'utf8');
    const executable = readlinkSync(`${prefix}/exe`);
    const containerIdentity = readlinkSync(`${prefix}/ns/pid`);
    const observedStart = startTime(stat);
    const observedUid = processUid(status);
    if (!/^0::\/[^\n]*\n$/u.test(cgroup) || !executable.startsWith('/') ||
        executable.endsWith(' (deleted)') ||
        !/^pid:\[[1-9][0-9]*\]$/u.test(containerIdentity)) {
      throw new Error('private_process_unreadable');
    }
    // Refuse a reused PID while its separate proc files are being read.
    const finalStat = readFileSync(`${prefix}/stat`, 'utf8');
    if (startTime(finalStat) !== observedStart) {
      throw new Error('private_process_identity_changed');
    }
    return { pid, startTime: observedStart, executable, uid: observedUid,
      cgroup, containerIdentity };
  } catch (error) {
    if (error instanceof Error && error.message === 'private_process_identity_changed') {
      throw error;
    }
    throw new Error('private_process_unreadable', { cause: error });
  }
}

export function sameProcessIdentity(first: ProcessIdentity, second: ProcessIdentity): boolean {
  return first.pid === second.pid && first.startTime === second.startTime &&
    first.executable === second.executable && first.uid === second.uid &&
    first.cgroup === second.cgroup &&
    first.containerIdentity === second.containerIdentity;
}

export function probePrivateProcessInventory(..._observations: unknown[]): true | ProtectionFailure {
  let first: ProcessIdentity;
  try {
    first = readProcessIdentity(process.pid);
  } catch (error) {
    if (error instanceof Error && error.message === 'private_process_identity_changed') {
      return 'private_process_identity_changed';
    }
    return 'private_process_unreadable';
  }
  const protection = runnerProtected();
  if (protection !== true) {
    return protection;
  }
  let second: ProcessIdentity;
  try {
    second = readProcessIdentity(process.pid);
  } catch {
    return 'private_process_unreadable';
  }
  if (!sameProcessIdentity(first, second)) {
    return 'private_process_identity_changed';
  }
  const currentInventory: Partial<Record<PrivateProcessName, ProcessIdentity>> = {
    runner: second,
  };
  // Refuse before any journey until every named group has live dumpability proof.
  for (const name of privateProcessNames) {
    if (!currentInventory[name]) {
      return 'private_process_missing';
    }
  }
  return true;
}
