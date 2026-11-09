import { checkBridge, checkProxy } from './bridge-check.ts';
import { checkSupervisor } from './supervisor-check.ts';
import { lstatSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { pinnedNativeBinary, proveNativePair } from './native-process-proof.ts';
import {
  checkLiveService, readProcessIdentity, sameProcessIdentity, serverIdentity,
  type ProcessIdentity,
} from './private-processes.ts';

export type LiveServiceGroup = 'serverDelivery' | 'supervisor' | 'bridge' | 'proxy' |
  'nativeWrapper' | 'nativeChild' | 'canaryHelper';
type LiveProcess = { pid: number; startTime: string; pidNamespace: string;
  executable: string; uid: number; cgroup: string; protected: true };
type ProcessProof = { result: unknown; pid?: number; startTime?: string };

function serverProcess(): ProcessIdentity | undefined {
  const identity = serverIdentity();
  if (!identity || identity.uid !== 1000) {
    return undefined;
  }
  const protection = checkLiveService('serverDelivery', identity);
  if (protection !== true) {
    return undefined;
  }
  return identity;
}

function serviceProof(group: Exclude<LiveServiceGroup, 'serverDelivery'>,
  observeIdentity: (identity: ProcessIdentity) => void): ProcessProof {
  if (group === 'supervisor') {
    return checkSupervisor(observeIdentity);
  }
  if (group === 'bridge') {
    return checkBridge(observeIdentity);
  }
  return checkProxy(observeIdentity);
}

function serviceProcess(group: 'supervisor' | 'bridge' | 'proxy'):
  ProcessIdentity | undefined {
  // Keep the identity checked with dump protection; exec can retain PID and start time.
  let checkedIdentity: ProcessIdentity | undefined;
  function holdCheckedIdentity(identity: ProcessIdentity): void {
    checkedIdentity = identity;
  }
  const proof = serviceProof(group, holdCheckedIdentity);
  if (proof.result !== true || proof.pid === undefined || proof.startTime === undefined) {
    return undefined;
  }
  if (!checkedIdentity || checkedIdentity.pid !== proof.pid ||
      checkedIdentity.startTime !== proof.startTime) {
    return undefined;
  }
  const identity = readProcessIdentity(proof.pid);
  if (!sameProcessIdentity(checkedIdentity, identity)) {
    return undefined;
  }
  return identity;
}

function nativeProcess(group: 'nativeWrapper' | 'nativeChild',
  challengeId: string): ProcessIdentity | undefined {
  const names = readdirSync('/run');
  const records = names.filter(function belongsToChallenge(name): boolean {
    if (!/^opencrane-native-[0-9a-f-]{36}\.identity$/u.test(name)) {
      return false;
    }
    const record = lstatSync(`/run/${name}`);
    if (!record.isFile() || record.uid !== 0 || record.nlink !== 1 ||
        (record.mode & 0o077) !== 0 || record.size > 128) {
      return false;
    }
    return readFileSync(`/run/${name}`, 'utf8').startsWith(`${challengeId} `);
  });
  if (records.length !== 1) {
    return undefined;
  }
  const recordPath = `/run/${records[0]}`;
  const contents = readFileSync(recordPath, 'utf8');
  const fields = /^([0-9a-f-]{36}) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*)\n$/u.exec(contents);
  if (!fields || fields[1] !== challengeId) {
    return undefined;
  }
  const wrapperPid = Number(fields[2]);
  const childPid = Number(fields[4]);
  const stat = readFileSync(`/proc/${wrapperPid}/stat`, 'utf8');
  const parent = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1];
  const runnerPid = Number(parent);
  const binding = { challengeId, wrapperPid, childPid, recordPath,
    childBinary: pinnedNativeBinary(), runnerPid };
  if (proveNativePair(binding) !== true) {
    return undefined;
  }
  const pid = group === 'nativeWrapper' ? wrapperPid : childPid;
  const identity = readProcessIdentity(pid);
  const expectedStart = group === 'nativeWrapper' ? fields[3] : fields[5];
  const wrapperCommand = '/usr/local/bin/node\0--disable-sigusr1\0' +
    '/usr/local/bin/codex\0app-server\0--stdio\0';
  const childCommand = `${binding.childBinary}\0app-server\0--stdio\0`;
  const expectedExecutable = group === 'nativeWrapper' ?
    '/usr/local/bin/node' : binding.childBinary;
  const expectedCommand = group === 'nativeWrapper' ? wrapperCommand : childCommand;
  if (identity.startTime !== expectedStart || identity.uid !== 1003 ||
      identity.executable !== expectedExecutable ||
      identity.commandLine !== expectedCommand) {
    return undefined;
  }
  return identity;
}

