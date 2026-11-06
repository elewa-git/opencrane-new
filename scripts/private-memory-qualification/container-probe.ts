import { readFileSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import type { ProtectionFailure } from './protection-failure.ts';
import { runnerProtected } from './runner-protection.ts';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}
function plainPath(path: string): boolean {
  return path.startsWith('/') && !/[\\\s]/u.test(path) && posix.normalize(path) === path;
}
function beneath(path: string, root: string): boolean {
  return path === root || path.startsWith(root === '/' ? root : `${root}/`);
}
function controlsUncovered(group: string, groupMount: string, locations: string[]): boolean {
  // Refuse mounts covering the directory or controls, including duplicate mounts.
  let matchingMounts = 0;
  for (const location of locations) {
    if (location === groupMount) {
      matchingMounts += 1;
      continue;
    }
    if (beneath(location, group) ||
        (beneath(group, location) && beneath(location, groupMount))) {
      return false;
    }
  }
  return matchingMounts === 1;
}
function directory(membership: string, mounts: string): string | undefined {
  const member = /^0::([^\n]+)\n$/u.exec(membership)?.[1];
  if (!member || !plainPath(member)) {
    return undefined;
  }
  const trimmedMounts = mounts.trimEnd();
  const lines = trimmedMounts.split('\n');
  const locations: string[] = [];
  let group: string | undefined;
  let groupMount: string | undefined;
  for (const line of lines) {
    const parts = line.split(' - ');
    if (parts.length !== 2) {
      return undefined;
    }
    const fields = parts[0]!.split(' ');
    const root = fields[3];
    const mount = fields[4];
    if (!root || !mount || !plainPath(root) || !plainPath(mount)) {
      return undefined;
    }
    locations.push(mount);
    if (!parts[1]!.startsWith('cgroup2 ')) {
      continue;
    }
    if (group || !beneath(member, root)) {
      return undefined;
    }
    const relative = posix.relative(root, member);
    group = posix.join(mount, relative);
    groupMount = mount;
  }
  if (!group || !groupMount || realpathSync(group) !== group ||
      !controlsUncovered(group, groupMount, locations)) {
    return undefined;
  }
  return group;
}
function ownsProcess(group: string): boolean {
  const processes = read(`${group}/cgroup.procs`);
  if (!/^(?:[1-9][0-9]*\n)+$/u.test(processes)) {
    return false;
  }
  const entries = processes.split('\n');
  return entries.includes(String(process.pid));
}

function coreDumpsProtected(): true | ProtectionFailure {
  let failure: ProtectionFailure = 'core_pattern_unreadable';
  try {
    const pattern = read('/proc/sys/kernel/core_pattern');
    if (!/^[^\n]*\n$/u.test(pattern)) {
      return failure;
    }
    failure = 'suid_dumpable_unreadable';
    const privileged = read('/proc/sys/fs/suid_dumpable');
    if (!/^[012]\n$/u.test(privileged)) {
      return failure;
    }
    // Refuse pipe helpers that can ignore the runner's zero core limits.
    if (pattern.startsWith('|') && privileged !== '0\n') {
      return 'core_helper_enabled';
    }
    return true;
  } catch {
    return failure;
  }
}

// Prove only this runner's prerequisites. Other processes still need their own checks.
export function probeContainer(): true | ProtectionFailure {
  let failure: ProtectionFailure = 'swap_measurement_failed';
  try {
    const membership = read('/proc/self/cgroup');
    const mounts = read('/proc/self/mountinfo');
    const group = directory(membership, mounts);
    if (!group || !ownsProcess(group)) {
      return failure;
    }
    failure = 'memory_limit_unproved';
    const memory = read(`${group}/memory.max`);
    if (!/^[1-9][0-9]*\n$/u.test(memory) || !Number.isSafeInteger(Number(memory))) {
      return failure;
    }
    failure = 'swap_measurement_failed';
    if (read(`${group}/memory.swap.max`) !== '0\n' ||
        read(`${group}/memory.swap.current`) !== '0\n') {
      return 'swap_not_disabled';
    }
    failure = 'crash_kernel_unproved';
    if (read('/sys/kernel/kexec_crash_loaded') !== '0\n') {
      return failure;
    }
    const protection = runnerProtected();
    if (protection !== true) {
      return protection;
    }
    const coreProtection = coreDumpsProtected();
    if (coreProtection !== true) {
      return coreProtection;
    }
    // Refuse a move or remount during measurement; repeat after awaited work too.
    failure = 'swap_measurement_failed';
    if (read('/proc/self/cgroup') !== membership ||
        read('/proc/self/mountinfo') !== mounts || !ownsProcess(group)) {
      return failure;
    }
    return true;
  } catch {
    return failure;
  }
}
