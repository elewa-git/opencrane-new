import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runInContainer } from './container-process.ts';
import { proveComputerBridge } from './bridge-proof.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./container-process.ts', { spy: true });

const containerId = 'a'.repeat(64);
const otherContainerId = 'b'.repeat(64);
const installationId = `sha256:${'c'.repeat(64)}`;
const imageDigest = `sha256:${'d'.repeat(64)}`;
const startedAt = '2026-11-08T00:00:00Z';
let observedContainerId = containerId;
let observedStart = startedAt;
let observedImage = imageDigest;
let reply: Record<string, unknown>;

function inspectContainer(_file: string, args?: readonly string[]): string {
  expect(args).toContain(containerId);
  const observation = [{ Id: observedContainerId, Image: observedImage,
    State: { Running: true, StartedAt: observedStart, Pid: 4321 },
    HostConfig: { ReadonlyRootfs: true }, Mounts: [] }];
  return JSON.stringify(observation);
}

function answerProbe(_container: string, _args: string[], input = ''): Promise<unknown> {
  const parsed: unknown = JSON.parse(input);
  const request = z.record(z.string(), z.unknown()).parse(parsed);
  if (reply['result'] === 'swap_not_disabled') {
    return Promise.resolve({ ...request, ...reply });
  }
  return Promise.resolve({ ...request, result: true, pid: 42, startTime: '100', ...reply });
}

function reset(): void {
  observedContainerId = containerId;
  observedStart = startedAt;
  observedImage = imageDigest;
  reply = {};
  vi.mocked(execFileSync).mockImplementation(inspectContainer);
  vi.mocked(runInContainer).mockImplementation(answerProbe);
}
beforeEach(reset);

async function acceptsOnlyTheBoundContainer(): Promise<void> {
  expect(await proveComputerBridge(containerId, installationId)).toBe(true);
  expect(vi.mocked(runInContainer).mock.calls[0]?.[0]).toBe(containerId);
  const argumentsList = vi.mocked(runInContainer).mock.calls[0]?.[1];
  expect(argumentsList).toContain('/scripts/private-memory-qualification/bridge-check.ts');
}
it('checks the bridge in the measured computer container', acceptsOnlyTheBoundContainer);

async function refusesForeignResponse(): Promise<void> {
  reply = { containerId: otherContainerId };
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('private_process_identity_changed');
}
it('refuses a response from another container', refusesForeignResponse);

async function refusesForeignContainer(): Promise<void> {
  observedContainerId = otherContainerId;
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('private_process_identity_changed');
  expect(runInContainer).not.toHaveBeenCalled();
}
it('refuses a substituted container before the probe starts', refusesForeignContainer);

async function refusesReplacementAfterProbe(): Promise<void> {
  let reads = 0;
  vi.mocked(execFileSync).mockImplementation(function changedAfterProbe(file, args) {
    reads += 1;
    if (reads === 2) observedStart = '2026-11-08T00:01:00Z';
    return inspectContainer(file, args);
  });
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('private_process_identity_changed');
}
it('refuses a container changed between discovery and the final measurement',
  refusesReplacementAfterProbe);

async function refusesUntrustedResult(): Promise<void> {
  reply = { result: 'PASS', complete: true };
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('does not let a caller fill the bridge group with a PASS receipt', refusesUntrustedResult);

async function refusesMalformedProcessProof(): Promise<void> {
  reply = { startTime: '0' };
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('private_process_unreadable');
}
it('requires a live bridge PID and start time in the narrow response',
  refusesMalformedProcessProof);

async function refusesUnprovedBridge(): Promise<void> {
  reply = { result: 'swap_not_disabled' };
  expect(await proveComputerBridge(containerId, installationId))
    .toBe('swap_not_disabled');
}
it('keeps the fixed failure category without process details', refusesUnprovedBridge);
