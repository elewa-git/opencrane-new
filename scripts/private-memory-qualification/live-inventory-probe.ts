import { checkBridge, checkProxy } from './bridge-check.ts';
import { checkSupervisor } from './supervisor-check.ts';
import {
  checkLiveService, readProcessIdentity, sameProcessIdentity, serverIdentity,
  type ProcessIdentity,
} from './private-processes.ts';

export type LiveServiceGroup = 'serverDelivery' | 'supervisor' | 'bridge' | 'proxy';
type LiveProcess = { pid: number; startTime: string; pidNamespace: string; protected: true };
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

function serviceProcess(group: Exclude<LiveServiceGroup, 'serverDelivery'>):
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

// Keep only the measured process numbers. Commands and other proc data stay in this container.
export function probeInventoryProcess(group: LiveServiceGroup): LiveProcess | undefined {
  try {
    let first: ProcessIdentity | undefined;
    if (group === 'serverDelivery') {
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
      pidNamespace: final.containerIdentity, protected: true };
  } catch {
    return undefined;
  }
}

function isGroup(value: string | undefined): value is LiveServiceGroup {
  return value === 'serverDelivery' || value === 'supervisor' ||
    value === 'bridge' || value === 'proxy';
}

if (process.argv[1]?.endsWith('/live-inventory-probe.ts')) {
  const group = process.argv[2];
  const result = isGroup(group) ? probeInventoryProcess(group) : undefined;
  process.stdout.write(JSON.stringify(result ?? null));
}
