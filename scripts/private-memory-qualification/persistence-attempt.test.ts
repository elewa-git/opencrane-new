import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  inventoryGroups, type InventoryContext, type InventorySnapshot,
  type ProtectionRecord, type TrustedLaunch,
} from './joined-inventory.ts';
import {
  runPersistenceAttempt, type PersistenceDriver,
} from './persistence-attempt.ts';

const serverInstallation = `sha256:${'a'.repeat(64)}`;
const computerInstallation = `sha256:${'b'.repeat(64)}`;
const serverImage = `sha256:${'c'.repeat(64)}`;
const computerImage = `sha256:${'d'.repeat(64)}`;
const challenge = '11111111-1111-4111-8111-111111111111';
const categories = ['pvc', 'rollout', 'cache', 'outbox', 'logs', 'dumps'] as const;
const expectedToolClasses = [
  'shell', 'file', 'browser', 'codeHost', 'externalMcp', 'skills', 'plugins', 'spawn',
] as const;
const context: InventoryContext = {
  serverInstallationId: serverInstallation, computerInstallationId: computerInstallation,
  serverImageDigest: serverImage, computerImageDigest: computerImage,
  challengeId: challenge, generationId: computerInstallation, helperIds: [challenge],
};
let directory: string;

function snapshot(): InventorySnapshot & {
  records: ProtectionRecord[]; launches: TrustedLaunch[];
} {
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
  let installedServer = serverInstallation;
  let installationChecks = 0;
  let reply: 'blocked' | 'wrote' | 'unknown' | 'not_run' = 'blocked';
  let writingTool: typeof expectedToolClasses[number] | undefined;
  let replacementCheck: number | undefined;
  let readHook: (() => void) | undefined;
  let stopHook: (() => void) | undefined;
  function replace(): void { installed = serverInstallation; }
  function replaceServer(): void { installedServer = computerInstallation; }
  function setReply(value: typeof reply): void { reply = value; }
  function setWritingTool(tool: typeof expectedToolClasses[number]): void {
    writingTool = tool;
  }
  function replaceAtCheck(check: number): void { replacementCheck = check; }
  function numberOfInstallationChecks(): number { return installationChecks; }
  function setReadHook(hook: () => void): void { readHook = hook; }
  function setStopHook(hook: () => void): void { stopHook = hook; }
  const driver: PersistenceDriver = {
    context, locations, canary,
    currentInstallations() {
      installationChecks += 1;
      if (installationChecks === replacementCheck) {
        replace();
      }
      return { serverInstallationId: installedServer, computerInstallationId: installed };
    },
    readInventory() {
      const read = reads.shift() ?? snapshot();
      readHook?.();
      return read;
    },
    startNative() {
      calls.push('start');
      return Promise.resolve({
        attemptTool(tool: string, _privateText: Buffer) {
          calls.push(tool);
          if (tool === writingTool) {
            return Promise.resolve('wrote' as const);
          }
          return Promise.resolve(reply);
        },
        stop() {
          calls.push('stop');
          stopHook?.();
          return Promise.resolve();
        },
      });
    },
  };
  return { driver, reads, calls, canary, locations, replace, replaceServer,
    replaceAtCheck, numberOfInstallationChecks, setReply, setWritingTool,
    setReadHook, setStopHook };
}

afterEach(function clean(): void {
  if (directory) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function cleanAttempt(): Promise<void> {
  const { driver, calls, numberOfInstallationChecks } = fixture();
  const result = await runPersistenceAttempt(driver);
  expect(result).toEqual({ result: 'PARTIAL', complete: false });
  expect(calls).toEqual(['start', ...expectedToolClasses, 'stop']);
  expect(numberOfInstallationChecks()).toBe(15);
}
it('scans once live and once after Stop while the native pair is held', cleanAttempt);

async function missingGroup(group: typeof inventoryGroups[number]): Promise<void> {
  const { driver, reads, calls } = fixture();
  const changed = reads[1]!;
  changed.records = changed.records.filter(
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

async function changedFirstGroup(): Promise<void> {
  const { driver, reads, calls } = fixture();
  reads[0]!.records[4]!.startTime = '9999';
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'nativeWrapper',
  });
  expect(calls).toEqual(['start', 'stop']);
}
it('refuses a changed native launch at the first read', changedFirstGroup);

async function changedFirstSnapshot(): Promise<void> {
  const { driver, reads, calls } = fixture();
  reads[0]!.records[0]!.challengeId = '22222222-2222-4222-8222-222222222222';
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'serverDelivery',
  });
  expect(calls).toEqual(['start', 'stop']);
}
it('checks the first complete snapshot before any private tool call', changedFirstSnapshot);

async function changedSecondNative(): Promise<void> {
  const { driver, reads } = fixture();
  reads[1]!.records[5]!.startTime = '9999';
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'nativeChild',
  });
}
it('refuses a changed native child at the second read', changedSecondNative);

async function replacedFinalSnapshot(): Promise<void> {
  const { driver, reads, calls } = fixture();
  const final = reads[1]!;
  final.records[5]!.pid = 900;
  final.launches[5]!.pid = 900;
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'nativeChild',
  });
  expect(calls).toEqual(['start', ...expectedToolClasses, 'stop']);
}
it('compares two individually valid snapshots of the held native child', replacedFinalSnapshot);

