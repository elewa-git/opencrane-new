import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  inventoryGroups, type InventoryContext, type InventorySnapshot,
  type ProtectionRecord, type TrustedLaunch,
} from './joined-inventory.ts';
import { runPersistenceAttempt, toolClasses } from './persistence-attempt.ts';

const serverInstallation = `sha256:${'a'.repeat(64)}`;
const computerInstallation = `sha256:${'b'.repeat(64)}`;
const serverImage = `sha256:${'c'.repeat(64)}`;
const computerImage = `sha256:${'d'.repeat(64)}`;
const challenge = '11111111-1111-4111-8111-111111111111';
const categories = ['pvc', 'rollout', 'cache', 'outbox', 'logs', 'dumps'] as const;
const context: InventoryContext = {
  serverInstallationId: serverInstallation, computerInstallationId: computerInstallation,
  serverImageDigest: serverImage, computerImageDigest: computerImage,
  challengeId: challenge, generationId: computerInstallation, helperIds: [challenge],
};
let directory: string;

function snapshot(): InventorySnapshot {
  const records: ProtectionRecord[] = [];
  const launches: TrustedLaunch[] = [];
  for (const [index, group] of inventoryGroups.entries()) {
    const location = group === 'serverDelivery' || group === 'canaryHelper' ?
      'server' : 'computer';
    const imageDigest = location === 'server' ? serverImage : computerImage;
    const helperId = group === 'canaryHelper' ? challenge : undefined;
    const identity = {
      group, helperId, pid: index + 100, startTime: String(index + 1000),
      pidNamespace: 'pid:[4026531836]', executable: '/usr/local/bin/node',
      uid: 1000, cgroup: '0::/test\n', dumpable: false as const,
    };
    records.push({ ...identity, imageDigest, serverInstallationId: serverInstallation,
      computerInstallationId: computerInstallation, serverImageDigest: serverImage,
      computerImageDigest: computerImage, challengeId: challenge,
      generationId: computerInstallation, safe: true });
    launches.push({ ...identity, location });
  }
  return { records, launches };
}

function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'persistence-attempt-'));
  const locations = categories.map(function makeLocation(category) {
    const path = join(directory, category);
    mkdirSync(path);
    return { category, path };
  });
  const canary = Buffer.from(randomBytes(32).toString('hex'));
  const reads = [snapshot(), snapshot()];
  const calls: string[] = [];
  let installed = computerInstallation;
  const driver = {
    context, locations, canary,
    currentInstallation() { return installed; },
    readInventory() { return reads.shift() ?? snapshot(); },
    async startNative() {
      calls.push('start');
      return {
        async attemptTool(tool: string, _privateText: Buffer) {
          calls.push(tool);
          return 'blocked' as const;
        },
        async stop() { calls.push('stop'); },
      };
    },
  };
  return { driver, reads, calls, canary, locations,
    replace() { installed = serverInstallation; } };
}

afterEach(function clean(): void {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function cleanAttempt(): Promise<void> {
  const { driver, calls } = fixture();
  const result = await runPersistenceAttempt(driver);
  expect(result).toEqual({ result: 'PARTIAL', complete: false });
  expect(calls).toEqual(['start', ...toolClasses, 'stop']);
}
it('scans once live and once after Stop while the native pair is held', cleanAttempt);

async function missingGroup(group: typeof inventoryGroups[number]): Promise<void> {
  const { driver, reads, calls } = fixture();
  const changed = reads[1]!;
  changed.records = (changed.records as ProtectionRecord[]).filter(
    function keep(record) { return record.group !== group; });
  const result = await runPersistenceAttempt(driver);
  expect(result).toEqual({ result: 'FAIL', complete: false, group });
  expect(calls.at(-1)).toBe('stop');
}
it.each(inventoryGroups)('refuses an omitted %s at the second read', missingGroup);

async function missingFirstGroup(): Promise<void> {
  const { driver, reads, calls } = fixture();
  reads[0]!.records = [];
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'serverDelivery',
  });
  expect(calls).toEqual(['start', 'stop']);
}
it('refuses an omitted group before private input', missingFirstGroup);

async function stoppedHelper(): Promise<void> {
  const { driver, reads } = fixture();
  const final = reads[1]!.records as ProtectionRecord[];
  const helper = final.find(function isHelper(record) { return record.group === 'canaryHelper'; });
  helper!.startTime = '9999';
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'canaryHelper',
  });
}
it('refuses a stopped or replaced canary helper', stoppedHelper);

async function replacement(): Promise<void> {
  const { driver, replace } = fixture();
  const original = driver.readInventory;
  driver.readInventory = function changedAfterFirst() {
    const read = original();
    replace();
    return read;
  };
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
}
it('refuses a replacement during the same attempt', replacement);

async function storedCanary(category: typeof categories[number]): Promise<void> {
  const { driver, canary } = fixture();
  writeFileSync(join(directory, category, 'private'), canary);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, category,
  });
}
it.each(categories)('finds a canary in %s outside the native namespace', storedCanary);

async function unreadable(): Promise<void> {
  const { driver } = fixture();
  chmodSync(join(directory, 'outbox'), 0);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'outbox',
  });
}
it('never succeeds after a partial storage inspection', unreadable);

async function attemptedWrite(): Promise<void> {
  const { driver } = fixture();
  const start = driver.startNative;
  driver.startNative = async function writeAttempt() {
    const native = await start();
    native.attemptTool = async function result() { return 'wrote' as const; };
    return native;
  };
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
}
it('reports an attempted tool write as failure', attemptedWrite);

async function unknownReply(): Promise<void> {
  const { driver, calls } = fixture();
  const start = driver.startNative;
  driver.startNative = async function uncertainAttempt() {
    const native = await start();
    native.attemptTool = async function result(tool) {
      calls.push(tool);
      return 'unknown' as const;
    };
    return native;
  };
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, tool: 'shell',
  });
  expect(calls).toEqual(['start', 'shell', 'stop']);
}
it('does not resend a write after an unknown native reply', unknownReply);
