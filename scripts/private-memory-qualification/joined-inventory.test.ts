import { expect, it } from 'vitest';
import {
  inventoryGroups, joinInventory, type InventoryContext, type ProtectionRecord,
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
  const imageDigest = group === 'serverDelivery' ? image : otherImage;
  return {
    group, helperId, serverInstallationId: installation,
    computerInstallationId: otherInstallation, serverImageDigest: image,
    computerImageDigest: otherImage, imageDigest, challengeId: challenge,
    generationId: generation, pid: 100 + index, startTime: String(1000 + index),
    safe: true,
  };
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
  expect(joinInventory(context, duplicateProcess, duplicateProcess)).toEqual({
    ok: false, group: 'canaryHelper',
  });
}
it('refuses two helper labels for the same PID and start time', refusesCopiedHelperProcess);

function acceptsCanaryInServerImage(): void {
  const first = completeInventory();
  const actual = replace(first, 'canaryHelper', { imageDigest: image });
  expect(joinInventory(context, actual, actual)).toEqual({ ok: true });
}
it('requires the server image for the canary launched inside the server',
  acceptsCanaryInServerImage);

function refusesRelabelledCanaryImage(): void {
  const first = completeInventory();
  expect(joinInventory(context, first, first)).toEqual({
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
  expect(joinInventory(context, snapshot, snapshot)).toEqual({
    ok: false, group: 'nativeChild',
  });
}
it('refuses a process record without its measured launch', refusesRecordWithoutMeasuredLaunch);
