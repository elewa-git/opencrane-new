import {
  checkLiveService, readProcessIdentity, sameProcessIdentity, supervisorIdentity,
  type ProcessIdentity,
} from './private-processes.ts';
import { probeContainer } from './container-probe.ts';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';

type Request = { containerId: string; installationId: string;
  computerInstallationId: string; challengeId: string };
type Result = { result: true | ProtectionFailure; pid?: number; startTime?: string };

const commandLine = '/usr/local/bin/node\0--disable-sigusr1\0' +
  '--experimental-strip-types\0/app/src/entrypoint.ts\0';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequest(value: unknown): value is Request {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    return false;
  }
  return typeof value['containerId'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['containerId']) &&
    typeof value['installationId'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value['installationId']) &&
    typeof value['computerInstallationId'] === 'string' &&
    /^sha256:[a-f0-9]{64}$/u.test(value['computerInstallationId']) &&
    typeof value['challengeId'] === 'string' &&
    /^[0-9a-f-]{36}$/u.test(value['challengeId']);
}

function validIdentity(identity: ProcessIdentity, inspector: ProcessIdentity): boolean {
  return identity.pid === 1 && identity.uid === 0 &&
    identity.executable === '/usr/local/bin/node' &&
    identity.commandLine === commandLine &&
    identity.cgroup === inspector.cgroup &&
    identity.containerIdentity === inspector.containerIdentity;
}

export function checkSupervisor(): Result {
  if (process.getuid?.() !== 0) {
    return { result: 'private_process_unreadable' };
  }
  try {
    const inspector = readProcessIdentity(process.pid);
    const container = probeContainer();
    if (container !== true) {
      return { result: container };
    }
    const first = supervisorIdentity();
    if (!first) {
      return { result: 'private_process_missing' };
    }
    if (!validIdentity(first, inspector)) {
      return { result: 'private_process_identity_changed' };
    }
    const protection = checkLiveService('supervisor', first);
    if (protection !== true) {
      return { result: protection };
    }
    const second = supervisorIdentity();
    const finalContainer = probeContainer();
    const finalInspector = readProcessIdentity(process.pid);
    if (finalContainer !== true) {
      return { result: finalContainer };
    }
    if (!second || !sameProcessIdentity(first, second) ||
        !sameProcessIdentity(inspector, finalInspector)) {
      return { result: 'private_process_identity_changed' };
    }
    return { result: true, pid: second.pid, startTime: second.startTime };
  } catch (error) {
    if (error instanceof Error && error.message === 'private_process_identity_changed') {
      return { result: 'private_process_identity_changed' };
    }
    return { result: 'private_process_unreadable' };
  }
}

async function main(): Promise<void> {
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
  const proof = checkSupervisor();
  if (proof.result !== true && !isProtectionFailure(proof.result)) {
    process.stdout.write(JSON.stringify({ ...request, result: 'private_process_unreadable' }));
    return;
  }
  process.stdout.write(JSON.stringify({ ...request, ...proof }));
}

if (process.argv[1]?.endsWith('/supervisor-check.ts')) {
  await main();
}
