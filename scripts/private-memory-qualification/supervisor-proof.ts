import { randomUUID } from 'node:crypto';
import { computerInstallation, containerIdentity, sameContainer } from './bridge-proof.ts';
import { runInContainer } from './container-process.ts';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validResponse(value: unknown, request: Record<string, string>):
  true | ProtectionFailure {
  if (!isRecord(value)) {
    return 'private_process_unreadable';
  }
  for (const [name, expected] of Object.entries(request)) {
    if (value[name] !== expected) {
      return 'private_process_identity_changed';
    }
  }
  if (value['result'] === true) {
    if (Object.keys(value).length !== 7 || value['pid'] !== 1 ||
        typeof value['startTime'] !== 'string' ||
        !/^[1-9][0-9]*$/u.test(value['startTime'])) {
      return 'private_process_unreadable';
    }
    return true;
  }
  if (Object.keys(value).length === 5 && isProtectionFailure(value['result'])) {
    return value['result'];
  }
  return 'private_process_unreadable';
}

// Resolve the root process only through the owner's installed computer container.
export async function proveComputerSupervisor(containerId: string,
  installationId: string): Promise<true | ProtectionFailure> {
  if (!/^[a-f0-9]{64}$/u.test(containerId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(installationId)) {
    return 'private_process_unreadable';
  }
  try {
    const before = containerIdentity(containerId);
    const request = { containerId, installationId,
      computerInstallationId: computerInstallation(before), challengeId: randomUUID() };
    const args = ['/usr/bin/prlimit', '--core=0:0', '--', '/usr/local/bin/node',
      '--experimental-strip-types',
      '/scripts/private-memory-qualification/supervisor-check.ts'];
    const response = await runInContainer(containerId, args, JSON.stringify(request));
    const after = containerIdentity(containerId);
    if (!sameContainer(before, after)) {
      return 'private_process_identity_changed';
    }
    return validResponse(response, request);
  } catch (error) {
    if (error instanceof Error && error.message === 'private_process_identity_changed') {
      return 'private_process_identity_changed';
    }
    return 'private_process_unreadable';
  }
}
