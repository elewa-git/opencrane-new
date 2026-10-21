import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { checkProviderMode, modelsEnvironment, startupCeilings } from './models-environment.ts';

async function paidStartupFixture() {
  const home = await mkdtemp(`${tmpdir()}/paid-startup-fixture-`);
  const directory = `${home}/stack`;
  await mkdir(directory);
  const environment = {
    HOME: home,
    PATH: '/nonexistent',
    DEV_STACK_DIR: directory,
    DEV_STACK_ID: 'owner',
    DEV_REAL_PROVIDER_FILE: '/synthetic-key-file',
    DEMO_ALLOWANCE_CENTS: '600',
  };
  const args = ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/stack-start-preload.mjs', 'infra/dev-stack/stack.ts',
    'up', '--owner-run', '--fresh'];
  const options = { env: environment, encoding: 'utf8' as const, timeout: 15_000 };
  const result = spawnSync(process.execPath, args, options);
  try {
    assert.ifError(result.error);
    const operations = await readFile(`${home}/operations`, 'utf8');
    const eventText = await readFile(`${home}/budget-event.json`, 'utf8');
    return { status: result.status, output: result.stdout + result.stderr,
      operations, event: JSON.parse(eventText) as Record<string, unknown> };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function writesApprovedBudgetBeforeProviderVerification() {
  const result = await paidStartupFixture();
  assert.equal(result.status, 0, result.output + result.operations);
  assert.equal(result.event['type'], 'budget.ceiling_set');
  assert.equal(result.event['subject'], 'budget-fixture');
  const approvedBudgetEventData = {
    scope: 'global', ceilingCents: 600, dailyCeilingCents: 600, setBy: 'dev-stack',
  };
  assert.deepEqual(result.event['data'], approvedBudgetEventData);
  const budgetEventPosition = result.operations.indexOf('initial-budget-event');
  const providerVerificationPosition = result.operations.indexOf('provider-verification');
  assert(budgetEventPosition >= 0);
  assert(providerVerificationPosition > budgetEventPosition);
}
test('paid startup writes the approved budget before provider verification',
  writesApprovedBudgetBeforeProviderVerification);

function checksBothModes() {
  const inherited = { MODEL_KEY_FILE: '/must-not-survive/.keys/provider', MODEL_UPSTREAM: 'local' };
  const legacy = modelsEnvironment(inherited, '/private', false);
  assert.equal(legacy['MODEL_KEY_FILE'], '/private/model-stub-key');
  assert.equal(legacy['PROVIDER_SECRETS_DIR'], '/private/provider-secrets');
  const managed = modelsEnvironment(inherited, '/private', true);
  assert.equal(managed['PROVIDER_SECRETS_DIR'], '/private/provider-secrets');
  assert.equal(managed['MODEL_UPSTREAM'], 'local');
  assert.equal(Object.hasOwn(managed, 'MODEL_KEY_FILE'), false);
  assert.equal(JSON.stringify(managed).includes('.keys'), false);
}
test('models receives shared custody and only legacy mode receives the stub file', checksBothModes);

function realProviderEnvironment() {
  const inherited = {
    MODEL_UPSTREAM: 'local',
    MODEL_KEY_FILE: '/synthetic/private',
    DEV_REAL_PROVIDER: '1',
  };
  for (const managed of [false, true]) {
    const real = modelsEnvironment(inherited, '/private', managed, true);
    assert.equal(Object.hasOwn(real, 'MODEL_UPSTREAM'), false);
    assert.equal(Object.hasOwn(real, 'MODEL_KEY_FILE'), !managed);
    assert.equal(real['DEV_REAL_PROVIDER'], '1');
    const stub = modelsEnvironment(inherited, '/private', managed);
    assert.equal(stub['MODEL_UPSTREAM'], 'local');
    assert.equal(Object.hasOwn(stub, 'DEV_REAL_PROVIDER'), false);
  }
  assert.equal(inherited.MODEL_UPSTREAM, 'local');
  assert.equal(inherited.DEV_REAL_PROVIDER, '1');
}
test('real opt-in removes upstream overrides without changing later stub starts',
  realProviderEnvironment);

function isolatesSavedMode() {
  checkProviderMode({}, false);
  checkProviderMode({ DEV_REAL_PROVIDER: '1' }, true);
  function realToStub() {
    checkProviderMode({ DEV_REAL_PROVIDER: '1' }, false);
  }
  function stubToReal() {
    checkProviderMode({}, true);
  }
  assert.throws(realToStub, /Provider mode change requires a fresh stack/u);
  assert.throws(stubToReal, /Provider mode change requires a fresh stack/u);
}
test('repeat startup refuses changing the saved provider mode', isolatesSavedMode);

function boundsPaidStartup() {
  assert.deepEqual(startupCeilings(true, '600'), {
    ceilingCents: 600, dailyCeilingCents: 600,
  });
  assert.deepEqual(startupCeilings(true, undefined), {
    ceilingCents: 2000, dailyCeilingCents: 2000,
  });
  assert.deepEqual(startupCeilings(false, undefined), {
    ceilingCents: 20000, dailyCeilingCents: 4000,
  });
  for (const allowance of ['', '0', '-1', '600.5', '2001', 'invalid']) {
    function invalidAllowance() {
      startupCeilings(true, allowance);
    }
    assert.throws(invalidAllowance, /Invalid demo allowance/u);
  }
}
test('paid startup applies the approved allowance before provider verification', boundsPaidStartup);
