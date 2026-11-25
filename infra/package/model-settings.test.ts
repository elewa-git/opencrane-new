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
