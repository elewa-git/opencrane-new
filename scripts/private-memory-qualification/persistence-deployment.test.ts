import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { containerIdentity, computerInstallation } from './bridge-proof.ts';
import { assertFresh, assertInstallation, deploymentTarget, hash, measure,
  runCheck } from './deployment.ts';
import { readCurrentInventory, inventoryGroups, type InventoryContext,
  type InventorySnapshot, type ProtectionRecord, type TrustedLaunch } from './joined-inventory.ts';
import { startNativePersistenceClient } from './native-persistence-client.ts';
import { runDeploymentPersistenceAttempt } from './persistence-deployment.ts';
import { hostDumpLocations, probeHost } from './host-probe.ts';
import { checkLocalTarget } from '../../infra/dev-stack/memory-qualification.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./bridge-proof.ts', { spy: true });
vi.mock('./deployment.ts', { spy: true });
vi.mock('./joined-inventory.ts', { spy: true });
vi.mock('./native-persistence-client.ts', { spy: true });
vi.mock('./host-probe.ts', { spy: true });
vi.mock('../../infra/dev-stack/memory-qualification.ts', { spy: true });

const serverId = 'a'.repeat(64);
const computerId = 'b'.repeat(64);
const serverImage = `sha256:${'c'.repeat(64)}`;
const computerImage = `sha256:${'d'.repeat(64)}`;
const computerGeneration = `sha256:${'e'.repeat(64)}`;
let directory: string;
type StorageFixture = { Id: string; Image: string; Mounts: Array<{
  Destination: string; Source: string; RW: boolean; Type: string;
}>; LogPath: string; GraphDriver: { Data: { UpperDir: string } } };
let storage: StorageFixture;
let toolCalls: string[];
let inventoryReads: number;

function matchingInventory(context: InventoryContext): InventorySnapshot & {
  records: ProtectionRecord[]; launches: TrustedLaunch[];
} {
  const records: ProtectionRecord[] = [];
  const launches: TrustedLaunch[] = [];
  for (const [index, group] of inventoryGroups.entries()) {
    const location = group === 'serverDelivery' || group === 'canaryHelper' ?
      'server' : 'computer';
    const helperId = group === 'canaryHelper' ? context.challengeId : undefined;
    const identity = { group, helperId, pid: index + 100,
      startTime: String(index + 1000), pidNamespace: 'pid:[4026531836]',
      executable: '/usr/local/bin/node', uid: 1000, cgroup: '0::/test\n',
      dumpable: false as const };
    launches.push({ ...identity, location });
    records.push({ ...identity, imageDigest: location === 'server' ?
      serverImage : computerImage, serverInstallationId: context.serverInstallationId,
      computerInstallationId: context.computerInstallationId,
      serverImageDigest: serverImage, computerImageDigest: computerImage,
      challengeId: context.challengeId, generationId: context.generationId,
      safe: true as const });
  }
  return { records, launches };
}

function fakeDocker(_file: unknown, args: unknown): string {
  const command = z.array(z.string()).parse(args);
  if (command[2] === 'inspect') {
    return JSON.stringify([storage]);
  }
  return '';
}

function fakeInventory(context: InventoryContext): InventorySnapshot {
  inventoryReads++;
  return matchingInventory(context);
}

function fakeNative() {
  return Promise.resolve({
    async assertHeld() {},
    attemptTool(tool: string) {
      toolCalls.push(tool);
      return Promise.resolve('blocked' as const);
    },
    stop() { return Promise.resolve(); },
  });
}

function heldHelper(...args: Parameters<typeof runCheck>): ReturnType<typeof runCheck> {
  const [_containerId, binding, name, challengeId] = args;
  const receipt = { ...binding, name, challengeId, observedAt: Date.now(),
    result: 'NOT RUN' as const, complete: false as const, digest: serverImage };
  return Promise.resolve(receipt);
}

function prepare(): void {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), 'persistence-caller-'));
  const home = join(directory, 'home');
  const cache = join(directory, 'cache');
  const upper = join(directory, 'upper');
  const logs = join(directory, 'logs');
  const dumps = join(directory, 'dumps');
  for (const path of [home, join(home, 'codex'), cache, upper, logs, dumps]) {
    mkdirSync(path, { recursive: true });
  }
  storage = { Id: computerId, Image: computerImage,
    Mounts: [
      { Destination: '/home/agent', Source: home, RW: true, Type: 'bind' },
      { Destination: '/home/codex', Source: cache, RW: true, Type: 'bind' },
    ], LogPath: join(logs, 'container.log'), GraphDriver: { Data: { UpperDir: upper } } };
  toolCalls = [];
  inventoryReads = 0;
  vi.mocked(execFileSync).mockImplementation(fakeDocker);
  vi.mocked(checkLocalTarget).mockResolvedValue({ target: {
    containerId: serverId, computerContainerId: computerId, siloId: 'fixture-silo',
  }, savedTarget: 'fixture-target' });
  vi.mocked(deploymentTarget).mockReturnValue({ containerId: serverId,
    computerContainerId: computerId, siloId: 'fixture-silo' });
  vi.mocked(probeHost).mockReturnValue(true);
  vi.mocked(hostDumpLocations).mockReturnValue([dumps]);
  vi.mocked(measure).mockReturnValue({ sourceSha: 'f'.repeat(40),
    imageDigest: serverImage, environmentId: '1'.repeat(64),
    siloId: hash('fixture-silo'), installationId: 'sha256:fixture',
    created: '2026-01-01T00:00:00Z' });
  vi.mocked(assertFresh).mockResolvedValue('2026-01-01T00:00:01Z');
  vi.mocked(assertInstallation).mockResolvedValue(undefined);
  vi.mocked(containerIdentity).mockReturnValue({ Id: computerId, Image: computerImage,
    State: { Running: true, StartedAt: '2026-01-01T00:00:02Z', Pid: 1234 } });
  vi.mocked(computerInstallation).mockReturnValue(computerGeneration);
  vi.mocked(readCurrentInventory).mockImplementation(fakeInventory);
  vi.mocked(startNativePersistenceClient).mockImplementation(fakeNative);
  vi.mocked(runCheck).mockImplementation(heldHelper);
}
beforeEach(prepare);
afterEach(function clean(): void {
  rmSync(directory, { recursive: true, force: true });
});

