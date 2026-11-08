import { bridgeIdentity, checkLiveService, readProcessIdentity,
  sameProcessIdentity, type ProcessIdentity } from './private-processes.ts';
import { probeContainer } from './container-probe.ts';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';
import type { ServiceRole } from './service-protection.ts';

type Request = { containerId: string; installationId: string;
  computerInstallationId: string; challengeId: string };

const bridgeCommandLine = '/usr/local/bin/node\0--disable-sigusr1\0' +
  '--experimental-strip-types\0/app/src/bridge.ts\0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).length === 4 &&
    typeof value['containerId'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['containerId']) &&
    typeof value['installationId'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value['installationId']) &&
    typeof value['computerInstallationId'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value['computerInstallationId']) &&
    typeof value['challengeId'] === 'string' &&
    /^[0-9a-f-]{36}$/u.test(value['challengeId']);
}

function liveBridge(role: ServiceRole):
  { identity: ProcessIdentity; result: true | ProtectionFailure } {
  const first = bridgeIdentity();
  if (!first) {
    return { identity: readProcessIdentity(process.pid), result: 'private_process_missing' };
  }
  const inspector = readProcessIdentity(process.pid);
  if (first.uid !== 1000 || first.executable !== '/usr/local/bin/node' ||
      first.commandLine !== bridgeCommandLine || first.cgroup !== inspector.cgroup ||
      first.containerIdentity !== inspector.containerIdentity) {
    return { identity: first, result: 'private_process_identity_changed' };
  }
  const protection = checkLiveService(role, first);
  if (protection !== true) {
    return { identity: first, result: protection };
  }
  const second = bridgeIdentity();
  if (!second || !sameProcessIdentity(first, second)) {
    return { identity: first, result: 'private_process_identity_changed' };
  }
  return { identity: second, result: true };
}

function checkComputerService(role: ServiceRole): { pid?: number; startTime?: string;
  result: true | ProtectionFailure } {
  if (process.getuid?.() !== 0) {
    return { result: 'private_process_unreadable' };
  }
  try {
    const before = readProcessIdentity(process.pid);
    const container = probeContainer();
    if (container !== true) {
      return { result: container };
    }
    const bridge = liveBridge(role);
    if (bridge.result !== true) {
      return { result: bridge.result };
    }
    // Repeat the swap, dump and launch checks after the live bridge exchange.
    const finalContainer = probeContainer();
    const finalBridge = bridgeIdentity();
    const after = readProcessIdentity(process.pid);
    if (finalContainer !== true) {
      return { result: finalContainer };
    }
    if (!finalBridge || !sameProcessIdentity(bridge.identity, finalBridge) ||
        !sameProcessIdentity(before, after)) {
      return { result: 'private_process_identity_changed' };
    }
    return { result: true, pid: finalBridge.pid, startTime: finalBridge.startTime };
  } catch {
    return { result: 'private_process_unreadable' };
  }
}

export function checkBridge(): { pid?: number; startTime?: string;
  result: true | ProtectionFailure } {
  return checkComputerService('bridge');
}

export function checkProxy(): { pid?: number; startTime?: string;
  result: true | ProtectionFailure } {
  return checkComputerService('proxy');
}

export async function runServiceCheck(role: 'bridge' | 'proxy'): Promise<void> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1024) {
      break;
    }
  }
  let request: unknown;
  try {
    request = JSON.parse(input);
  } catch {
    request = undefined;
  }
  if (!isRequest(request)) {
    process.stdout.write(JSON.stringify({ result: 'private_process_unreadable' }));
    return;
  }
  const proof = checkComputerService(role);
  if (proof.result !== true && !isProtectionFailure(proof.result)) {
    process.stdout.write(JSON.stringify({ ...request, result: 'private_process_unreadable' }));
    return;
  }
  process.stdout.write(JSON.stringify({ ...request, ...proof }));
}

if (process.argv[1]?.endsWith('/bridge-check.ts')) {
  await runServiceCheck('bridge');
}
