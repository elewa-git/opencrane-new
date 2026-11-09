import { z } from 'zod';
import { execFileSync } from 'node:child_process';

export const inventoryGroups = [
  'serverDelivery', 'bridge', 'supervisor', 'proxy', 'nativeWrapper',
  'nativeChild', 'canaryHelper',
] as const;

type InventoryGroup = typeof inventoryGroups[number];
type LiveServiceGroup = InventoryGroup;
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
  executable: z.string().startsWith('/').max(512),
  uid: z.number().int().nonnegative(),
  cgroup: z.string().regex(/^0::\/[^\n]*\n$/u).max(512),
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
    record.pidNamespace === launch.pidNamespace &&
    record.executable === launch.executable && record.uid === launch.uid &&
    record.cgroup === launch.cgroup;
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
    first.pidNamespace === final.pidNamespace &&
    first.executable === final.executable && first.uid === final.uid &&
    first.cgroup === final.cgroup;
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

type InventoryContainers = { serverId: string; computerId: string };
const containerId = z.string().regex(/^[a-f0-9]{64}$/u);
const liveProcessSchema = z.strictObject({
  ...processIdentity,
  protected: z.literal(true),
});
const liveGroups: readonly LiveServiceGroup[] = [
  'serverDelivery', 'supervisor', 'bridge', 'proxy', 'nativeWrapper', 'nativeChild',
  'canaryHelper',
];

function liveProcess(container: string, group: LiveServiceGroup, context: InventoryContext,
  helperId?: string):
  z.output<typeof liveProcessSchema> {
  let probePath: string;
  if (group === 'serverDelivery' || group === 'canaryHelper') {
    probePath = '/app/scripts/private-memory-qualification/live-inventory-probe.ts';
  } else {
    probePath = '/scripts/private-memory-qualification/live-inventory-probe.ts';
  }
  const command = ['--host', 'unix:///var/run/docker.sock', 'exec', '--workdir', '/app',
    '--env', 'NODE_OPTIONS=', '--env', 'NODE_PATH=', '--env', 'LD_PRELOAD=',
    container, '/usr/local/bin/node', '--experimental-strip-types',
    probePath, group];
  if (group === 'nativeWrapper' || group === 'nativeChild') {
    command.push(context.challengeId);
  }
  if (group === 'canaryHelper' && helperId) {
    command.push(helperId, context.serverImageDigest, context.serverInstallationId);
  }
  const options = { timeout: 10_000, maxBuffer: 4096, stdio: 'pipe' as const };
  const output = execFileSync('/usr/bin/docker', command, options);
  const parsed: unknown = JSON.parse(output.toString('utf8'));
  return liveProcessSchema.parse(parsed);
}

// Read each existing live service probe from the measured installation. The native pair
// and canary require a held journey before this set can pass the joined check.
export function readCurrentInventory(context: InventoryContext,
  containers: InventoryContainers): InventorySnapshot {
  containerId.parse(containers.serverId);
  containerId.parse(containers.computerId);
  const records: ProtectionRecord[] = [];
  const launches: TrustedLaunch[] = [];
  for (const group of liveGroups) {
    const helperIds = group === 'canaryHelper' ? context.helperIds : [undefined];
    for (const helperId of helperIds) {
    const location = expectedLocation(group);
    const currentContainer = location === 'server' ? containers.serverId : containers.computerId;
    const process = liveProcess(currentContainer, group, context, helperId);
    const imageDigest = location === 'server' ? context.serverImageDigest :
      context.computerImageDigest;
    const identity = { pid: process.pid, startTime: process.startTime,
      pidNamespace: process.pidNamespace, executable: process.executable,
      uid: process.uid, cgroup: process.cgroup, dumpable: false as const };
    const record: ProtectionRecord = {
      serverInstallationId: context.serverInstallationId,
      computerInstallationId: context.computerInstallationId,
      serverImageDigest: context.serverImageDigest,
      computerImageDigest: context.computerImageDigest,
      challengeId: context.challengeId,
      generationId: context.generationId,
      group, helperId, imageDigest, ...identity, safe: process.protected,
    };
    records.push(record);
    launches.push({ group, helperId, location, ...identity });
    }
  }
  return { records, launches };
}
