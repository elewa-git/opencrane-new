import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('owner restore removes secondary redirects, preserves other settings, and refuses a foreign app', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-owner-restore-`);
  const providerFile = `${home}/provider.json`;
  const desired = { devMode: false, redirectUris: ['https://ocn-dev.tail00285e.ts.net/auth/callback'],
    postLogoutRedirectUris: ['https://ocn-dev.tail00285e.ts.net/'] };
  const ownerApp = { id: '393311211707436433', name: 'OpenCrane 2 Dev Web',
    details: { resourceOwner: '393311211338337681' }, oidcConfig: {
      clientId: '393311211707501969', isCompliance: true, complianceProblems: [], allowedOrigins: [],
      responseTypes: ['OIDC_RESPONSE_TYPE_CODE'], grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE'],
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_POST', idTokenUserinfoAssertion: true, clockSkew: '0s',
      devMode: true,
      redirectUris: [...desired.redirectUris, 'http://127.0.0.1:25106/auth/callback', 'http://127.0.0.1:25206/auth/callback'],
      postLogoutRedirectUris: [...desired.postLogoutRedirectUris, 'http://127.0.0.1:25106/', 'http://127.0.0.1:25206/'],
    } };
  const initial = { apps: { [ownerApp.id]: ownerApp, secondary: { name: 'untouched' } }, users: {} };
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: 'owner',
    ZITADEL_KEY_FILE: `${home}/pat`, MOCK_ZITADEL_FILE: providerFile };
  const restore = (stack = 'owner') => exec(process.execPath, ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts', '--restore-owner-app'],
  { env: { ...env, DEV_STACK_ID: stack } });
  try {
    await writeFile(providerFile, JSON.stringify(initial));
    await writeFile(`${home}/pat`, 'fake-test-pat');
    const first = await restore();
    const expectedOwnerApp = { ...ownerApp,
      oidcConfig: { ...ownerApp.oidcConfig, ...desired } };
    const expected = { ...initial, apps: { ...initial.apps,
      [ownerApp.id]: expectedOwnerApp }, updates: 1 };
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), expected);
    const receipt = JSON.parse(first.stdout);
    assert.equal(receipt.changed, true);
    assert.deepEqual(receipt.after, desired);
    assert.ok(!`${first.stdout}${first.stderr}`.includes('fake-test-pat'));
    assert.equal(JSON.parse((await restore()).stdout).changed, false);
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), expected);
    for (const value of [false, undefined, 'true']) {
      const config = { ...expectedOwnerApp.oidcConfig,
        idTokenUserinfoAssertion: value };
      const app = { ...expected.apps[ownerApp.id], oidcConfig: config };
      const refused = { ...expected, apps: { ...expected.apps, [ownerApp.id]: app } };
      const refusedJson = JSON.stringify(refused);
      await writeFile(providerFile, refusedJson);
      await assert.rejects(restore(), /must have idTokenUserinfoAssertion=true/u);
      const savedJson = await readFile(providerFile, 'utf8');
      const savedState = JSON.parse(savedJson);
      const refusedState = JSON.parse(refusedJson);
      assert.deepEqual(savedState, refusedState);
    }
    await writeFile(providerFile, JSON.stringify(expected));
    // Owner repair needs neither stack ownership nor stored client/user credentials.
    await assert.rejects(stat(`${home}/.config/opencrane/dev-stack`));
    await assert.rejects(restore('1'));
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), expected);
    for (const foreign of [
      { ...ownerApp, details: { resourceOwner: 'another-org' } },
      { ...ownerApp, oidcConfig: { ...ownerApp.oidcConfig, clientId: 'another-client' } },
    ]) {
      const state = { ...initial, apps: { ...initial.apps, [ownerApp.id]: foreign } };
      await writeFile(providerFile, JSON.stringify(state));
      await assert.rejects(restore());
      assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), state);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test('secondary setup keeps the owner app unchanged and reuses its own private credentials after teardown', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-zitadel-`);
  const directory = `${home}/.config/opencrane/dev-stack-1`;
  const providerFile = `${home}/provider.json`;
  const ownerApp = { id: '393311211707436433', name: 'OpenCrane 2 Dev Web',
    details: { resourceOwner: '393311211338337681' }, oidcConfig: {
      clientId: '393311211707501969', devMode: false, idTokenUserinfoAssertion: true,
      redirectUris: ['https://ocn-dev.tail00285e.ts.net/auth/callback'],
      postLogoutRedirectUris: ['https://ocn-dev.tail00285e.ts.net/'],
    } };
  await writeFile(providerFile, JSON.stringify({ apps: { [ownerApp.id]: ownerApp }, users: {} }));
  await writeFile(`${home}/pat`, 'fake-test-pat');
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: '1',
    ZITADEL_KEY_FILE: `${home}/pat`, MOCK_ZITADEL_FILE: providerFile };
  const setup = () => exec(process.execPath, ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts'], { env });
  const readOnlySetup = () => exec(process.execPath, ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts',
    '--read-only'], { env });
  try {
    for (const value of [false, undefined, 'true']) {
      const refused = { apps: { [ownerApp.id]: { ...ownerApp,
        oidcConfig: { ...ownerApp.oidcConfig, idTokenUserinfoAssertion: value } } }, users: {} };
      const refusedJson = JSON.stringify(refused);
      await writeFile(providerFile, refusedJson);
      await assert.rejects(setup(), /must have idTokenUserinfoAssertion=true/u);
      const savedJson = await readFile(providerFile, 'utf8');
      const savedState = JSON.parse(savedJson);
      const refusedState = JSON.parse(refusedJson);
      assert.deepEqual(savedState, refusedState);
    }
    await writeFile(providerFile, JSON.stringify({ apps: { [ownerApp.id]: ownerApp }, users: {} }));
    const first = await setup();
    const state = JSON.parse(await readFile(providerFile, 'utf8'));
    assert.deepEqual(state.apps[ownerApp.id], ownerApp);
    const config = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
    assert.equal(config.clientId, 'ci-client');
    assert.deepEqual(state.apps[config.appId].oidcConfig.redirectUris, ['http://127.0.0.1:25106/auth/callback']);
    assert.deepEqual(state.apps[config.appId].oidcConfig.postLogoutRedirectUris, ['http://127.0.0.1:25106/']);
    assert.equal(state.apps[config.appId].oidcConfig.devMode, true);
    const credentials: Record<string, string> = {};
    for (const name of ['client-secret', 'owner-password', 'member-password', 'without-assistant-password',
      'wrong-account-password']) {
      const path = `${directory}/zitadel-${name}`;
      credentials[name] = await readFile(path, 'utf8');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok(!`${first.stdout}${first.stderr}`.includes(credentials[name]!));
    }
    assert.equal(state.directoryRoles, undefined);
    await assert.rejects(stat(`${directory}/zitadel-directory-key`));
    await assert.rejects(stat(`${home}/.config/opencrane/dev-stack-ci-1/zitadel-directory-key`));
    for (const role of ['owner', 'member', 'without-assistant', 'wrong-account']) {
      assert.equal(config.users[role].login, `opencrane2-dev-ci-1-${role}`);
      assert.equal(state.users[config.users[role].id].password, credentials[`${role}-password`]);
    }
    await exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval',
      "import { generate } from './infra/dev-stack/config.ts'; await generate('http://127.0.0.1:25106');"], { env });
    const auth = await readFile(`${directory}/auth.env`, 'utf8');
    assert.ok(auth.includes('OIDC_CLIENT_ID=ci-client\n'), 'The server must use the secondary client ID');
    await rm(directory, { recursive: true });
    await setup();
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), state);
    await rm(directory, { recursive: true });
    await readOnlySetup();
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), state);
    const missingApp = structuredClone(state);
    delete missingApp.apps[config.appId];
    await writeFile(providerFile, JSON.stringify(missingApp));
    await assert.rejects(readOnlySetup(), /requires the existing secondary app/u);
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), missingApp);
    const missingUser = structuredClone(state);
    delete missingUser.users[config.users.owner.id];
    await writeFile(providerFile, JSON.stringify(missingUser));
    await assert.rejects(readOnlySetup(), /requires existing secondary test users/u);
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), missingUser);
    await writeFile(providerFile, JSON.stringify(state));
    for (const [name, value] of Object.entries(credentials)) {
      assert.equal(await readFile(`${directory}/zitadel-${name}`, 'utf8'), value);
    }
    for (const value of [false, undefined, 'true']) {
      const refused = structuredClone(state);
      if (value === undefined) {
        delete refused.apps[config.appId].oidcConfig.idTokenUserinfoAssertion;
      } else {
        refused.apps[config.appId].oidcConfig.idTokenUserinfoAssertion = value;
      }
      const refusedJson = JSON.stringify(refused);
      await writeFile(providerFile, refusedJson);
      await assert.rejects(setup(), /must have idTokenUserinfoAssertion=true/u);
      const savedJson = await readFile(providerFile, 'utf8');
      const savedState = JSON.parse(savedJson);
      const refusedState = JSON.parse(refusedJson);
      assert.deepEqual(savedState, refusedState);
    }
    await writeFile(providerFile, JSON.stringify(state));
    // Refuse an existing app with broad redirects without rewriting its config.
    state.apps[config.appId].oidcConfig.redirectUris = ['http://127.0.0.1:*/auth/callback'];
    await writeFile(providerFile, JSON.stringify(state));
    await assert.rejects(setup());
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), state);
    state.apps[config.appId].oidcConfig.redirectUris = ['http://127.0.0.1:25106/auth/callback'];
    await writeFile(providerFile, JSON.stringify(state));
    await rm(`${home}/.config/opencrane/dev-stack-ci-1/zitadel-client-secret`);
    await assert.rejects(setup());
    assert.deepEqual(JSON.parse(await readFile(providerFile, 'utf8')), state);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
