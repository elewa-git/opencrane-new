import { expect, it } from 'vitest';
import {
  inventoryGroups, joinInventory as joinObservedInventory, readCurrentInventory,
  type InventoryContext, type ProtectionRecord, type TrustedLaunch,
} from './joined-inventory.ts';

const image = `sha256:${'a'.repeat(64)}`;
const otherImage = `sha256:${'b'.repeat(64)}`;
const installation = `sha256:${'c'.repeat(64)}`;
const otherInstallation = `sha256:${'d'.repeat(64)}`;
const challenge = '11111111-1111-4111-8111-111111111111';
const otherChallenge = '22222222-2222-4222-8222-222222222222';
const generation = `sha256:${'e'.repeat(64)}`;
const otherGeneration = `sha256:${'f'.repeat(64)}`;

const context: InventoryContext = {
  serverInstallationId: installation,
  computerInstallationId: otherInstallation,
  serverImageDigest: image,
  computerImageDigest: otherImage,
  challengeId: challenge,
  generationId: generation,
  helperIds: [challenge, otherChallenge],
};

function record(group: ProtectionRecord['group'], index: number,
  helperId?: string): ProtectionRecord {
  const imageDigest = group === 'serverDelivery' || group === 'canaryHelper' ? image : otherImage;
  return {
    group, helperId, serverInstallationId: installation,
    computerInstallationId: otherInstallation, serverImageDigest: image,
    computerImageDigest: otherImage, imageDigest, challengeId: challenge,
    generationId: generation, pid: 100 + index, startTime: String(1000 + index),
    pidNamespace: 'pid:[4026531836]', dumpable: false, safe: true,
  };
}

function measuredLaunch(item: ProtectionRecord): TrustedLaunch {
  const location = item.group === 'serverDelivery' || item.group === 'canaryHelper' ?
    'server' : 'computer';
  return { group: item.group, helperId: item.helperId, location,
    pid: item.pid, startTime: item.startTime, pidNamespace: item.pidNamespace,
    dumpable: false };
}

function snapshotFromRecords(records: ProtectionRecord[]): {
  records: ProtectionRecord[]; launches: TrustedLaunch[];
} {
  const launches = records.map(measuredLaunch);
  return { records, launches };
}

function joinInventory(inventoryContext: unknown, first: unknown,
  final: unknown): ReturnType<typeof joinObservedInventory> {
  const trustedLaunches = completeInventory().map(measuredLaunch);
  const firstSnapshot = { records: first, launches: trustedLaunches };
  const finalSnapshot = { records: final, launches: trustedLaunches };
  return joinObservedInventory(inventoryContext, firstSnapshot, finalSnapshot);
}

function completeInventory(): ProtectionRecord[] {
  const records: ProtectionRecord[] = [];
  for (const [index, group] of inventoryGroups.entries()) {
    if (group === 'canaryHelper') {
      records.push(record(group, index, challenge));
      records.push(record(group, index + 1, otherChallenge));
    } else {
      records.push(record(group, index));
    }
  }
  return records;
}

function replace(records: ProtectionRecord[], group: ProtectionRecord['group'],
  change: Record<string, unknown>): Record<string, unknown>[] {
  const replacement = records.map(function changeGroup(item): Record<string, unknown> {
    if (item.group === group) {
      return { ...item, ...change };
    }
    return item;
  });
  return replacement;
}

function acceptsOneCompleteInventory(): void {
  const first = completeInventory();
  const final = completeInventory();
  expect(joinInventory(context, first, final)).toEqual({ ok: true });
}
it('accepts one current matching inventory for the next check', acceptsOneCompleteInventory);

function refusesMissingAndDuplicate(group: ProtectionRecord['group']): void {
  const first = completeInventory();
  const missing = first.filter(function keepOther(item): boolean {
    return item.group !== group;
  });
  expect(joinInventory(context, missing, first)).toEqual({ ok: false, group });
  const duplicate = [...first, first.find(function hasGroup(item): boolean {
    return item.group === group;
  })!];
  expect(joinInventory(context, duplicate, first)).toEqual({ ok: false, group });
}
it.each(inventoryGroups)('refuses missing or duplicate %s records', refusesMissingAndDuplicate);

function refusesForeign(field: keyof ProtectionRecord, value: string): void {
  const first = completeInventory();
  const mixed = replace(first, 'proxy', { [field]: value });
  expect(joinInventory(context, mixed, first)).toEqual({ ok: false, group: 'proxy' });
}
it.each([
  ['serverInstallationId', otherInstallation],
  ['computerInstallationId', installation],
  ['serverImageDigest', otherImage],
  ['computerImageDigest', image],
  ['challengeId', otherChallenge],
  ['generationId', otherGeneration],
] as const)('refuses a mixed %s', refusesForeign);