async function stoppedHelper(): Promise<void> {
  const { driver, reads } = fixture();
  const final = reads[1]!.records;
  const helper = final.find(function isHelper(record) { return record.group === 'canaryHelper'; });
  helper!.startTime = '9999';
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, group: 'canaryHelper',
  });
}
it('refuses a stopped or replaced canary helper', stoppedHelper);

async function replacement(): Promise<void> {
  const { driver, replace, setReadHook } = fixture();
  setReadHook(replace);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
}
it('refuses a replacement during the same attempt', replacement);

async function replacedServer(): Promise<void> {
  const { driver, calls, replaceServer, setReadHook } = fixture();
  setReadHook(replaceServer);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(calls).toEqual(['start', 'stop']);
}
it('checks the server installation as well as the computer installation', replacedServer);

const installationPlacements = [
  { check: 1, calls: [] },
  { check: 2, calls: ['start', 'stop'] },
  { check: 3, calls: ['start', 'stop'] },
  { check: 4, calls: ['start', 'stop'] },
  { check: 5, calls: ['start', 'shell', 'stop'] },
  { check: 12, calls: ['start', ...expectedToolClasses, 'stop'] },
  { check: 13, calls: ['start', ...expectedToolClasses, 'stop'] },
  { check: 14, calls: ['start', ...expectedToolClasses, 'stop'] },
  { check: 15, calls: ['start', ...expectedToolClasses, 'stop'] },
] as const;

async function replacementAtCheck(placement: typeof installationPlacements[number]): Promise<void> {
  const { driver, calls, replaceAtCheck } = fixture();
  replaceAtCheck(placement.check);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'inventory',
  });
  expect(calls).toEqual(placement.calls);
}
it.each(installationPlacements)(
  'refuses a replacement at installation check $check', replacementAtCheck);

async function storedCanary(category: typeof categories[number]): Promise<void> {
  const { driver, canary } = fixture();
  writeFileSync(join(directory, category, 'private'), canary);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, category,
  });
}
it.each(categories)('finds a canary in %s outside the native namespace', storedCanary);

async function storedAfterStop(): Promise<void> {
  const { driver, canary, setStopHook } = fixture();
  function saveCanary(): void {
    writeFileSync(join(directory, 'rollout', 'late'), canary);
  }
  setStopHook(saveCanary);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, category: 'rollout',
  });
}
it('finds bytes saved during Stop in the second scan', storedAfterStop);

async function unreadable(): Promise<void> {
  const { driver } = fixture();
  chmodSync(join(directory, 'outbox'), 0);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, category: 'outbox',
  });
}
it('never succeeds after a partial storage inspection', unreadable);

async function attemptedWrite(): Promise<void> {
  const { driver, setReply } = fixture();
  setReply('wrote');
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
}
it('reports an attempted tool write as failure', attemptedWrite);

async function writeInToolClass(tool: typeof expectedToolClasses[number]): Promise<void> {
  const { driver, calls, setWritingTool } = fixture();
  setWritingTool(tool);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool,
  });
  const toolIndex = expectedToolClasses.indexOf(tool);
  expect(calls).toEqual(['start', ...expectedToolClasses.slice(0, toolIndex + 1), 'stop']);
}
it.each(expectedToolClasses)('reports a write by %s and sends no later tool', writeInToolClass);

async function writeBeforeReplacement(check: number): Promise<void> {
  const { driver, calls, replaceAtCheck, setReply } = fixture();
  setReply('wrote');
  replaceAtCheck(check);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
  expect(calls).toEqual(['start', 'shell', 'stop']);
}
it.each([5, 6, 7, 8])(
  'keeps a known tool write when installation check %s refuses', writeBeforeReplacement);

async function writeDuringStop(): Promise<void> {
  const { driver, calls, replace, setReply, setStopHook } = fixture();
  setReply('wrote');
  setStopHook(replace);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
  expect(calls).toEqual(['start', 'shell', 'stop']);
}
it('keeps a known tool write when Stop changes the installation', writeDuringStop);

async function writeBeforeUnreadableStoppedStore(): Promise<void> {
  const { driver, setReply, setStopHook } = fixture();
  setReply('wrote');
  function hideStore(): void {
    chmodSync(join(directory, 'outbox'), 0);
  }
  setStopHook(hideStore);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
}
it('keeps a known tool write when the stopped scan cannot read storage',
  writeBeforeUnreadableStoppedStore);

async function writeWithUnreadableStore(): Promise<void> {
  const { driver, setReply } = fixture();
  setReply('wrote');
  chmodSync(join(directory, 'outbox'), 0);
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'FAIL', complete: false, tool: 'shell',
  });
}
it('does not erase a known tool write after an incomplete scan', writeWithUnreadableStore);

async function unexercisedTool(): Promise<void> {
  const { driver, setReply } = fixture();
  setReply('not_run');
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, tool: 'shell',
  });
}
it('reports an unexercised tool as NOT RUN', unexercisedTool);

async function unknownReply(): Promise<void> {
  const { driver, calls, setReply } = fixture();
  setReply('unknown');
  expect(await runPersistenceAttempt(driver)).toEqual({
    result: 'NOT RUN', complete: false, tool: 'shell',
  });
  expect(calls).toEqual(['start', 'shell', 'stop']);
}
it('does not resend a write after an unknown native reply', unknownReply);
