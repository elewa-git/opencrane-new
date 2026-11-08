import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, statfsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { probeContainer } from './container-probe.ts';
import { readProcessIdentity, sameProcessIdentity, type ProcessIdentity } from './private-processes.ts';
import type { ProtectionFailure } from './protection-failure.ts';

const require = createRequire(import.meta.url);
const wrapperDigest = '61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70';
const wrapperCommand = '/usr/local/bin/node\0--disable-sigusr1\0' +
  '/usr/local/bin/codex\0app-server\0--stdio\0';

type NativeBinding = {
  challengeId: string;
  wrapperPid: number;
  childPid: number;
  recordPath: string;
  childBinary: string;
};

function digest(path: string): string {
  const hash = createHash('sha256');
  hash.update(readFileSync(path));
  return hash.digest('hex');
}

function sameExecutable(pid: number, pinnedBinary: string): boolean {
  const pinned = statSync(pinnedBinary);
  const running = statSync(`/proc/${pid}/exe`);
  return pinned.dev === running.dev && pinned.ino === running.ino &&
    pinned.size === running.size;
}

function processNumbers(pid: number): { parent: number; group: number; start: string;
  running: boolean } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const delimiter = stat.lastIndexOf(') ');
  if (delimiter < 0) {
    throw new Error('private_process_unreadable');
  }
  const fields = stat.slice(delimiter + 2).trimEnd().split(' ');
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const start = fields[19];
  const running = fields[0] !== 'T' && fields[0] !== 't' && fields[0] !== 'Z';
  if (!Number.isSafeInteger(parent) || !Number.isSafeInteger(group) ||
      !start || !/^[1-9][0-9]*$/u.test(start)) {
    throw new Error('private_process_unreadable');
  }
  return { parent, group, start, running };
}

function recordMatches(binding: NativeBinding, wrapper: ProcessIdentity,
  child: ProcessIdentity): boolean {
  if (!/^\/run\/opencrane-native-[0-9a-f-]{36}\.identity$/u.test(binding.recordPath) ||
      statfsSync('/run').type !== 0x01021994) {
    return false;
  }
  const directory = lstatSync('/run');
  if (!directory.isDirectory() || directory.uid !== 0 ||
      (directory.mode & 0o022) !== 0) {
    return false;
  }
  const record = lstatSync(binding.recordPath);
  if (!record.isFile() || record.uid !== 0 || record.nlink !== 1 ||
      (record.mode & 0o077) !== 0 || record.size > 128) {
    return false;
  }
  const expected = `${binding.challengeId} ${wrapper.pid} ${wrapper.startTime} ` +
    `${child.pid} ${child.startTime}\n`;
  return readFileSync(binding.recordPath, 'utf8') === expected;
}

function coreProtected(pid: number): boolean {
  const limits = readFileSync(`/proc/${pid}/limits`, 'utf8');
  const matches = limits.match(/^Max core file size\s+0\s+0\s+bytes[ \t]*$/gmu);
  return matches?.length === 1;
}

type KernelProbe = { pidAlive(pid: number): unknown };

function isKernelProbe(value: unknown): value is KernelProbe {
  return value !== null && typeof value === 'object' &&
    'pidAlive' in value && typeof value.pidAlive === 'function';
}

function kernelAlive(pid: number): boolean {
  const helper: unknown = require('./runner-protection.node');
  if (!isKernelProbe(helper)) {
    return false;
  }
  return helper.pidAlive(pid) === true;
}

function sameNativePipes(wrapperPid: number, childPid: number): boolean {
  for (const descriptor of [0, 1]) {
    const wrapperPipe = readlinkSync(`/proc/${wrapperPid}/fd/${descriptor}`);
    const childPipe = readlinkSync(`/proc/${childPid}/fd/${descriptor}`);
    if (!/^(?:pipe|socket):\[[1-9][0-9]*\]$/u.test(wrapperPipe) ||
        wrapperPipe !== childPipe) {
      return false;
    }
  }
  return true;
}

function identitiesMatch(binding: NativeBinding, wrapper: ProcessIdentity,
  child: ProcessIdentity): boolean {
  const runner = readProcessIdentity(process.pid);
  const wrapperNumbers = processNumbers(binding.wrapperPid);
  const childNumbers = processNumbers(binding.childPid);
  const children = readFileSync(
    `/proc/${binding.wrapperPid}/task/${binding.wrapperPid}/children`, 'utf8',
  );
  if (children !== `${binding.childPid} ` && children !== `${binding.childPid}`) {
    return false;
  }
  if (!wrapperNumbers.running || !childNumbers.running ||
      wrapperNumbers.parent !== runner.pid || childNumbers.parent !== wrapper.pid ||
      wrapperNumbers.group !== childNumbers.group ||
      wrapperNumbers.group !== processNumbers(runner.pid).group ||
      wrapperNumbers.start !== wrapper.startTime || childNumbers.start !== child.startTime) {
    return false;
  }
  if (wrapper.uid !== 1003 || child.uid !== 1003 ||
      wrapper.cgroup !== runner.cgroup || child.cgroup !== runner.cgroup ||
      wrapper.containerIdentity !== runner.containerIdentity ||
      child.containerIdentity !== runner.containerIdentity ||
      wrapper.executable !== '/usr/local/bin/node' ||
      wrapper.commandLine !== wrapperCommand || child.executable !== binding.childBinary ||
      child.commandLine !== `${binding.childBinary}\0app-server\0--stdio\0`) {
    return false;
  }
  if (digest('/usr/local/bin/codex') !== wrapperDigest ||
      !sameExecutable(binding.childPid, binding.childBinary) ||
      !sameNativePipes(wrapper.pid, child.pid) ||
      !coreProtected(wrapper.pid) || !coreProtected(child.pid)) {
    return false;
  }
  return recordMatches(binding, wrapper, child) && kernelAlive(wrapper.pid) &&
    kernelAlive(child.pid);
}

export function proveNativePair(binding: NativeBinding): true | ProtectionFailure {
  try {
    if (!/^[0-9a-f-]{36}$/u.test(binding.challengeId) ||
        !Number.isSafeInteger(binding.wrapperPid) || !Number.isSafeInteger(binding.childPid) ||
        binding.wrapperPid <= 1 || binding.childPid <= 1 ||
        binding.wrapperPid === binding.childPid ||
        !binding.childBinary.startsWith('/')) {
      return 'private_process_identity_changed';
    }
    const firstWrapper = readProcessIdentity(binding.wrapperPid);
    const firstChild = readProcessIdentity(binding.childPid);
    if (!identitiesMatch(binding, firstWrapper, firstChild)) {
      return 'private_process_identity_changed';
    }
    const protection = probeContainer();
    if (protection !== true) {
      return protection;
    }
    const secondWrapper = readProcessIdentity(binding.wrapperPid);
    const secondChild = readProcessIdentity(binding.childPid);
    if (!sameProcessIdentity(firstWrapper, secondWrapper) ||
        !sameProcessIdentity(firstChild, secondChild) ||
        !identitiesMatch(binding, secondWrapper, secondChild)) {
      return 'private_process_identity_changed';
    }
    return true;
  } catch {
    return 'private_process_unreadable';
  }
}