function refusesReplacement(): void {
  const first = completeInventory();
  const final = replace(first, 'nativeChild', { startTime: '9999' });
  expect(joinInventory(context, first, final)).toEqual({ ok: false, group: 'nativeChild' });
}
it('refuses a process replaced between reads', refusesReplacement);

function refusesLostHelper(): void {
  const first = completeInventory();
  const final = first.filter(function keepOtherHelper(item): boolean {
    return item.helperId !== otherChallenge;
  });
  expect(joinInventory(context, first, final)).toEqual({ ok: false, group: 'canaryHelper' });
}
it('refuses a helper lost after the journey', refusesLostHelper);

function refusesFinalFault(fault: Record<string, unknown>): void {
  const first = completeInventory();
  const final = replace(first, 'bridge', fault);
  expect(joinInventory(context, first, final)).toEqual({ ok: false, group: 'bridge' });
}
it.each([{ safe: false }, { pid: 0 }, { startTime: '' }])(
  'refuses a group that becomes unsafe or unreadable at the final read', refusesFinalFault,
);

function refusesCopiedHelperProcess(): void {
  const first = completeInventory();
  const copied = first.find(function isFirstHelper(item): boolean {
    return item.helperId === challenge;
  })!;
  const duplicateProcess = first.map(function copyHelper(item): ProtectionRecord {
    if (item.helperId === otherChallenge) {
      return { ...item, pid: copied.pid, startTime: copied.startTime };
    }
    return item;
  });
  const copiedSnapshot = snapshotFromRecords(duplicateProcess);
  expect(joinObservedInventory(context, copiedSnapshot, copiedSnapshot)).toEqual({
    ok: false, group: 'canaryHelper',
  });
}
it('refuses two helper labels for the same PID and start time', refusesCopiedHelperProcess);

function acceptsCanaryInServerImage(): void {
  const actual = completeInventory();
  expect(joinInventory(context, actual, actual)).toEqual({ ok: true });
}
it('requires the server image for the canary launched inside the server',
  acceptsCanaryInServerImage);

function refusesRelabelledCanaryImage(): void {
  const first = completeInventory();
  const relabelled = replace(first, 'canaryHelper', { imageDigest: otherImage });
  expect(joinInventory(context, relabelled, relabelled)).toEqual({
    ok: false, group: 'canaryHelper',
  });
}
it('refuses a canary relabelled with the computer image', refusesRelabelledCanaryImage);

function refusesIndependentRequiredGroup(group: ProtectionRecord['group']): void {
  const first = completeInventory();
  const missing = first.filter(function keepOther(item): boolean {
    return item.group !== group;
  });
  expect(joinInventory(context, missing, first)).toEqual({ ok: false, group });
}
it.each(['serverDelivery', 'supervisor', 'nativeWrapper'] as const)(
  'requires %s independently of the catalogue fixture', refusesIndependentRequiredGroup,
);

function refusesRecordWithoutMeasuredLaunch(): void {
  const records = completeInventory();
  const launches = records.map(function measuredLaunch(item): Record<string, unknown> {
    const location = item.group === 'serverDelivery' || item.group === 'canaryHelper' ?
      'server' : 'computer';
    return { group: item.group, helperId: item.helperId, location,
      pid: item.pid, startTime: item.startTime, pidNamespace: 'pid:[4026531836]',
      dumpable: false };
  });
  const observedRecords = records.map(function observedRecord(item): Record<string, unknown> {
    return { ...item, pidNamespace: 'pid:[4026531836]', dumpable: false };
  });
  const missingLaunches = launches.filter(function keepOther(item): boolean {
    return item['group'] !== 'nativeChild';
  });
  const snapshot = { records: observedRecords, launches: missingLaunches };
  expect(joinObservedInventory(context, snapshot, snapshot)).toEqual({
    ok: false, group: 'nativeChild',
  });
}
it('refuses a process record without its measured launch', refusesRecordWithoutMeasuredLaunch);

function refusesInvalidContext(change: Record<string, unknown>, group: string): void {
  const first = completeInventory();
  const altered = { ...context, ...change };
  expect(joinInventory(altered, first, first)).toEqual({ ok: false, group });
}
it.each([
  [{ serverInstallationId: undefined }, 'inventory'],
  [{ computerImageDigest: 'wrong' }, 'inventory'],
  [{ challengeId: 'wrong' }, 'inventory'],
  [{ helperIds: [] }, 'inventory'],
  [{ helperIds: [challenge, challenge] }, 'canaryHelper'],
  [{ extra: 'untrusted' }, 'inventory'],
] as const)('refuses invalid inventory context %j', refusesInvalidContext);

