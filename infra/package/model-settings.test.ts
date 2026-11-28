import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRuntimeSettings, checkModelSecrets } from './model-settings.ts';

function preparesRestrictedQualification() {
  const models = { mode: 'provider' as const, qualification: true };
  const settings = modelRuntimeSettings(models);
  assert.equal(settings['MODEL_UPSTREAM'], 'model-qualification:43003');
  assert.equal(settings['MODEL_KEY_FILE'], undefined);
  assert.equal(settings['MODEL_STUB_PORT'], undefined);
  const data = { MODEL_UPSTREAM: Buffer.from(settings['MODEL_UPSTREAM']!).toString('base64') };
  assert.doesNotThrow(() => checkModelSecrets('runtime', { data }, models));
  data.MODEL_UPSTREAM = Buffer.from('api.openai.com:443').toString('base64');
  assert.throws(() => checkModelSecrets('runtime', { data }, models));
}
test('provider qualification prepares only the fixed separate stand-in without a fallback key',
  preparesRestrictedQualification);

function refusesEmbeddedStandInCredentials(): void {
  const models = { mode: 'provider' as const, qualification: true };
  const upstream = Buffer.from('model-qualification:43003');
  const data = { MODEL_UPSTREAM: upstream.toString('base64'), MODEL_KEY_FILE: 'embedded-key' };
  const stored = { data };
  function checkRuntime(): void {
    checkModelSecrets('runtime', stored, models);
  }
  assert.throws(checkRuntime, /Provider mode refuses stand-in settings/u);
}

test('provider qualification refuses an embedded stand-in key even with the allowed upstream',
  refusesEmbeddedStandInCredentials);

function keepsStubSecretRequirements(): void {
  const models = { mode: 'stub' as const };
  const stored = { data: {} };
  function checkRuntime(): void {
    checkModelSecrets('runtime', stored, models);
  }
  function checkFiles(): void {
    checkModelSecrets('runtimeFiles', stored, models);
  }
  assert.throws(checkRuntime, /Required secret field is absent: runtime.MODEL_UPSTREAM/u);
  assert.throws(checkFiles, /Required secret field is absent: runtimeFiles.model-stub-key/u);
}

test('the stand-in still requires its runtime settings and private key', keepsStubSecretRequirements);
