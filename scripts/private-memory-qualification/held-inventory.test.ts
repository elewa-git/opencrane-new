import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { runInContainer } from './container-process.ts';
import { collectHeldInventory, InventoryRefusal } from './held-inventory.ts';
import {
  inventoryGroups, readCurrentInventory, type InventoryContext,
  type InventorySnapshot, type ProtectionRecord, type TrustedLaunch,
} from './joined-inventory.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./container-process.ts', { spy: true });
vi.mock('./joined-inventory.ts', { spy: true });

const challenge = '11111111-1111-4111-8111-111111111111';
const context: InventoryContext = {
  serverInstallationId: `sha256:${'a'.repeat(64)}`,
  computerInstallationId: `sha256:${'b'.repeat(64)}`,
  serverImageDigest: `sha256:${'c'.repeat(64)}`,
  computerImageDigest: `sha256:${'d'.repeat(64)}`,
  challengeId: challenge,
  generationId: `sha256:${'e'.repeat(64)}`,
  helperIds: [challenge],
};
const containers = { serverId: 'a'.repeat(64), computerId: 'b'.repeat(64) };

function complete(): FixtureSnapshot {
  const records: ProtectionRecord[] = [];
  const launches: TrustedLaunch[] = [];
  for (const [index, group] of inventoryGroups.entries()) {
    const location = group === 'serverDelivery' || group === 'canaryHelper' ?
      'server' : 'computer';
    const process = { pid: index + 100, startTime: String(index + 1000),
      pidNamespace: 'pid:[4026531836]', executable: '/usr/local/bin/node',
      uid: 1000, cgroup: '0::/test\n', dumpable: false as const };
    const helperId = group === 'canaryHelper' ? challenge : undefined;
    const imageDigest = location === 'server' ? context.serverImageDigest :
      context.computerImageDigest;
    records.push({ ...process, group, helperId, imageDigest, safe: true,
      serverInstallationId: context.serverInstallationId,
      computerInstallationId: context.computerInstallationId,
      serverImageDigest: context.serverImageDigest,
      computerImageDigest: context.computerImageDigest,
      challengeId: challenge, generationId: context.generationId });
    launches.push({ ...process, group, helperId, location });
  }
  return { records, launches };
}

type FixtureSnapshot = { records: ProtectionRecord[]; launches: TrustedLaunch[] };
let snapshots: FixtureSnapshot[];
let reads: number;
let workFinished: boolean;
let bindingChecks: number;
let failBindingAt: number | undefined;

function verifyBinding(): Promise<void> {
  bindingChecks += 1;
  if (bindingChecks === failBindingAt) {
    return Promise.reject(new Error('installation_replaced'));
  }
  return Promise.resolve();
}

function fakeReader(): InventorySnapshot {
  const snapshot = snapshots[reads];
  reads += 1;
  if (!snapshot) {
    throw new Error('unreadable_inventory');
  }
  return snapshot;
}

function fakeControl(_binary: unknown, argumentsInput: unknown): string {
  const args = z.array(z.string()).parse(argumentsInput);
  const operation = args.find(function isOperation(value): boolean {
    return value === 'stage' || value === 'release' || value === 'releaseNative' ||
      value === 'nativeReady';
  });
  if (operation === 'stage') {
    return JSON.stringify(reads === 0 ? 'ready' : 'workDone');
  }
  return 'true';
}

function fakeContainer(): Promise<unknown> {
  return Promise.resolve({ result: 'PARTIAL', complete: false,
    challengeId: challenge, imageDigest: context.computerImageDigest,
    installationId: context.computerInstallationId });
}

function work(): Promise<string> {
  workFinished = true;
  return Promise.resolve('receipt');
}

beforeEach(function prepare(): void {
  snapshots = [complete(), complete()];
  reads = 0;
  workFinished = false;
  bindingChecks = 0;
  failBindingAt = undefined;
  vi.mocked(readCurrentInventory).mockImplementation(fakeReader);
  vi.mocked(execFileSync).mockImplementation(fakeControl);
  vi.mocked(runInContainer).mockImplementation(fakeContainer);
});

async function acceptsHeldSet(): Promise<void> {
  const receipt = await collectHeldInventory(context, containers, work, verifyBinding);
  expect(receipt).toBe('receipt');
  expect(reads).toBe(2);
  expect(bindingChecks).toBe(2);
}
it('returns a receipt only after both complete held reads', acceptsHeldSet);

async function refusesChangedInstallation(checkNumber: number): Promise<void> {
  failBindingAt = checkNumber;
  await expect(collectHeldInventory(context, containers, work, verifyBinding))
    .rejects.toThrow('collection_failed');
  expect(bindingChecks).toBe(checkNumber);
}
it.each([1, 2])('refuses an installation replaced at recheck %i',
  refusesChangedInstallation);

