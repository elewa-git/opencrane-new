import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { runInContainer } from './container-process.ts';
import { isProtectionFailure, type ProtectionFailure } from './protection-failure.ts';

type ContainerIdentity = {
  Id: string;
  Image: string;
  State: { Running: boolean; StartedAt: string; Pid: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDataMount(destination: string): boolean {
  // Allow the computer's fixed data homes while keeping shipped code inside the image.
  const computerHomes = new Set([
    '/home/agent', '/home/codex', '/home/desktop', '/home/private', '/home/tool',
  ]);
  if (computerHomes.has(destination) || destination === '/tmp') {
    return true;
  }
  return destination === '/run' || destination.startsWith('/run/') ||
    destination === '/var' || destination.startsWith('/var/');
}

function containerIdentity(containerId: string): ContainerIdentity {
  const args = ['--host', 'unix:///var/run/docker.sock', 'inspect', '--type', 'container',
    containerId];
  const options = { timeout: 10_000, maxBuffer: 65_536, stdio: 'pipe' as const };
  const output = execFileSync('/usr/bin/docker', args, options);
  const parsed: unknown = JSON.parse(output.toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 1 || !isRecord(parsed[0])) {
    throw new Error('private_process_unreadable');
  }
  const value = parsed[0];
  const state = value['State'];
  const hostConfig = value['HostConfig'];
  const mounts = value['Mounts'];
  if (value['Id'] !== containerId || typeof value['Image'] !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(value['Image']) || !isRecord(state) ||
      state['Running'] !== true || typeof state['StartedAt'] !== 'string' ||
      typeof state['Pid'] !== 'number' || !Number.isSafeInteger(state['Pid']) ||
      state['Pid'] <= 0 ||
      !isRecord(hostConfig) || hostConfig['ReadonlyRootfs'] !== true ||
      !Array.isArray(mounts)) {
    throw new Error('private_process_identity_changed');
  }
  for (const mount of mounts) {
    if (!isRecord(mount) || typeof mount['Destination'] !== 'string' ||
        !isDataMount(mount['Destination'])) {
      throw new Error('private_process_identity_changed');
    }
  }
  return { Id: containerId, Image: value['Image'],
    State: { Running: true, StartedAt: state['StartedAt'], Pid: state['Pid'] } };
}

function sameContainer(first: ContainerIdentity, second: ContainerIdentity): boolean {
  return first.Id === second.Id && first.Image === second.Image &&
    first.State.StartedAt === second.State.StartedAt &&
    first.State.Pid === second.State.Pid;
}

function computerInstallation(identity: ContainerIdentity): string {
  const fields = [identity.Id, identity.Image, identity.State.StartedAt, identity.State.Pid];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(fields));
  return `sha256:${hash.digest('hex')}`;
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
  const result = value['result'];
  if (result === true) {
    if (Object.keys(value).length !== 7 || !Number.isSafeInteger(value['pid']) ||
        Number(value['pid']) <= 1 || typeof value['startTime'] !== 'string' ||
        !/^[1-9][0-9]*$/u.test(value['startTime'])) {
      return 'private_process_unreadable';
    }
    return true;
  }
  if (Object.keys(value).length === 5 && isProtectionFailure(result)) {
    return result;
  }
  return 'private_process_unreadable';
}

// Use only the collector's measured container, never a caller's process observation.
export async function proveComputerBridge(containerId: string,
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
      '/scripts/private-memory-qualification/bridge-check.ts'];
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
