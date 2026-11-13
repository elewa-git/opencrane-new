import assert from 'node:assert/strict';
import { readFile, rm, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { createZitadelFixture, secondaryOwnerApp } from './test/zitadel-fixture.ts';

async function credentialFailure() {
  const state = { apps: {}, users: {} };
  const fixture = await createZitadelFixture(state);
  async function setup() {
    const env = { ...fixture.env, ZITADEL_KEY_FILE: `${fixture.home}/missing-private-key` };
    return fixture.setup(env);
  }
  function checkFailure(error: unknown) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Zitadel credentials unavailable \(ENOENT\)/u);
    assert.match(error.message, /set ZITADEL_KEY_FILE/u);
    assert.match(error.message, /no request sent/u);
    assert.ok(!error.message.includes(fixture.home));
    return true;
  }
  try {
    await assert.rejects(setup, checkFailure);
    assert.deepEqual(await fixture.readState(), state);
  } finally {
    await fixture.close();
  }
}

async function providerFailure() {
  const secret = 'fake-private-credential';
  const state = { apps: {}, users: {}, failure: { status: 403,
    body: { code: 7, message: `Permission denied: ${secret}`, details: { token: secret } } } };
  const fixture = await createZitadelFixture(state);
  function checkFailure(error: unknown) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Zitadel GET \/management\/v1\/orgs\/me returned HTTP 403; code 7/u);
    assert.ok(!error.message.includes(secret));
    assert.ok(!error.message.includes('Permission denied'));
    return true;
  }
  try {
    await assert.rejects(fixture.setup, checkFailure);
    assert.deepEqual(await fixture.readState(), state);
  } finally {
    await fixture.close();
  }
}

async function reuseCredentialReference() {
  const initial = { apps: { [secondaryOwnerApp.id]: secondaryOwnerApp }, users: {} };
  const fixture = await createZitadelFixture(initial);
  const savedReferenceEnv: NodeJS.ProcessEnv = { ...fixture.env };
  delete savedReferenceEnv['ZITADEL_KEY_FILE'];
  try {
    await fixture.setup();
    const state = await fixture.readState();
    await rm(fixture.directory, { recursive: true });
    const result = await fixture.setup(savedReferenceEnv);
    assert.deepEqual(await fixture.readState(), state);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fake-private-credential'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(fixture.home));
    const referenceFile = `${fixture.home}/.config/opencrane/dev-stack-ci-1/zitadel-key-file`;
    assert.equal(await readFile(referenceFile, 'utf8'), fixture.env.ZITADEL_KEY_FILE);
    assert.equal((await stat(referenceFile)).mode & 0o777, 0o600);
    const otherSlotEnv = { ...savedReferenceEnv, DEV_STACK_ID: '2' };
    async function otherSlot() {
      return fixture.setup(otherSlotEnv);
    }
    await assert.rejects(otherSlot, /Zitadel credentials unavailable/u);
    assert.deepEqual(await fixture.readState(), state);
    async function invalidExplicitKey() {
      return fixture.setup({ ...fixture.env, ZITADEL_KEY_FILE: `${fixture.home}/missing-key` });
    }
    await assert.rejects(invalidExplicitKey, /Zitadel credentials unavailable/u);
    await rm(fixture.env.ZITADEL_KEY_FILE);
    async function missingSavedKey() {
      const env = { ...savedReferenceEnv, MOCK_ZITADEL_DEFAULT_KEY_PRESENT: '1' };
      return fixture.setup(env);
    }
    await assert.rejects(missingSavedKey, /Zitadel credentials unavailable/u);
    assert.deepEqual(await fixture.readState(), state);
  } finally {
    await fixture.close();
  }
}

async function unreadableProviderCode() {
  const failures = [
    { status: 502, rawBody: 'private proxy body fake-private-credential' },
    { status: 429, body: { code: 'fake-private-credential', message: 'private provider text' } },
  ];
  for (const failure of failures) {
    const fixture = await createZitadelFixture({ failure });
    function checkFailure(error: unknown) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`returned HTTP ${failure.status}; code unavailable`));
      assert.ok(!error.message.includes('fake-private-credential'));
      assert.ok(!error.message.includes('private'));
      return true;
    }
    try {
      await assert.rejects(fixture.setup, checkFailure);
    } finally {
      await fixture.close();
    }
  }
}

async function transportFailure() {
  const state = { failure: { networkError: 'private transport cause fake-private-credential' } };
  const fixture = await createZitadelFixture(state);
  function checkFailure(error: unknown) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Zitadel GET \/management\/v1\/orgs\/me failed before an HTTP response/u);
    assert.ok(!error.message.includes('fake-private-credential'));
    assert.ok(!error.message.includes('private transport cause'));
    return true;
  }
  try {
    await assert.rejects(fixture.setup, checkFailure);
  } finally {
    await fixture.close();
  }
}

async function untrustedEndpoint() {
  const appId = 'private-provider-value\nInjected log line';
  const failurePath = '/management/v1/projects/393311211539664273/apps/' +
    'private-provider-valueInjected%20log%20line';
  const state = { apps: { [secondaryOwnerApp.id]: secondaryOwnerApp,
    secondary: { id: appId, name: 'OpenCrane 2 Dev CI 1' } }, users: {},
  failure: { path: failurePath, status: 403, body: { code: 7 } } };
  const fixture = await createZitadelFixture(state);
  function checkFailure(error: unknown) {
    assert.ok(error instanceof Error);
    assert.match(error.message, /returned HTTP 403; code 7/u);
    assert.ok(!error.message.includes('private-provider-value'));
    assert.ok(!error.message.includes('Injected log line'));
    return true;
  }
  try {
    await assert.rejects(fixture.setup, checkFailure);
    assert.deepEqual(await fixture.readState(), state);
  } finally {
    await fixture.close();
  }
}

test('setup identifies an unavailable key without exposing its path or sending a request',
  credentialFailure);
test('setup reports the provider endpoint, HTTP status and code without its private body',
  providerFailure);
test('fresh setup reuses its slot key-file reference and provider objects, never another slot',
  reuseCredentialReference);
test('transport failures identify the attempted endpoint without exposing their private cause',
  transportFailure);
test('provider identifiers cannot expose private text or inject log lines in diagnostics',
  untrustedEndpoint);
test('non-JSON responses and untrusted error codes retain only the safe HTTP status',
  unreadableProviderCode);