async function readsBothSnapshotsFromBoundContainers(): Promise<void> {
  await collectHeldInventory(context, containers, work, verifyBinding);
  const calls = vi.mocked(readCurrentInventory).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[0]?.[1]).toEqual(containers);
  expect(calls[1]?.[1]).toEqual(containers);
}
it('uses the original server and computer container IDs for the final read',
  readsBothSnapshotsFromBoundContainers);

async function refusesMissing(group: ProtectionRecord['group'], phase: number): Promise<void> {
  const snapshot = snapshots[phase]!;
  snapshot.records = snapshot.records.filter(
    function other(record): boolean { return record.group !== group; });
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal(group));
  expect(workFinished).toBe(true);
}
it.each(['nativeWrapper', 'nativeChild', 'canaryHelper'] as const)(
  'refuses missing %s on the first read', function first(group) { return refusesMissing(group, 0); });
it.each(['nativeWrapper', 'nativeChild', 'canaryHelper'] as const)(
  'refuses missing %s on the final read', function final(group) { return refusesMissing(group, 1); });

async function refusesDuplicate(group: ProtectionRecord['group']): Promise<void> {
  const snapshot = snapshots[0]!;
  const records = snapshot.records;
  const original = records.find(function matches(record): boolean { return record.group === group; });
  records.push(original!);
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal(group));
}
it.each(['nativeWrapper', 'nativeChild', 'canaryHelper'] as const)(
  'refuses duplicate %s before a receipt', refusesDuplicate);

async function refusesReplaced(group: ProtectionRecord['group']): Promise<void> {
  const snapshot = snapshots[1]!;
  const records = snapshot.records;
  const record = records.find(function matches(item): boolean { return item.group === group; });
  record!.executable = '/usr/bin/other';
  const launches = snapshot.launches;
  const launch = launches.find(function matches(item): boolean { return item.group === group; });
  launch!.executable = '/usr/bin/other';
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal(group));
}
it.each(['nativeWrapper', 'nativeChild', 'canaryHelper'] as const)(
  'refuses changed executable for %s at the final read', refusesReplaced);

async function refusesChangedImage(): Promise<void> {
  const record = snapshots[1]!.records.find(function isHelper(item): boolean {
    return item.group === 'canaryHelper';
  })!;
  record.imageDigest = context.computerImageDigest;
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal('canaryHelper'));
}
it('refuses a process image changed only at the final read', refusesChangedImage);

async function refusesRelabelled(group: ProtectionRecord['group']): Promise<void> {
  const snapshot = snapshots[0]!;
  const record = snapshot.records.find(function matches(item): boolean {
    return item.group === group;
  })!;
  record.group = 'proxy';
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toBeInstanceOf(
    InventoryRefusal);
}
it.each(['nativeWrapper', 'nativeChild', 'canaryHelper'] as const)(
  'refuses relabelled %s before a receipt', refusesRelabelled);

async function refusesEndedHelper(): Promise<void> {
  await refusesMissing('canaryHelper', 1);
}
it('refuses when the helper ends during held work', refusesEndedHelper);

async function refusesChangedContainer(): Promise<void> {
  vi.mocked(readCurrentInventory).mockImplementation(function replacedContainer(): InventorySnapshot {
    if (reads++ === 0) {
      return snapshots[0]!;
    }
    throw new Error('private process path and memory text');
  });
  try {
    await collectHeldInventory(context, containers, work, verifyBinding);
    expect.fail('changed container must refuse');
  } catch (error) {
    expect(String(error)).toBe('Error: collection_failed');
  }
}
it('refuses a replaced container on the final read', refusesChangedContainer);

async function refusesCopiedHelper(): Promise<void> {
  const secondId = '22222222-2222-4222-8222-222222222222';
  const copyContext = { ...context, helperIds: [challenge, secondId] };
  for (const snapshot of snapshots) {
    const records = snapshot.records;
    const launches = snapshot.launches;
    const helper = records.find(function isHelper(item): boolean {
      return item.group === 'canaryHelper';
    })!;
    const launch = launches.find(function isHelper(item): boolean {
      return item.group === 'canaryHelper';
    })!;
    records.push({ ...helper, helperId: secondId });
    launches.push({ ...launch, helperId: secondId });
  }
  await expect(collectHeldInventory(copyContext, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal('canaryHelper'));
}
it('refuses a copied helper record under a second name', refusesCopiedHelper);

async function refusesCopiedWorkerResult(): Promise<void> {
  vi.mocked(runInContainer).mockResolvedValue({ result: 'PARTIAL', complete: false,
    challengeId: '22222222-2222-4222-8222-222222222222',
    imageDigest: context.computerImageDigest,
    installationId: context.computerInstallationId });
  await expect(collectHeldInventory(context, containers, work, verifyBinding)).rejects.toEqual(
    new InventoryRefusal('nativeWrapper'));
}
it('refuses a native success record copied from another challenge', refusesCopiedWorkerResult);
