import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

async function launcherFixture() {
  const directory = await mkdtemp(`${tmpdir()}/demo-up-`);
  const scripts = `${directory}/infra/dev-stack`;
  const executable = { mode: 0o755 };
  const credential = 'synthetic-demo-provider-credential';
  await mkdir(scripts, { recursive: true });
  await copyFile('infra/dev-stack/demo-up.sh', `${scripts}/demo-up.sh`);
  await writeFile(`${directory}/credential`, credential);
  await writeFile(`${directory}/calls`, '');
  await writeFile(`${directory}/cleanup`, '');
  const claim = '#!/bin/sh\nprintf "%s\\n" "$DEMO_CLAIM"\n';
  await writeFile(`${scripts}/claim.sh`, claim, executable);
  const start = '#!/bin/sh\nprintf "%s %s %s\\n" "$*" "$DEV_REAL_PROVIDER_FILE" ' +
    '"$COMPUTER_IDLE_MS" >> "$DEMO_RECORD"\nexit "$DEMO_START_STATUS"\n';
  await writeFile(`${scripts}/up.sh`, start, executable);
  const cleanup = '#!/bin/sh\necho "$*" >> "$DEMO_CLEANUP"\n';
  await writeFile(`${scripts}/down.sh`, cleanup, executable);
  const seed = '#!/bin/sh\necho seed >> "$DEMO_RECORD"\nexit "$DEMO_SEED_STATUS"\n';
  await writeFile(`${directory}/node`, seed, executable);
  const controls = { claim: '1', startStatus: '0', seedStatus: '0' };
  function run(id?: string) {
    const env = {
      PATH: `${directory}:/usr/bin:/bin`,
      HOME: directory,
      DEV_REAL_PROVIDER_FILE: `${directory}/credential`,
      DEMO_RECORD: `${directory}/calls`,
      DEMO_CLEANUP: `${directory}/cleanup`,
      DEV_STACK_ID: id,
      DEMO_CLAIM: controls.claim,
      DEMO_START_STATUS: controls.startStatus,
      DEMO_SEED_STATUS: controls.seedStatus,
    };
    const options = { env, encoding: 'utf8' as const };
    const result = spawnSync('/bin/sh', [`${scripts}/demo-up.sh`], options);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.stdout.includes(credential), false);
    assert.equal(result.stderr.includes(credential), false);
    return result;
  }
  async function calls() {
    return readFile(`${directory}/calls`, 'utf8');
  }
  async function cleanups() {
    return readFile(`${directory}/cleanup`, 'utf8');
  }
  async function close() {
    await rm(directory, { recursive: true, force: true });
  }
  return { directory, controls, run, calls, cleanups, close };
}

async function checksLauncher() {
  const fixture = await launcherFixture();
  try {
    for (const id of [undefined, '', 'owner', '3']) {
      assert.equal(fixture.run(id).status, 2);
    }
    assert.equal(fixture.run('1').status, 0);
    const calls = await fixture.calls();
    assert.equal(calls, `--id 1 --fresh ${fixture.directory}/credential 14400000\nseed\n`);
    assert.equal(await fixture.cleanups(), '');
    fixture.controls.startStatus = '1';
    assert.equal(fixture.run('1').status, 1);
    assert.equal(await fixture.cleanups(), '--id 1\n');
  } finally {
    await fixture.close();
  }
}

async function keepsExistingMismatchedSlot() {
  const fixture = await launcherFixture();
  try {
    // Represent the slot already owned by this worktree, returned by claim.sh again.
    const existingSlot = `${fixture.directory}/.config/opencrane/dev-stack-1`;
    await mkdir(existingSlot, { recursive: true });
    await writeFile(`${existingSlot}/stack-owner`, `worktree=${fixture.directory}\n`);
    await writeFile(`${existingSlot}/saved-data`, 'existing rehearsal');
    const result = fixture.run('2');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Requested secondary is unavailable/u);
    assert.equal(await fixture.calls(), '');
    assert.equal(await fixture.cleanups(), '');
    assert.equal(await readFile(`${existingSlot}/saved-data`, 'utf8'), 'existing rehearsal');
  } finally {
    await fixture.close();
  }
}

async function refusesUnsafeClaims() {
  const fixture = await launcherFixture();
  try {
    for (const claim of ['owner', '', '3', '1\n2']) {
      fixture.controls.claim = claim;
      const result = fixture.run('1');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Invalid secondary claim/u);
      assert.equal(await fixture.calls(), '');
      assert.equal(await fixture.cleanups(), '');
    }
  } finally {
    await fixture.close();
  }
}

async function cleansAfterSeedFailure() {
  const fixture = await launcherFixture();
  try {
    fixture.controls.claim = '2';
    fixture.controls.seedStatus = '1';
    assert.equal(fixture.run('2').status, 1);
    const expectedCalls = `--id 2 --fresh ${fixture.directory}/credential 14400000\nseed\n`;
    assert.equal(await fixture.calls(), expectedCalls);
    assert.equal(await fixture.cleanups(), '--id 2\n');
  } finally {
    await fixture.close();
  }
}

test('launcher guards ids, uses the file switch and cleans failed starts', checksLauncher);
test('requesting slot 2 keeps the existing slot 1 without startup or cleanup',
  keepsExistingMismatchedSlot);
test('owner and invalid returned claims cannot start or clean a stack', refusesUnsafeClaims);
test('seed failure cleans only the secondary started by this run', cleansAfterSeedFailure);
