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
const generation = '33333333-3333-4333-8333-333333333333';
const otherGeneration = '44444444-4444-4444-8444-444444444444';

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
  change: Partial<ProtectionRecord>): ProtectionRecord[] {
  const replacement = records.map(function changeGroup(item): ProtectionRecord {
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

function refusesFinalFault(fault: Partial<ProtectionRecord>): void {
  const first = completeInventory();
  const final = replace(first, 'bridge', fault);
  expect(joinInventory(context, first, final)).toEqual({ ok: false, group: 'bridge' });
}
it.each([{ safe: false }, { pid: 0 }, { startTime: '' }])(
  'refuses a group that becomes unsafe or unreadable at the final read', refusesFinalFault,
);
