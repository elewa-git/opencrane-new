import { readFileSync, readlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { runnerProtected } from './runner-protection.ts';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';
import type { ServiceRole } from './service-protection.ts';

const require = createRequire(import.meta.url);

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
  commandLine: string;
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
    // Read the arguments in this first snapshot so an exec into another script
    // cannot pass a later command check with the same PID and start time.
    const commandLine = readFileSync(`${prefix}/cmdline`, 'utf8');
    const observedStart = startTime(stat);
    const observedUid = processUid(status);
    if (!/^0::\/[^\n]*\n$/u.test(cgroup) || !executable.startsWith('/') ||
        executable.endsWith(' (deleted)') ||
        !/^pid:\[[1-9][0-9]*\]$/u.test(containerIdentity) ||
        !commandLine.endsWith('\0') || commandLine.length < 2) {
      throw new Error('private_process_unreadable');
    }
    // Refuse a reused PID while its separate proc files are being read.
    const finalStat = readFileSync(`${prefix}/stat`, 'utf8');
    if (startTime(finalStat) !== observedStart) {
      throw new Error('private_process_identity_changed');
    }
    return { pid, startTime: observedStart, executable, uid: observedUid,
      cgroup, containerIdentity, commandLine };
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
    first.containerIdentity === second.containerIdentity &&
    first.commandLine === second.commandLine;
}

type PeerReply = { pid: number; reply: string };
type NativeProbe = { probe(role: ServiceRole, challenge: string): unknown };

function isNativeProbe(value: unknown): value is NativeProbe {
  return value !== null && typeof value === 'object' &&
    'probe' in value && typeof value.probe === 'function';
}

function isPeerReply(value: unknown): value is PeerReply {
  return value !== null && typeof value === 'object' &&
    'pid' in value && Number.isSafeInteger(value.pid) &&
    'reply' in value && typeof value.reply === 'string';
}

function askProtectedProcess(role: ServiceRole): PeerReply | undefined {
  try {
    const module: unknown = require('./runner-protection.node');
    if (!isNativeProbe(module)) {
      return undefined;
    }
    const challenge = randomUUID();
    const reply: unknown = module.probe(role, challenge);
    if (!isPeerReply(reply) || !reply.reply.startsWith(`${challenge}|`) ||
        !reply.reply.endsWith('\n')) {
      return undefined;
    }
    return { pid: reply.pid, reply: reply.reply.slice(challenge.length + 1, -1) };
  } catch {
    return undefined;
  }
}

export function checkLiveService(role: ServiceRole,
  expected: ProcessIdentity): true | ProtectionFailure {
  let first: ProcessIdentity;
  let runner: ProcessIdentity;
  try {
    first = readProcessIdentity(expected.pid);
    runner = readProcessIdentity(process.pid);
  } catch {
    return 'private_process_unreadable';
  }
  if (!sameProcessIdentity(first, expected) ||
      first.cgroup !== runner.cgroup ||
      first.containerIdentity !== runner.containerIdentity ||
      first.executable !== runner.executable) {
    return 'private_process_identity_changed';
  }
  const peer = askProtectedProcess(role);
  if (!peer) {
    return 'private_process_missing';
  }
  if (peer.pid !== expected.pid) {
    return 'private_process_identity_changed';
  }
  let second: ProcessIdentity;
  try {
    second = readProcessIdentity(expected.pid);
  } catch {
    return 'private_process_unreadable';
  }
  if (!sameProcessIdentity(first, second)) {
    return 'private_process_identity_changed';
  }
  if (peer.reply === 'true') {
    return true;
  }
  if (isProtectionFailure(peer.reply)) {
    return peer.reply;
  }
  return 'private_process_unreadable';
}

function commandArguments(identity: ProcessIdentity): string[] {
  const argumentsText = identity.commandLine.slice(0, -1);
  return argumentsText.split('\0');
}

function serverIdentity(): ProcessIdentity | undefined {
  const identity = readProcessIdentity(1);
  const args = commandArguments(identity);
  const script = args[2];
  if (args.length !== 3 || args[1] !== '--experimental-strip-types' ||
      (script !== 'apps/server/src/main.ts' && script !== '/app/apps/server/src/main.ts')) {
    return undefined;
  }
  return identity;
}

export function bridgeIdentity(): ProcessIdentity | undefined {
  const childList = readFileSync('/proc/1/task/1/children', 'utf8');
  const children = childList.trim();
  if (!/^(?:[1-9][0-9]* ?)*$/u.test(children)) {
    throw new Error('private_process_unreadable');
  }
  let found: ProcessIdentity | undefined;
  for (const entry of children.split(' ')) {
    if (!entry) {
      continue;
    }
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid)) {
      throw new Error('private_process_unreadable');
    }
    let identity: ProcessIdentity;
    try {
      identity = readProcessIdentity(pid);
    } catch {
      return undefined;
    }
    const args = commandArguments(identity);
    if (args.length !== 4 || args[1] !== '--disable-sigusr1' ||
        args[2] !== '--experimental-strip-types' || args[3] !== '/app/src/bridge.ts') {
      continue;
    }
    if (found !== undefined) {
      return undefined;
    }
    found = identity;
  }
  return found;
}

function probeService(role: ServiceRole): true | ProtectionFailure {
  let identity: ProcessIdentity | undefined;
  try {
    identity = role === 'serverDelivery' ? serverIdentity() : bridgeIdentity();
  } catch {
    return 'private_process_unreadable';
  }
  if (identity === undefined) {
    return 'private_process_missing';
  }
  if (identity.uid !== 1000) {
    return 'private_process_identity_changed';
  }
  return checkLiveService(role, identity);
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
  const serverDelivery = probeService('serverDelivery');
  if (serverDelivery !== true) {
    return serverDelivery;
  }
  const bridge = probeService('bridge');
  if (bridge !== true) {
    return bridge;
  }
  const proved = new Set<PrivateProcessName>(['runner', 'serverDelivery', 'bridge']);
  // Refuse before any journey until every named group has live dumpability proof.
  for (const name of privateProcessNames) {
    if (!proved.has(name)) {
      return 'private_process_missing';
    }
  }
  return true;
}
