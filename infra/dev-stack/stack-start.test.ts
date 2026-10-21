import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

type StartOptions = {
  failure?: string;
  signal?: 'SIGINT' | 'SIGTERM';
  previousMode?: '0' | '1';
};

async function ownerStart(start: StartOptions = {}) {
  const home = await mkdtemp(`${tmpdir()}/owner-start-fixture-`);
  const directory = `${home}/stack`;
  await mkdir(directory);
  try {
    if (start.previousMode !== undefined) {
      await writeFile(`${directory}/settings.env`, `DEV_REAL_PROVIDER=${start.previousMode}\n`);
    }
    const environment = {
      HOME: home,
      PATH: '/nonexistent',
      DEV_STACK_DIR: directory,
      DEV_STACK_ID: 'owner',
      DEV_REAL_PROVIDER_FILE: '/synthetic-key-file',
      START_FAILURE: start.failure ?? '',
      START_SIGNAL: start.signal ?? '',
    };
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/stack-start-preload.mjs', 'infra/dev-stack/stack.ts',
      'up', '--owner-run', '--fresh'];
    const options = { env: environment, encoding: 'utf8' as const, timeout: 15_000 };
    const result = spawnSync(process.execPath, args, options);
    assert.ifError(result.error);
    let operations: string;
    try {
      operations = await readFile(`${home}/operations`, 'utf8');
    } catch {
      throw new Error(result.stdout + result.stderr);
    }
    const settings = await readFile(`${directory}/settings.env`, 'utf8');
    const serviceText = await readFile(`${home}/services.json`, 'utf8');
    const services = JSON.parse(serviceText) as {
      processes: string[]; containers: string[]; switchedOn: boolean;
    };
    return { status: result.status, output: result.stdout + result.stderr,
      operations, settings, services };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function ownerReadiness() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output + result.operations);
  assert.match(result.output, /Stack ready: https:\/\/owner.example.test\/org\/integrations/u);
  assert.equal(result.operations.includes('infra/dev-stack/journey.ts'), false);
  assert.match(result.operations, /health .*\/healthz\/ready/u);
}

test('an authorised owner real start reports readiness without an automated journey', ownerReadiness);

async function modeSavedAfterChecks() {
  const result = await ownerStart();
  assert.equal(result.status, 0, result.output);
  assert.match(result.operations, /mode-at-provider-check stub/u);
  assert.match(result.settings, /DEV_REAL_PROVIDER=1/u);
}

test('real mode is saved only after the infrastructure and provider checks', modeSavedAfterChecks);

function assertRestored(result: Awaited<ReturnType<typeof ownerStart>>, mode?: string) {
  assert.equal(result.status, 1, result.output);
  const modeLine = result.settings.split('\n').find(isModeLine);
  assert.equal(modeLine, mode === undefined ? undefined : `DEV_REAL_PROVIDER=${mode}`);
  assert.deepEqual(result.services.processes, []);
  assert.deepEqual(result.services.containers, []);
}

function isModeLine(line: string) {
  return line.startsWith('DEV_REAL_PROVIDER=');
}

async function failedStartRestoresMode() {
  for (const previousMode of [undefined, '0', '1'] as const) {
    for (const failure of ['infrastructure-check', 'saved-real-mode', 'after-switch-on']) {
      const options: StartOptions = { failure };
      if (previousMode !== undefined) options.previousMode = previousMode;
      const result = await ownerStart(options);
      assert.match(result.operations, new RegExp(failure, 'u'));
      assertRestored(result, previousMode);
    }
  }
}

test('failed owner starts restore each previous mode and stop launched services',
  failedStartRestoresMode);

async function interruptedStartRestoresMode() {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const result = await ownerStart({ signal, previousMode: '0' });
    assert.equal(result.services.switchedOn, true);
    assertRestored(result, '0');
  }
}

test('interruptions after switch-on restore the previous mode and stop launched services',
  interruptedStartRestoresMode);
