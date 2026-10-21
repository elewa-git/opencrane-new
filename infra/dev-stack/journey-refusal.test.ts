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
  { script: 'live-view-repeat.ts', args: [] },
  { script: '../package/capture.mjs', args: ['fresh-1-'] },
  { script: '../package/fresh-twice.ts', args: ['/synthetic-values.json'] },
];

async function invoke(
  command: Invocation,
  fleet?: string,
  id = 'owner',
  realMode = false,
  recordCommands = false,
) {
  const home = await mkdtemp(`${tmpdir()}/journey-refusal-`);
  try {
    const bin = `${home}/bin`;
    await mkdir(bin);
    const executable = { mode: 0o755 };
    if (recordCommands) {
      const nodeStub = '#!/bin/sh\nprintf node >> "$JOURNEY_COMMANDS"\n';
      const flockStub = '#!/bin/sh\nprintf flock >> "$JOURNEY_COMMANDS"\n';
      await writeFile(`${bin}/node`, nodeStub, executable);
      await writeFile(`${bin}/flock`, flockStub, executable);
    } else {
      await symlink(process.execPath, `${bin}/node`);
      await writeFile(`${bin}/flock`, '#!/bin/sh\nshift 2\nexec "$@"\n', executable);
    }
    await symlink('/usr/bin/dirname', `${bin}/dirname`);
    await writeFile(`${bin}/id`, '#!/bin/sh\necho 999999\n', executable);
    const record = `${home}/record`;
    await writeFile(record, '');
    await writeFile(`${home}/commands`, '');
    await writeFile(`${home}/stack-owner`, process.cwd());
    const env: NodeJS.ProcessEnv = {
      HOME: home, PATH: bin, DEV_STACK_ID: id, JOURNEY_RECORD: record,
      JOURNEY_COMMANDS: `${home}/commands`,
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
    const commandCalls = await readFile(`${home}/commands`, 'utf8');
    return {
      status: result.status,
      output: result.stdout + result.stderr,
      reads,
      commandCalls,
    };
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

async function refuseShellJourney() {
  for (const fleet of [undefined, '', 'demo-kit-2']) {
    const command = { script: 'run.sh', shell: true, args: ['journey'] };
    const result = await invoke(command, fleet, 'owner', false, true);
    assert.equal(result.status, 2, result.output);
    assert.equal(result.commandCalls, '', `flock or Node ran: ${result.commandCalls}`);
    assert.match(result.output, /Automated journeys require a secondary stack and no fleet task/u);
  }
}

test('the shell refuses owner journeys before flock or Node, with any fleet marker',
  refuseShellJourney);

async function refuseInvalidOptions() {
  for (const args of [['up', '--fresh', '--fresh'], ['up', '--owner-run', '--owner-run'],
    ['up', '--owner-run']]) {
    const result = await invoke({ script: 'stack.ts', args }, undefined, '1');
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, '', result.output);

  }
}

test('direct startup refuses duplicate flags and secondary owner consent', refuseInvalidOptions);

for (const script of ['bootstrap-journey.ts', 'live-view-repeat.ts']) {
  async function refuseRealMode() {
    const command = { script, args: [] };
    const result = await invoke(command, undefined, '1', true);
    assert.notEqual(result.status, 0);
    assert.equal(result.reads, 'settings read\n', result.output);
    assert.match(result.output, /This journey requires the stand-in model/u);
  }
  test(`${script} refuses saved real mode before starting a stand-in journey`, refuseRealMode);
}

async function packageCaptureRefusesRealMode() {
  const command = { script: '../package/capture.mjs', args: ['fresh-1-'] };
  const result = await invoke(command, undefined, '1', true);
  assert.notEqual(result.status, 0);
  assert.equal(result.reads, 'settings read\n', result.output);
  assert.match(result.output, /This journey requires the stand-in model/u);
}

test('package browser capture refuses a saved real-mode stack', packageCaptureRefusesRealMode);
