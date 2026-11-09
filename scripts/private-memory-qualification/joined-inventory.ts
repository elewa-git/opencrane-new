import { z } from 'zod';

export const inventoryGroups = [
  'serverDelivery', 'bridge', 'supervisor', 'proxy', 'nativeWrapper',
  'nativeChild', 'canaryHelper',
] as const;

type InventoryGroup = typeof inventoryGroups[number];
export type InventoryCode = InventoryGroup | 'inventory';

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const challenge = z.uuid();
const contextSchema = z.strictObject({
  serverInstallationId: digest,
  computerInstallationId: digest,
  serverImageDigest: digest,
  computerImageDigest: digest,
  challengeId: challenge,
  generationId: digest,
  helperIds: z.array(challenge).min(1),
});
const recordSchema = contextSchema.omit({ helperIds: true }).extend({
  group: z.enum(inventoryGroups),
  helperId: challenge.optional(),
  imageDigest: digest,
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^[1-9][0-9]*$/u),
  safe: z.literal(true),
});

export type InventoryContext = z.infer<typeof contextSchema>;
export type ProtectionRecord = z.input<typeof recordSchema>;
type CheckedRecord = z.output<typeof recordSchema>;
type JoinResult = { ok: true } | { ok: false; group: InventoryCode };

function failure(group: InventoryCode): JoinResult {
  return { ok: false, group };
}

function recordCode(value: unknown): InventoryCode {
  if (value !== null && typeof value === 'object' && 'group' in value) {
    const group = value.group;
    for (const candidate of inventoryGroups) {
      if (candidate === group) {
        return candidate;
      }
    }
  }
  return 'inventory';
}

function matchesContext(context: InventoryContext, record: CheckedRecord): boolean {
  const expectedImage = record.group === 'serverDelivery' ?
    context.serverImageDigest : context.computerImageDigest;
  return record.serverInstallationId === context.serverInstallationId &&
    record.computerInstallationId === context.computerInstallationId &&
    record.serverImageDigest === context.serverImageDigest &&
    record.computerImageDigest === context.computerImageDigest &&
    record.imageDigest === expectedImage &&
    record.challengeId === context.challengeId &&
    record.generationId === context.generationId;
}

function recordKey(record: CheckedRecord): string {
  if (record.group === 'canaryHelper') {
    return `canaryHelper:${record.helperId}`;
  }
  return record.group;
}

function expectedKeys(context: InventoryContext): Map<string, InventoryGroup> {
  const expected = new Map<string, InventoryGroup>();
  for (const group of inventoryGroups) {
    if (group === 'canaryHelper') {
      for (const helperId of context.helperIds) {
        expected.set(`canaryHelper:${helperId}`, group);
      }
    } else {
      expected.set(group, group);
    }
  }
  return expected;
}

function checkedSnapshot(context: InventoryContext, input: unknown):
  Map<string, CheckedRecord> | JoinResult {
  if (!Array.isArray(input)) {
    return failure('inventory');
  }
  const expected = expectedKeys(context);
  const checked = new Map<string, CheckedRecord>();
  for (const value of input) {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) {
      return failure(recordCode(value));
    }
    const record = parsed.data;
    const key = recordKey(record);
    if (!matchesContext(context, record) || !expected.has(key) || checked.has(key)) {
      return failure(record.group);
    }
    if (record.group === 'canaryHelper' && record.helperId === undefined) {
      return failure(record.group);
    }
    if (record.group !== 'canaryHelper' && record.helperId !== undefined) {
      return failure(record.group);
    }
    checked.set(key, record);
  }
  for (const [key, group] of expected) {
    if (!checked.has(key)) {
      return failure(group);
    }
  }
  return checked;
}

function isFailure(value: Map<string, CheckedRecord> | JoinResult): value is JoinResult {
  return !(value instanceof Map);
}

function sameProcess(first: CheckedRecord, final: CheckedRecord): boolean {
  return first.pid === final.pid && first.startTime === final.startTime;
}

  // Compare every required group twice. A PASS can only follow the second live read.
export function joinInventory(contextInput: unknown, firstInput: unknown,
  finalInput: unknown): JoinResult {
  const contextResult = contextSchema.safeParse(contextInput);
  if (!contextResult.success) {
    return failure('inventory');
  }
  const context = contextResult.data;
  if (new Set(context.helperIds).size !== context.helperIds.length) {
    return failure('canaryHelper');
  }
  const first = checkedSnapshot(context, firstInput);
  if (isFailure(first)) {
    return first;
  }
  const final = checkedSnapshot(context, finalInput);
  if (isFailure(final)) {
    return final;
  }
  for (const [key, firstRecord] of first) {
    const finalRecord = final.get(key);
    if (!finalRecord || !sameProcess(firstRecord, finalRecord)) {
      return failure(firstRecord.group);
    }
  }
  return { ok: true };
}

// Existing live checks do not yet supply a simultaneous record for all groups.
// Keep collection closed until the held journey can provide those records.
export function readCurrentInventory(_context: InventoryContext): unknown {
  return [];
}
