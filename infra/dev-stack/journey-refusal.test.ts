import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

type Invocation = { script: string; args: string[]; shell?: boolean };
const commands: Invocation[] = [
  { script: 'journey.sh', args: ['--id', 'owner'], shell: true },
  { script: 'stack.ts', args: ['journey'] },
  { script: 'journey.ts', args: [] },
  { script: 'bootstrap-journey.ts', args: [] },
  { script: 'screenshot-journey.ts', args: ['fresh'] },
  { script: 'mcp-journey.ts', args: ['fresh'] },
];

async function invoke(command: Invocation, fleet?: string, id = 'owner', realMode = false) {
  const home = await mkdtemp(`${tmpdir()}/journey-refusal-`);
  try {
    const bin = `${home}/bin`;
    await mkdir(bin);
    await symlink(process.execPath, `${bin}/node`);
    await symlink('/usr/bin/dirname', `${bin}/dirname`);
    const executable = { mode: 0o755 };
    await writeFile(`${bin}/flock`, '#!/bin/sh\nshift 2\nexec "$@"\n', executable);
    await writeFile(`${bin}/id`, '#!/bin/sh\necho 999999\n', executable);
    const record = `${home}/record`;
    await writeFile(record, '');
    const env: NodeJS.ProcessEnv = {
      HOME: home, PATH: bin, DEV_STACK_ID: id, JOURNEY_RECORD: record,
      NODE_OPTIONS: '--import=./infra/dev-stack/test/journey-refusal-preload.mjs',
    };
    if (realMode) env['JOURNEY_SAVED_MODE'] = '1';
    if (fleet !== undefined) env['OPENCRANE_FLEET_TASK'] = fleet;
    let executablePath = process.execPath;
    let args = ['--experimental-strip-types', `infra/dev-stack/${command.script}`, ...command.args];
    if (command.shell) {
      executablePath = '/bin/sh';
      args = [`infra/dev-stack/${command.script}`, ...command.args];
    }
    const options = { env, encoding: 'utf8' as const, timeout: 15_000 };
    const result = spawnSync(executablePath, args, options);
    assert.ifError(result.error);
    const reads = await readFile(record, 'utf8');
    return { status: result.status, output: result.stdout + result.stderr, reads };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

for (const command of commands) {
  async function refuseOwnerJourney() {
    for (const fleet of [undefined, '', 'demo-kit-2']) {
      const result = await invoke(command, fleet);
      assert.notEqual(result.status, 0, command.script);
      assert.equal(result.reads, '', `${command.script}: ${result.output}`);
      assert.match(result.output, /Automated journeys require a secondary stack/u);
    }
  }
  test(`${command.script} refuses owner before configuration, with or without a fleet marker`,
    refuseOwnerJourney);
}

async function refuseRealStandInJourney() {
  const command = { script: 'journey.ts', args: [] };
  const result = await invoke(command, undefined, '1', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.reads, 'settings read\n', result.output);
  assert.match(result.output, /Journey provider mode does not match the saved stack/u);
}

test('direct journey without real opt-in refuses saved real mode before journey setup',
  refuseRealStandInJourney);

async function refuseFleetJourneys() {
  for (const fleet of ['', 'demo-kit-2']) {
    const result = await invoke({ script: 'journey.ts', args: [] }, fleet, '1');
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, '', result.output);
    assert.match(result.output, /no fleet task/u);
  }
}

test('a fleet marker cannot run a standalone automated journey', refuseFleetJourneys);

async function refuseNonStartConsent() {
  for (const action of ['down', 'status', 'journey', 'package-check']) {
    const command = { script: 'run.sh', shell: true, args: [action, '--id', '1', '--owner-run'] };
    const result = await invoke(command, undefined, '1');
    assert.equal(result.status, 2, result.output);
    assert.equal(result.reads, '', result.output);
  }
}

test('the shell refuses owner consent on non-start actions before invoking Node', refuseNonStartConsent);

async function refuseInvalidOptions() {
  for (const args of [['up', '--fresh', '--fresh'], ['up', '--owner-run', '--owner-run'],
    ['up', '--owner-run']]) {
    const result = await invoke({ script: 'stack.ts', args }, undefined, '1');
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, '', result.output);

  }
}

test('direct startup refuses duplicate flags and secondary owner consent', refuseInvalidOptions);
