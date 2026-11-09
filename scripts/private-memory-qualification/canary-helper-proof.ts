import { lstatSync, readFileSync, statfsSync } from 'node:fs';
import { probeContainer } from './container-probe.ts';
import { probeHost } from './host-probe.ts';
import {
  readProcessIdentity, sameProcessIdentity, type ProcessIdentity,
} from './private-processes.ts';
import { runnerProtected } from './runner-protection.ts';
import type { ProtectionFailure } from './protection-failure.ts';

export type CanaryHelperBinding = {
  helper: ProcessIdentity;
  supervisor: ProcessIdentity;
  imageDigest: string;
  installationId: string;
};

type InstallationIdentity = { imageDigest: string; installationId: string };

const helperCommand = '/usr/local/bin/node\0--experimental-strip-types\0' +
  '/app/scripts/private-memory-qualification/journey.mjs\0';
const supervisorCommand = '/usr/local/bin/node\0--input-type=module\0--eval\0';
const recordDirectory = '/run/opencrane-memory-qualification.lock';
const recordPath = `${recordDirectory}/helper-identity`;
const recordPattern = new RegExp(
  '^([0-9a-f-]{36}) ([1-9][0-9]*) ([1-9][0-9]*) ' +
  '([1-9][0-9]*) ([1-9][0-9]*) ' +
  '(sha256:[a-f0-9]{64}) (sha256:[a-f0-9]{64})\\n$',
  'u',
);

type JourneyIdentity = { challengeId: string; imageDigest: string; installationId: string };

export function readCanaryHelperBinding(request: JourneyIdentity): CanaryHelperBinding {
  const directory = lstatSync(recordDirectory);
  const record = lstatSync(recordPath);
  if (statfsSync(recordDirectory).type !== 0x01021994 ||
      !directory.isDirectory() || directory.uid !== 0 ||
      (directory.mode & 0o077) !== 0 ||
      !record.isFile() || record.uid !== 0 || record.nlink !== 1 ||
      (record.mode & 0o077) !== 0 || record.size === 0 || record.size > 300) {
    throw new Error('private_process_unreadable');
  }
  const contents = readFileSync(recordPath, 'utf8');
  const fields = recordPattern.exec(contents);
  if (!fields || fields[1] !== request.challengeId ||
      fields[6] !== request.imageDigest || fields[7] !== request.installationId ||
      Number(fields[2]) !== process.pid || Number(fields[4]) !== process.ppid) {
    throw new Error('private_process_identity_changed');
  }
  const helper = readProcessIdentity(process.pid);
  const supervisor = readProcessIdentity(process.ppid);
  if (helper.startTime !== fields[3] || supervisor.startTime !== fields[5]) {
    throw new Error('private_process_identity_changed');
  }
  return { helper, supervisor, imageDigest: fields[6], installationId: fields[7] };
}

function sameInstallation(expected: CanaryHelperBinding,
  observed: InstallationIdentity): boolean {
  return expected.imageDigest === observed.imageDigest &&
    expected.installationId === observed.installationId;
}

function supervisedIdentity(binding: CanaryHelperBinding): boolean {
  const helper = binding.helper;
  const supervisor = binding.supervisor;
  return helper.pid === process.pid && supervisor.pid === process.ppid &&
    helper.uid === 0 && supervisor.uid === 0 &&
    helper.executable === '/usr/local/bin/node' &&
    supervisor.executable === '/usr/local/bin/node' &&
    helper.commandLine === helperCommand &&
    supervisor.commandLine.startsWith(supervisorCommand) &&
    helper.cgroup === supervisor.cgroup &&
    helper.containerIdentity === supervisor.containerIdentity;
}

function currentProcessesMatch(binding: CanaryHelperBinding): boolean {
  const helper = readProcessIdentity(binding.helper.pid);
  const supervisor = readProcessIdentity(binding.supervisor.pid);
  return sameProcessIdentity(helper, binding.helper) &&
    sameProcessIdentity(supervisor, binding.supervisor);
}

function coreLimit(pid: number): true | ProtectionFailure {
  const limits = readFileSync(`/proc/${pid}/limits`, 'utf8');
  const lines = limits.split('\n');
  const coreLines = lines.filter(isCoreLimit);
  if (coreLines.length !== 1) {
    return 'core_limit_measurement_failed';
  }
  if (!/^Max core file size\s+0\s+0\s+bytes\s*$/u.test(coreLines[0]!)) {
    return 'core_limit_not_zero';
  }
  return true;
}

function isCoreLimit(line: string): boolean {
  return line.startsWith('Max core file size');
}

function coreDumping(pid: number): true | ProtectionFailure {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const lines = status.split('\n');
  const coreLines = lines.filter(isCoreDumping);
  if (coreLines.length !== 1) {
    return 'dumpability_measurement_failed';
  }
  if (coreLines[0] !== 'CoreDumping:\t0') {
    return 'process_dumpable';
  }
  return true;
}

function isCoreDumping(line: string): boolean {
  return line.startsWith('CoreDumping:');
}

function protection(pid: number): true | ProtectionFailure {
  if (!probeHost()) {
    const container = probeContainer();
    if (container !== true) {
      return container;
    }
  }
  const limits = coreLimit(pid);
  if (limits !== true) {
    return limits;
  }
  const dumping = coreDumping(pid);
  if (dumping !== true) {
    return dumping;
  }
  // Ask this process for PR_GET_DUMPABLE. Root ownership of proc files alone
  // cannot tell whether a root-owned helper may create a dump.
  return runnerProtected();
}

// Call this inside the supervised helper. The collector must supply a saved
// launch identity and independently measure the image and installation.
export function proveCanaryHelper(binding: CanaryHelperBinding,
  observeInstallation: () => InstallationIdentity): true | ProtectionFailure {
  try {
    if (!supervisedIdentity(binding) ||
        !sameInstallation(binding, observeInstallation()) ||
        !currentProcessesMatch(binding)) {
      return 'private_process_identity_changed';
    }
    const first = protection(binding.helper.pid);
    if (first !== true) {
      return first;
    }
    if (!sameInstallation(binding, observeInstallation()) ||
        !currentProcessesMatch(binding)) {
      return 'private_process_identity_changed';
    }
    const final = protection(binding.helper.pid);
    if (final !== true) {
      return final;
    }
    if (!sameInstallation(binding, observeInstallation()) ||
        !currentProcessesMatch(binding)) {
      return 'private_process_identity_changed';
    }
    return true;
  } catch {
    // Keep proc data and native helper errors out of the journey result.
    return 'private_process_unreadable';
  }
}