function refusesInvalidRecord(change: Record<string, unknown>, group: string): void {
  const first = completeInventory();
  const changed = replace(first, 'nativeWrapper', change);
  expect(joinInventory(context, changed, first)).toEqual({ ok: false, group });
}
it.each([
  [{ imageDigest: image }, 'nativeWrapper'],
  [{ imageDigest: undefined }, 'nativeWrapper'],
  [{ imageDigest: 'wrong' }, 'nativeWrapper'],
  [{ pid: undefined }, 'nativeWrapper'],
  [{ pid: -1 }, 'nativeWrapper'],
  [{ pid: 1.5 }, 'nativeWrapper'],
  [{ startTime: undefined }, 'nativeWrapper'],
  [{ startTime: '01' }, 'nativeWrapper'],
  [{ pidNamespace: undefined }, 'nativeWrapper'],
  [{ pidNamespace: 'pid:[1]' }, 'nativeWrapper'],
  [{ dumpable: true }, 'nativeWrapper'],
  [{ safe: undefined }, 'nativeWrapper'],
  [{ helperId: challenge }, 'nativeWrapper'],
  [{ extra: 'untrusted' }, 'nativeWrapper'],
  [{ group: 'unknown' }, 'inventory'],
] as const)('refuses malformed or foreign process record %j', refusesInvalidRecord);

function refusesMissingHelperId(): void {
  const first = completeInventory();
  const changed = replace(first, 'canaryHelper', { helperId: undefined });
  expect(joinInventory(context, changed, first)).toEqual({ ok: false, group: 'canaryHelper' });
}
it('refuses a helper without its challenge ID', refusesMissingHelperId);

function refusesUnexpectedHelperId(): void {
  const first = completeInventory();
  const changed = replace(first, 'canaryHelper', { helperId: otherGeneration });
  expect(joinInventory(context, changed, first)).toEqual({ ok: false, group: 'canaryHelper' });
}
it('refuses a helper outside the expected challenge set', refusesUnexpectedHelperId);

function refusesNonArraySnapshot(): void {
  const first = completeInventory();
  expect(joinObservedInventory(context, { records: {}, launches: [] }, first)).toEqual({
    ok: false, group: 'inventory',
  });
}
it('refuses inventory records that are not an array', refusesNonArraySnapshot);

function refusesChangedIdentity(field: 'pid' | 'startTime' | 'pidNamespace',
  value: number | string): void {
  const first = completeInventory();
  const changed = first.map(function changeChild(item): ProtectionRecord {
    if (item.group === 'nativeChild') {
      return { ...item, [field]: value };
    }
    return item;
  });
  const firstSnapshot = snapshotFromRecords(first);
  const finalSnapshot = snapshotFromRecords(changed);
  expect(joinObservedInventory(context, firstSnapshot, finalSnapshot)).toEqual({
    ok: false, group: 'nativeChild',
  });
}
it.each([
  ['pid', 999],
  ['startTime', '9999'],
  ['pidNamespace', 'pid:[4026531838]'],
] as const)('refuses a process with changed %s even when the final launch agrees',
  refusesChangedIdentity);

function refusesLostFinalGroup(): void {
  const first = completeInventory();
  const final = first.filter(function keepOther(item): boolean {
    return item.group !== 'nativeWrapper';
  });
  expect(joinInventory(context, first, final)).toEqual({
    ok: false, group: 'nativeWrapper',
  });
}
it('refuses a missing non-helper group at the final read', refusesLostFinalGroup);

function refusesChangedLaunchObservation(change: Record<string, unknown>): void {
  const records = completeInventory();
  const launches = records.map(measuredLaunch);
  const changed = launches.map(function changeLaunch(item): Record<string, unknown> {
    if (item.group === 'nativeWrapper') {
      return { ...item, ...change };
    }
    return item;
  });
  const first = { records, launches: changed };
  expect(joinObservedInventory(context, first, first)).toEqual({
    ok: false, group: 'nativeWrapper',
  });
}
it.each([
  { pid: 999 },
  { startTime: '9999' },
  { pidNamespace: 'pid:[4026531838]' },
  { dumpable: true },
  { location: 'server' },
])('refuses a record that differs from its measured launch %j',
  refusesChangedLaunchObservation);

function realReaderRefuses(): void {
  const current = readCurrentInventory(context);
  expect(current).toEqual({ records: [], launches: [] });
  expect(joinObservedInventory(context, current, current)).toEqual({
    ok: false, group: 'serverDelivery',
  });
}
it('keeps the production reader closed until it measures a live set', realReaderRefuses);
