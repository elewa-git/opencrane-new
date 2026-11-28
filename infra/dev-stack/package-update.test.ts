import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execute = promisify(execFile);

type FixtureOptions = { slot?: string; entry?: boolean; fleet?: string };

async function updateFixture(fail: boolean, condition = '', options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-update-'));
  try {
    const source = `
      import { applyPilotUpdate, upgradePackage, rollbackPackage } from
        './infra/dev-stack/packaged.ts';
      const condition = process.env.UPDATE_FIXTURE_CONDITION;
      try {
        if (process.env.UPDATE_FIXTURE_ENTRY === '1') {
          await upgradePackage();
        } else {
          await applyPilotUpdate(globalThis.packageUpdateOwner, '2', ['images.server=new'],
            '${'a'.repeat(40)}');
        }
      } catch (error) {
        console.log(error.message);
      }
      const manual = condition?.startsWith('wrong-') || [
        'manual-rollback', 'rollback-error', 'rollback-recovery', 'added-home-manual',
        'fleet-rollback', 'foreign-lock',
      ].includes(condition);
      if (manual) {
        try {
          globalThis.replaceUpdateIdentity(condition);
          globalThis.prepareRollback();
          if (condition === 'fleet-rollback') {
            process.env.OPENCRANE_FLEET_TASK = process.env.UPDATE_FIXTURE_FLEET;
          }
          await rollbackPackage('2');
        } catch (error) {
          console.log(error.message);
        }
      }`;
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/package-update-preload.mjs', '--input-type=module', '-e', source];
    const env: NodeJS.ProcessEnv = { ...process.env, DEV_STACK_ID: options.slot ?? '1',
      UPDATE_FIXTURE_ENTRY: options.entry ? '1' : '0', UPDATE_FIXTURE_FLEET: options.fleet,
      UPDATE_FIXTURE_DIRECTORY: directory,
      UPDATE_FIXTURE_FAILURE: fail ? '1' : '0', UPDATE_FIXTURE_CONDITION: condition };
    delete env['OPENCRANE_FLEET_TASK'];
    if (options.fleet !== undefined && condition !== 'fleet-rollback') {
      env['OPENCRANE_FLEET_TASK'] = options.fleet;
    }
    const output = await execute(process.execPath, args, { env, timeout: 30_000 });
    const text = await readFile(join(directory, 'result.json'), 'utf8');
    const result = JSON.parse(text) as { gateway: string; revision: string;
      computerImage: string; computerMode: string; calls: string[][]; locked: boolean;
      volumes: Array<{ metadata: { name: string; uid: string } }> };
    return { ...result, output: output.stdout };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function restoresGatewayAfterUpgrade() {
  const result = await updateFixture(false);
  assert.equal(result.revision, '3');
  assert.equal(result.gateway, 'http://10.0.0.8:43000');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'b'.repeat(64)}`);
  const patch = result.calls.findIndex(isGatewayPatch);
  const ready = result.calls.findIndex(isReadinessCheck);
  assert.ok(patch > 0 && patch < ready, 'Reapply the gateway before readiness checks');
}

function isGatewayPatch(args: string[]) {
  return args.includes('patch') && args.includes('computer-runtime');
}

function isReadinessCheck(args: string[]) {
  return args.includes('rollout');
}

async function restoresGatewayAfterRollback() {
  const result = await updateFixture(true);
  assert.match(result.output, /revision 2 was restored/u);
  assert.equal(result.revision, '2');
  assert.equal(result.gateway, 'http://10.0.0.8:43000');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'a'.repeat(64)}`);
  const patches = result.calls.filter(isGatewayPatch);
  assert.equal(patches.length, 3, 'Both update steps and rollback reset the gateway');
  const rollback = result.calls.find(isRollback);
  assert.equal(rollback?.includes('--wait=false'), true);
  assert.equal(rollback?.includes('--wait'), false, 'Leave the unused recovery claim unbound');
  function waitsForServer(args: string[]) {
    return args.includes('rollout') && args.includes('deployment/server');
  }
  assert.equal(result.calls.some(waitsForServer), true);
}

async function backsUpBeforeChangingRelease() {
  const result = await updateFixture(false);
  const backup = result.calls.findIndex(isBackupVerification);
  const upgrade = result.calls.findIndex(isUpgrade);
  assert.ok(backup >= 0 && backup < upgrade, 'Verify an exported backup before Helm changes');
}

function isBackupVerification(args: string[]) {
  return args.includes('show') && args.includes('infra/package/scheduled-backup-run.ts');
}

function isUpgrade(args: string[]) {
  return args[0] === 'helm' && args[1] === 'upgrade';
}