async function cleanAttemptIsIncomplete(): Promise<void> {
  const result = await runDeploymentPersistenceAttempt();
  expect(result).toEqual({ result: 'PARTIAL', complete: false });
  expect(toolCalls).toHaveLength(8);
  expect(inventoryReads).toBe(2);
}
it('never qualifies a fixture attempt as PASS', cleanAttemptIsIncomplete);

async function refusesChangedComputerImage(): Promise<void> {
  storage.Image = serverImage;
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(startNativePersistenceClient).not.toHaveBeenCalled();
  expect(toolCalls).toEqual([]);
}
it('refuses a changed computer image before private input', refusesChangedComputerImage);

async function refusesMissingHomeVolume(): Promise<void> {
  storage.Mounts = [];
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(startNativePersistenceClient).not.toHaveBeenCalled();
}
it('refuses a missing measured volume before private input', refusesMissingHomeVolume);

async function refusesWrongStoreLocation(): Promise<void> {
  storage.Mounts[1]!.Source = join(directory, 'missing-cache');
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'NOT RUN', complete: false, category: 'cache',
  });
  expect(startNativePersistenceClient).not.toHaveBeenCalled();
}
it('refuses a measured store that cannot be read before native launch',
  refusesWrongStoreLocation);

async function refusesForeignProcessBeforeCanary(): Promise<void> {
  function foreignProcess(context: InventoryContext): InventorySnapshot {
    const snapshot = matchingInventory(context);
    snapshot.records[4]!.imageDigest = serverImage;
    return snapshot;
  }
  vi.mocked(readCurrentInventory).mockImplementation(foreignProcess);
  expect(await runDeploymentPersistenceAttempt()).toMatchObject({
    result: 'FAIL', complete: false, group: 'nativeWrapper',
  });
  expect(toolCalls).toEqual([]);
}
it('refuses a foreign native process before sending the canary',
  refusesForeignProcessBeforeCanary);

async function refusesProcessReplacementBetweenReads(): Promise<void> {
  function replacedProcess(context: InventoryContext): InventorySnapshot {
    inventoryReads++;
    const snapshot = matchingInventory(context);
    if (inventoryReads === 2) {
      snapshot.records[5]!.pid = 999;
      snapshot.launches[5]!.pid = 999;
    }
    return snapshot;
  }
  vi.mocked(readCurrentInventory).mockImplementation(replacedProcess);
  expect(await runDeploymentPersistenceAttempt()).toMatchObject({
    result: 'FAIL', complete: false, group: 'nativeChild',
  });
  expect(toolCalls).toHaveLength(8);
}
it('refuses a replaced native process at the second live read',
  refusesProcessReplacementBetweenReads);

async function refusesChangedComputerGeneration(): Promise<void> {
  vi.mocked(computerInstallation).mockReturnValueOnce(computerGeneration);
  vi.mocked(computerInstallation).mockReturnValue(`sha256:${'f'.repeat(64)}`);
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(startNativePersistenceClient).not.toHaveBeenCalled();
}
it('refuses a changed computer generation before native launch',
  refusesChangedComputerGeneration);

async function refusesComputerChangedAtLaunch(): Promise<void> {
  vi.mocked(computerInstallation).mockReturnValueOnce(computerGeneration);
  vi.mocked(computerInstallation).mockReturnValueOnce(computerGeneration);
  vi.mocked(computerInstallation).mockReturnValueOnce(computerGeneration);
  vi.mocked(computerInstallation).mockReturnValue(`sha256:${'f'.repeat(64)}`);
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(startNativePersistenceClient).not.toHaveBeenCalled();
}
it('rechecks the computer installation after the final slot check and before native launch',
  refusesComputerChangedAtLaunch);

async function stopsAfterCancelledPendingReply(): Promise<void> {
  const controller = new AbortController();
  let started = false;
  let stopped = false;
  function pendingNative() {
    return Promise.resolve({
      async assertHeld() {},
      attemptTool() {
        started = true;
        controller.abort();
        return new Promise<'blocked'>(function pending() {});
      },
      stop() {
        stopped = true;
        return Promise.resolve();
      },
    });
  }
  vi.mocked(startNativePersistenceClient).mockImplementation(pendingNative);
  expect(await runDeploymentPersistenceAttempt(controller.signal)).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(started).toBe(true);
  expect(stopped).toBe(true);
}
it('stops a held native turn when cancellation arrives during its tool reply',
  stopsAfterCancelledPendingReply);

async function keepsToolWriteAfterHelperLoss(): Promise<void> {
  function writingNative() {
    return Promise.resolve({
      async assertHeld() {},
      attemptTool(tool: string) {
        toolCalls.push(tool);
        return Promise.resolve('wrote' as const);
      },
      stop() { return Promise.resolve(); },
    });
  }
  vi.mocked(startNativePersistenceClient).mockImplementation(writingNative);
  vi.mocked(runCheck).mockRejectedValue(new Error('private helper output'));
  expect(await runDeploymentPersistenceAttempt()).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
  expect(toolCalls).toEqual(['shell']);
}
it('keeps the first native tool write when the helper loses its reply',
  keepsToolWriteAfterHelperLoss);
