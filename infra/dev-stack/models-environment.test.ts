import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelsEnvironment } from './models-environment.ts';

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