async function refusesManualBackup() {
  const result = await updateFixture(false, 'manual-backup');
  assert.match(result.output, /backup/u);
  assert.equal(result.calls.some(isUpgrade), false);
}

async function refusesExpiredRollbackScanner() {
  const result = await updateFixture(false, 'expired-scanner');
  assert.match(result.output, /[Ss]canner/u);
  assert.equal(result.calls.some(isUpgrade), false);
}

async function refusesUntrackedChart() {
  const result = await updateFixture(false, 'untracked-chart');
  assert.match(result.output, /untracked/u);
  assert.equal(result.calls.some(isUpgrade), false);
}

async function refusesChangedSource() {
  const result = await updateFixture(false, 'changed-source');
  assert.match(result.output, /source revision changed/u);
  assert.equal(result.calls.some(isUpgrade), false);
}

async function refusesWrongRollbackTarget() {
  for (const condition of ['wrong-record', 'wrong-release', 'wrong-volume']) {
    const result = await updateFixture(false, condition);
    assert.match(result.output, /another installation|volumes differ/u);
    assert.equal(result.calls.some(isRollback), false);
  }
}

function isRollback(args: string[]) {
  return args[0] === 'helm' && args[1] === 'rollback';
}

async function refusesRecoveryInstall() {
  const result = await updateFixture(false, 'recovery');
  assert.match(result.output, /recovery installation/u);
  assert.equal(result.calls.some(isUpgrade), false);
}

async function retainsLockWhenRollbackCannotRestart() {
  const result = await updateFixture(true, 'expired-after-upgrade');
  assert.match(result.output, /rollback could not be confirmed/u);
  assert.equal(result.calls.some(isRollback), false);
  function releasesLock(args: string[]) {
    return args.at(-1) === 'release';
  }
  assert.equal(result.calls.some(releasesLock), false);
}

async function releasesLockWhenSourceChangesBeforeHelm() {
  const result = await updateFixture(false, 'source-changed-before-helm');
  assert.match(result.output, /source revision changed/u);
  assert.equal(result.calls.some(isUpgrade), false);
  function releasesLock(args: string[]) {
    return args.at(-1) === 'release';
  }
  assert.equal(result.calls.some(releasesLock), true);
}

async function leavesIdleComputerStateWithTheWorker() {
  const result = await updateFixture(false, 'computer-idles-during-build');
  assert.equal(result.output, '');
  assert.equal(result.revision, '3');
  assert.equal(result.computerMode, 'Suspended');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'b'.repeat(64)}`);
  assert.equal(result.calls.some(isRollback), false);
}

async function returnsToTheSavedRevision() {
  const result = await updateFixture(false, 'manual-rollback');
  assert.equal(result.output, '');
  assert.equal(result.revision, '2');
  assert.equal(result.gateway, 'http://10.0.0.8:43000');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'a'.repeat(64)}`);
}

test('an in-place update repairs the gateway that Helm resets', restoresGatewayAfterUpgrade);
test('a failed update restores the recorded revision and its gateway', restoresGatewayAfterRollback);
test('the update verifies its backup before changing the release', backsUpBeforeChangingRelease);
test('a manual backup blocks the update before Helm changes', refusesManualBackup);
test('an expired rollback scanner blocks the update before Helm changes', refusesExpiredRollbackScanner);
test('an untracked chart object blocks the update', refusesUntrackedChart);
test('a different checkout cannot use the earlier source approval', refusesChangedSource);
test('manual rollback refuses another installation even when the revision number matches',
  refusesWrongRollbackTarget);
test('an update refuses a recovery installation', refusesRecoveryInstall);
test('an expired scanner prevents rollback and keeps backup maintenance locked',
  retainsLockWhenRollbackCannotRestart);
test('a source change before Helm releases the update lock without changing service',
  releasesLockWhenSourceChangesBeforeHelm);
test('a computer that becomes idle during the build keeps its saved lifecycle state',
  leavesIdleComputerStateWithTheWorker);
test('manual rollback returns the recorded installation to its earlier images',
  returnsToTheSavedRevision);

async function refusesFleetUpdate() {
  for (const fleet of ['', 'fixture-task']) {
    const options = { slot: '2', entry: true, fleet };
    const result = await updateFixture(false, '', options);
    assert.match(result.output, /[Ff]leet/u);
    assert.equal(result.calls.length, 0, 'Refuse before reading or changing the cluster');
  }
}

async function refusesFleetRollback() {
  for (const fleet of ['', 'fixture-task']) {
    const options = { slot: '2', fleet };
    const result = await updateFixture(false, 'fleet-rollback', options);
    assert.match(result.output, /[Ff]leet/u);
    assert.equal(result.calls.some(isRollback), false);
    assert.equal(result.revision, '3');
  }
}

