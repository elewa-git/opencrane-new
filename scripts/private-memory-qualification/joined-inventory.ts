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
const processIdentity = {
  pid: z.number().int().positive(),
  startTime: z.string().regex(/^[1-9][0-9]*$/u),
  pidNamespace: z.string().regex(/^pid:\[[1-9][0-9]*\]$/u),
};
const launchSchema = z.strictObject({
  group: z.enum(inventoryGroups),
  helperId: challenge.optional(),
  location: z.enum(['server', 'computer']),
  ...processIdentity,
  dumpable: z.literal(false),
});
const recordSchema = contextSchema.omit({ helperIds: true }).extend({
  group: z.enum(inventoryGroups),
  helperId: challenge.optional(),
  imageDigest: digest,
  ...processIdentity,
  dumpable: z.literal(false),
  safe: z.literal(true),
});

export type InventoryContext = z.infer<typeof contextSchema>;
export type ProtectionRecord = z.input<typeof recordSchema>;
export type TrustedLaunch = z.input<typeof launchSchema>;
export type InventorySnapshot = { records: unknown; launches: unknown };
type CheckedRecord = z.output<typeof recordSchema>;
type CheckedLaunch = z.output<typeof launchSchema>;
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

function expectedLocation(group: InventoryGroup): 'server' | 'computer' {
  // The canary is launched by the journey in the server container.
  if (group === 'serverDelivery' || group === 'canaryHelper') {
    return 'server';
  }
  return 'computer';
}

function matchesContext(context: InventoryContext, record: CheckedRecord,
  launch: CheckedLaunch): boolean {
  const expectedImage = launch.location === 'server' ?
    context.serverImageDigest : context.computerImageDigest;
  return record.serverInstallationId === context.serverInstallationId &&
    record.computerInstallationId === context.computerInstallationId &&
    record.serverImageDigest === context.serverImageDigest &&
    record.computerImageDigest === context.computerImageDigest &&
    record.imageDigest === expectedImage &&
    record.challengeId === context.challengeId &&
    record.generationId === context.generationId;
}

function recordKey(record: { group: InventoryGroup; helperId?: string | undefined }): string {
  if (record.group === 'canaryHelper') {
    return `canaryHelper:${record.helperId}`;
  }
  return record.group;
}

function validHelperId(record: { group: InventoryGroup; helperId?: string | undefined }): boolean {
  if (record.group === 'canaryHelper') {
    return record.helperId !== undefined;
  }
  return record.helperId === undefined;
}

function sameLaunch(record: CheckedRecord, launch: CheckedLaunch): boolean {
  return record.pid === launch.pid && record.startTime === launch.startTime &&
    record.pidNamespace === launch.pidNamespace;
}

function processKey(record: CheckedRecord): string {
  return `${record.pidNamespace}:${record.pid}:${record.startTime}`;
}

function sharedBridgeProcess(first: InventoryGroup, second: InventoryGroup): boolean {
  return (first === 'bridge' && second === 'proxy') ||
    (first === 'proxy' && second === 'bridge');
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
  if (input === null || typeof input !== 'object' || Array.isArray(input) ||
    !('records' in input) || !('launches' in input) ||
    Object.keys(input).length !== 2 || !Array.isArray(input.records) ||
    !Array.isArray(input.launches)) {
    return failure('inventory');
  }
  const expected = expectedKeys(context);
  const launches = new Map<string, CheckedLaunch>();
  for (const value of input.launches) {
    const parsed = launchSchema.safeParse(value);
    if (!parsed.success) {
      return failure(recordCode(value));
    }
    const launch = parsed.data;
    const key = recordKey(launch);
    if (!expected.has(key) || launches.has(key) || !validHelperId(launch) ||
      launch.location !== expectedLocation(launch.group)) {
      return failure(launch.group);
    }
    launches.set(key, launch);
  }
  const checked = new Map<string, CheckedRecord>();
  const identities = new Map<string, InventoryGroup>();
  for (const value of input.records) {
    const parsed = recordSchema.safeParse(value);
    if (!parsed.success) {
      return failure(recordCode(value));
    }
    const record = parsed.data;
    const key = recordKey(record);
    const launch = launches.get(key);
    if (!launch || !matchesContext(context, record, launch) ||
      !sameLaunch(record, launch) || !expected.has(key) || checked.has(key) ||
      !validHelperId(record)) {
      return failure(record.group);
    }
    const identity = processKey(record);
    const previous = identities.get(identity);
    if (previous !== undefined && !sharedBridgeProcess(previous, record.group)) {
      return failure(record.group);
    }
    identities.set(identity, record.group);
    checked.set(key, record);
  }
  for (const [key, group] of expected) {
    if (!checked.has(key) || !launches.has(key)) {
      return failure(group);
    }
  }
  return checked;
}

function isFailure(value: Map<string, CheckedRecord> | JoinResult): value is JoinResult {
  return !(value instanceof Map);
}

function sameProcess(first: CheckedRecord, final: CheckedRecord): boolean {
  return first.pid === final.pid && first.startTime === final.startTime &&
    first.pidNamespace === final.pidNamespace;
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

// Refuse until the held journey can measure all launches and protected processes together.
export function readCurrentInventory(_context: InventoryContext): InventorySnapshot {
  return { records: [], launches: [] };
}
