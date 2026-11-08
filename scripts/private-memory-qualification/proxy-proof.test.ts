import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { runInContainer } from './container-process.ts';
import { proveComputerProxy } from './proxy-proof.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./container-process.ts', { spy: true });

const containerId = 'a'.repeat(64);
const installationId = `sha256:${'b'.repeat(64)}`;
let computerPid = 4321;
let inspected = 0;
let reply: Record<string, unknown> = {};

function inspect(): string {
  inspected += 1;
  return JSON.stringify([{ Id: containerId, Image: `sha256:${'c'.repeat(64)}`,
    State: { Running: true, StartedAt: '2026-11-08T00:00:00Z', Pid: computerPid },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [] }]);
}

function answer(_container: string, _args: string[], input = ''): Promise<unknown> {
  const request = JSON.parse(input) as Record<string, string>;
  return Promise.resolve({ ...request, result: true, pid: 24, startTime: '123', ...reply });
}

function prepare(): void {
  vi.clearAllMocks();
  computerPid = 4321;
  inspected = 0;
  reply = {};
  vi.mocked(execFileSync).mockImplementation(inspect);
  vi.mocked(runInContainer).mockImplementation(answer);
}
beforeEach(prepare);

async function provesOnlyThePackagedProxy(): Promise<void> {
  expect(await proveComputerProxy(containerId, installationId)).toBe(true);
  const call = vi.mocked(runInContainer).mock.calls[0];
  expect(call?.[0]).toBe(containerId);
  expect(call?.[1]).toContain('/scripts/private-memory-qualification/proxy-check.ts');
  expect(inspected).toBe(2);
}
it('inspects the owner-installed computer around the live proxy challenge',
  provesOnlyThePackagedProxy);

async function refusesReplacement(): Promise<void> {
  function replacingInspect(): string {
    if (inspected === 1) computerPid = 4322;
    return inspect();
  }
  vi.mocked(execFileSync).mockImplementation(replacingInspect);
  expect(await proveComputerProxy(containerId, installationId))
    .toBe('private_process_identity_changed');
}
it('refuses replacement during a held request', refusesReplacement);

async function refusesLostInspection(): Promise<void> {
  vi.mocked(runInContainer).mockRejectedValue(new Error('private arguments'));
  expect(await proveComputerProxy(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('returns only a fixed reason for failed inspection', refusesLostInspection);

async function refusesAnAssertion(): Promise<void> {
  reply = { result: 'PASS', complete: true };
  expect(await proveComputerProxy(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('does not accept a claimed success', refusesAnAssertion);

async function forwardsProtectionFailure(): Promise<void> {
  reply = { result: 'process_dumpable' };
  expect(await proveComputerProxy(containerId, installationId)).toBe('process_dumpable');
}
it('refuses a dumpable proxy', forwardsProtectionFailure);
