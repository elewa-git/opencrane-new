import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProviderMode, modelsEnvironment } from './models-environment.ts';

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
