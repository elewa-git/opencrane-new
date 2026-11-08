import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runInContainer } from './container-process.ts';
import { proveComputerSupervisor } from './supervisor-proof.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./container-process.ts', { spy: true });

const containerId = 'a'.repeat(64);
const installationId = `sha256:${'b'.repeat(64)}`;
const image = `sha256:${'c'.repeat(64)}`;
let pid = 4321;
let response: Record<string, unknown> = {};

function inspect(): string {
  return JSON.stringify([{ Id: containerId, Image: image,
    State: { Running: true, StartedAt: '2026-11-08T00:00:00Z', Pid: pid },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [] }]);
}
function answer(_container: string, _args: string[], input = ''): Promise<unknown> {
  const parsed: unknown = JSON.parse(input);
  const request = z.record(z.string(), z.unknown()).parse(parsed);
  if (response['result'] === 'swap_not_disabled') {
    return Promise.resolve({ ...request, result: 'swap_not_disabled' });
  }
  return Promise.resolve({ ...request, result: true, pid: 1, startTime: '123', ...response });
}
function prepare(): void {
  vi.clearAllMocks();
  pid = 4321;
  response = {};
  vi.mocked(execFileSync).mockImplementation(inspect);
  vi.mocked(runInContainer).mockImplementation(answer);
}
beforeEach(prepare);

async function provesPackagedInspectorOnly(): Promise<void> {
  expect(await proveComputerSupervisor(containerId, installationId)).toBe(true);
  const args = vi.mocked(runInContainer).mock.calls[0]?.[1];
  expect(args).toContain('/scripts/private-memory-qualification/supervisor-check.ts');
  expect(vi.mocked(runInContainer).mock.calls[0]?.[0]).toBe(containerId);
}
it('runs the fixed supervisor inspector in the owner-selected computer',
  provesPackagedInspectorOnly);

async function refusesClaimedReceipt(): Promise<void> {
  response = { result: 'PASS', complete: true };
  expect(await proveComputerSupervisor(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('does not accept an application-shaped success receipt', refusesClaimedReceipt);

async function refusesReplacementDuringInspection(): Promise<void> {
  let reads = 0;
  vi.mocked(execFileSync).mockImplementation(function changed() {
    reads += 1;
    if (reads === 2) pid = 4322;
    return inspect();
  });
  expect(await proveComputerSupervisor(containerId, installationId))
    .toBe('private_process_identity_changed');
}
it('refuses a replaced owner-installed container after inspection',
  refusesReplacementDuringInspection);

async function refusesLostInspector(): Promise<void> {
  vi.mocked(runInContainer).mockRejectedValue(new Error('private path and arguments'));
  expect(await proveComputerSupervisor(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('returns only a fixed category when inspection is lost', refusesLostInspector);

async function refusesUnprotectedComputer(): Promise<void> {
  response = { result: 'swap_not_disabled' };
  expect(await proveComputerSupervisor(containerId, installationId))
    .toBe('swap_not_disabled');
}
it('forwards only the fixed protection category', refusesUnprotectedComputer);
