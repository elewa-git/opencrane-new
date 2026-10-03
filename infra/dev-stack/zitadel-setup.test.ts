import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('secondary setup keeps the owner app unchanged and reuses its own private credentials after teardown', async () => {
  const home = await mkdtemp(`${tmpdir()}/dev-stack-zitadel-`);
  const directory = `${home}/.config/opencrane/dev-stack-1`;
  const providerFile = `${home}/provider.json`;
  const ownerApp = { id: '393311211707436433', name: 'OpenCrane 2 Dev Web',
    details: { resourceOwner: '393311211338337681' }, oidcConfig: {
      clientId: '393311211707501969', devMode: false,
      redirectUris: ['https://ocn-dev.tail00285e.ts.net/auth/callback'],
      postLogoutRedirectUris: ['https://ocn-dev.tail00285e.ts.net/'],
    } };
  await writeFile(providerFile, JSON.stringify({ apps: { [ownerApp.id]: ownerApp }, users: {} }));
  await writeFile(`${home}/pat`, 'fake-test-pat');
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: '1',
    ZITADEL_KEY_FILE: `${home}/pat`, MOCK_ZITADEL_FILE: providerFile };
  const setup = () => exec(process.execPath, ['--experimental-strip-types', '--import',
    './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts'], { env });
  try {
    const first = await setup();
    const state = JSON.parse(await readFile(providerFile, 'utf8'));
    assert.deepEqual(state.apps[ownerApp.id], ownerApp);
    const config = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8'));
    assert.equal(config.clientId, 'ci-client');
    assert.deepEqual(state.apps[config.appId].oidcConfig.redirectUris, ['http://127.0.0.1:25106/auth/callback']);
    assert.deepEqual(state.apps[config.appId].oidcConfig.postLogoutRedirectUris, ['http://127.0.0.1:25106/']);
    assert.equal(state.apps[config.appId].oidcConfig.devMode, true);
    const credentials: Record<string, string> = {};
    for (const name of ['client-secret', 'owner-password', 'member-password']) {
      const path = `${directory}/zitadel-${name}`;
      credentials[name] = await readFile(path, 'utf8');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.ok(!`${first.stdout}${first.stderr}`.includes(credentials[name]!));
    }
    for (const role of ['owner', 'member']) {
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
    for (const [name, value] of Object.entries(credentials)) {
      assert.equal(await readFile(`${directory}/zitadel-${name}`, 'utf8'), value);
    }
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