async function operatorCanUpdateAndRollbackSlotTwo() {
  const options = { slot: '2', entry: true };
  const result = await updateFixture(false, 'manual-rollback', options);
  assert.match(result.output, /^PASS applied application approval from GitHub run fixture\n$/u);
  assert.equal(result.calls.some(isUpgrade), true);
  assert.equal(result.calls.some(isRollback), true);
  assert.equal(result.revision, '2');
}

async function rollsBackWithExcludedBackupJob() {
  const result = await updateFixture(true, 'backup-during-update');
  assert.match(result.output, /revision 2 was restored/u);
  assert.equal(result.revision, '2');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'a'.repeat(64)}`);
  assert.equal(result.locked, false);
}

async function resumesTheSavedRollback() {
  const result = await updateFixture(true, 'rollback-error');
  assert.match(result.output, /rollback could not be confirmed/u);
  assert.doesNotMatch(result.output, /unfinished maintenance/u);
  const rollbacks = result.calls.filter(isRollback);
  assert.equal(rollbacks.length, 2);
  assert.equal(result.revision, '2');
  assert.equal(result.computerImage, `registry.invalid/package@sha256:${'a'.repeat(64)}`);
  assert.equal(result.locked, false);
}

async function refusesAnotherUpdatesLock() {
  const result = await updateFixture(false, 'foreign-lock');
  assert.match(result.output, /unfinished maintenance/u);
  assert.equal(result.calls.some(isRollback), false);
  assert.equal(result.locked, true);
}

function assertAddedHome(result: Awaited<ReturnType<typeof updateFixture>>) {
  const expected = { metadata: { name: 'home-computer-two', uid: 'new-home-id' } };
  assert.deepEqual(result.volumes[1], expected);
  assert.equal(result.locked, false);
}

async function keepsNewHomeAfterRestart() {
  const result = await updateFixture(false, 'added-home');
  assert.equal(result.output, '');
  assert.equal(result.revision, '3');
  assert.equal(result.calls.some(isRollback), false);
  assertAddedHome(result);
}

async function rollsBackWithNewHome() {
  const result = await updateFixture(true, 'added-home-failed-update');
  assert.match(result.output, /revision 2 was restored/u);
  assert.equal(result.revision, '2');
  assertAddedHome(result);
}

async function manuallyRollsBackWithNewHome() {
  const result = await updateFixture(false, 'added-home-manual');
  assert.equal(result.output, '');
  assert.equal(result.revision, '2');
  assertAddedHome(result);
}

test('fleet update entry refuses populated and empty markers on an owned slot 2',
  refusesFleetUpdate);
test('fleet rollback entry refuses populated and empty markers on an owned slot 2',
  refusesFleetRollback);
test('the operator can update and roll back an owned slot 2 through both entrypoints',
  operatorCanUpdateAndRollbackSlotTwo);
test('a backup Job excluded by the update lock cannot prevent automatic rollback',
  rollsBackWithExcludedBackupJob);
test('manual recovery resumes the same saved update after a transient rollback error',
  resumesTheSavedRollback);
test('manual recovery refuses another update lock', refusesAnotherUpdatesLock);
test('a home created after restart does not fail the final update check', keepsNewHomeAfterRestart);
test('automatic rollback preserves a home created after restart', rollsBackWithNewHome);
test('manual rollback preserves a home created after the update', manuallyRollsBackWithNewHome);

const guardCases = [
  { condition: 'scanner-margin', message: /Scanner release refused/u },
  { condition: 'computer-source', message: /computer source revision differs/u },
  { condition: 'tracked-chart', message: /Package command failed/u },
  { condition: 'backup-image', message: /backup used different package images/u },
  { condition: 'corrupt-backup', message: /Backup bytes differ/u },
  { condition: 'computer-labels', message: /Retained Sandbox belongs to another computer or assistant/u },
  { condition: 'computer-uid', message: /computer identity changed/u },
  { condition: 'home-owner', message: /home|PVC/u },
  { condition: 'running-image', message: /running computer image differs/u },
];
for (const guard of guardCases) {
  async function refusesUnsafeUpdate() {
    const result = await updateFixture(false, guard.condition);
    assert.match(result.output, guard.message);
    assert.equal(result.revision, '2');
  }
  test(`the update independently refuses ${guard.condition}`, refusesUnsafeUpdate);
}

for (const condition of ['wrong-context', 'wrong-namespace', 'wrong-revision', 'rollback-recovery']) {
  async function refusesUnsafeRollback() {
    const result = await updateFixture(false, condition);
    assert.match(result.output, /another installation|Select the revision|recovery installation/u);
    assert.equal(result.calls.some(isRollback), false);
    assert.equal(result.revision, '3');
  }
  test(`manual rollback independently refuses ${condition}`, refusesUnsafeRollback);
}