function canaryProcess(challengeId: string, imageDigest: string,
  installationId: string): ProcessIdentity | undefined {
  const directory = '/run/opencrane-memory-qualification.lock';
  const recordPath = `${directory}/helper-identity`;
  const directoryStat = lstatSync(directory);
  const recordStat = lstatSync(recordPath);
  if (statfsSync(directory).type !== 0x01021994 ||
      !directoryStat.isDirectory() || directoryStat.uid !== 0 ||
      (directoryStat.mode & 0o077) !== 0 ||
      !recordStat.isFile() || recordStat.uid !== 0 || recordStat.nlink !== 1 ||
      (recordStat.mode & 0o077) !== 0 || recordStat.size > 300) {
    return undefined;
  }
  const contents = readFileSync(recordPath, 'utf8');
  const fields = /^([0-9a-f-]{36}) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) (sha256:[a-f0-9]{64}) (sha256:[a-f0-9]{64})\n$/u.exec(contents);
  if (!fields || fields[1] !== challengeId || fields[6] !== imageDigest ||
      fields[7] !== installationId) {
    return undefined;
  }
  const helper = readProcessIdentity(Number(fields[2]));
  const supervisor = readProcessIdentity(Number(fields[4]));
  const stat = readFileSync(`/proc/${helper.pid}/stat`, 'utf8');
  const parentPid = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1]);
  const helperCommand = '/usr/local/bin/node\0--experimental-strip-types\0' +
    '/app/scripts/private-memory-qualification/journey.mjs\0';
  if (helper.startTime !== fields[3] || supervisor.startTime !== fields[5] ||
      parentPid !== supervisor.pid ||
      helper.uid !== 0 || supervisor.uid !== 0 ||
      helper.executable !== '/usr/local/bin/node' ||
      supervisor.executable !== '/usr/local/bin/node' ||
      helper.commandLine !== helperCommand ||
      !supervisor.commandLine.startsWith('/usr/local/bin/node\0--input-type=module\0--eval\0') ||
      helper.cgroup !== supervisor.cgroup ||
      helper.containerIdentity !== supervisor.containerIdentity ||
      checkLiveService('canaryHelper', helper) !== true) {
    return undefined;
  }
  return helper;
}

// Keep only the measured process numbers. Commands and other proc data stay in this container.
export function probeInventoryProcess(group: LiveServiceGroup, challengeId?: string,
  imageDigest?: string, installationId?: string): LiveProcess | undefined {
  try {
    let first: ProcessIdentity | undefined;
    if (group === 'nativeWrapper' || group === 'nativeChild') {
      first = challengeId ? nativeProcess(group, challengeId) : undefined;
    } else if (group === 'canaryHelper') {
      first = challengeId && imageDigest && installationId ?
        canaryProcess(challengeId, imageDigest, installationId) : undefined;
    } else if (group === 'serverDelivery') {
      first = serverProcess();
    } else {
      first = serviceProcess(group);
    }
    if (!first) {
      return undefined;
    }
    const final = readProcessIdentity(first.pid);
    if (!sameProcessIdentity(first, final)) {
      return undefined;
    }
    return { pid: final.pid, startTime: final.startTime,
      pidNamespace: final.containerIdentity, executable: final.executable,
      uid: final.uid, cgroup: final.cgroup, protected: true };
  } catch {
    return undefined;
  }
}

function isGroup(value: string | undefined): value is LiveServiceGroup {
  return value === 'serverDelivery' || value === 'supervisor' ||
    value === 'bridge' || value === 'proxy' || value === 'nativeWrapper' ||
    value === 'nativeChild' || value === 'canaryHelper';
}

if (process.argv[1]?.endsWith('/live-inventory-probe.ts')) {
  const group = process.argv[2];
  const result = isGroup(group) ?
    probeInventoryProcess(group, process.argv[3], process.argv[4], process.argv[5]) : undefined;
  process.stdout.write(JSON.stringify(result ?? null));
}
