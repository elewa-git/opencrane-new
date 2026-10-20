import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

async function cliFixture() {
  const directory = await mkdtemp(`${tmpdir()}/demo-seed-cli-`);
  const scripts = `${directory}/infra/dev-stack`;
  await mkdir(scripts, { recursive: true });
  await writeFile(`${directory}/package.json`, '{"type":"module"}');
  await symlink(resolve('node_modules'), `${directory}/node_modules`);
  await symlink(resolve('libs'), `${directory}/libs`);
  for (const file of ['demo-seed-run.ts', 'demo-seed.ts', 'config.ts', 'identity.ts']) {
    await copyFile(`infra/dev-stack/${file}`, `${scripts}/${file}`);
  }
  const identities = { extraIdentities: [{ subject: 'synthetic-owner' }] };
  await writeFile(`${scripts}/zitadel.json`, JSON.stringify(identities));
  async function prepare(id: string, origin: string, marker?: string) {
    const stack = `${directory}/.config/opencrane/dev-stack-${id}`;
    await mkdir(stack, { recursive: true });
    await writeFile(`${stack}/stack-owner`, marker ?? `worktree=${directory}\npid=123\n`);
    await writeFile(`${stack}/settings.env`, `ORIGIN=${origin}\n`);
    await writeFile(`${stack}/client-secret`, 'synthetic-client-secret');
    const settings = [
      'OIDC_ISSUER_URL=https://identity.invalid',
      'OIDC_CLIENT_ID=synthetic-client',
      `OIDC_REDIRECT_URI=${origin}/auth/callback`,
      'OIDC_COOKIE_SECRET=synthetic-cookie-secret-with-at-least-32-bytes',
      'OIDC_EXPECTED_ORG_ID=synthetic-organisation',
      `OIDC_CLIENT_SECRET_FILE=${stack}/client-secret`,
    ];
    await writeFile(`${stack}/auth.env`, settings.join('\n'));
  }
  async function run(id?: string) {
    const record = `${directory}/record`;
    await writeFile(record, '');
    const env = { HOME: directory, PATH: '/usr/bin:/bin', DEV_STACK_ID: id, DEMO_RECORD: record };
    const options = { env, cwd: directory, encoding: 'utf8' as const, timeout: 15_000 };
    const preload = resolve('infra/dev-stack/test/demo-seed-preload.mjs');
    const args = ['--experimental-strip-types', '--import', preload, `${scripts}/demo-seed-run.ts`];
    const result = spawnSync(process.execPath, args, options);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    const calls = await readFile(record, 'utf8');
    return { ...result, calls };
  }
  async function close() {
    await rm(directory, { recursive: true, force: true });
  }
  return { directory, prepare, run, close };
}

async function validatesIdBeforeConfiguration() {
  const fixture = await cliFixture();
  try {
    for (const id of [undefined, '', 'owner', '3']) {
      const result = await fixture.run(id);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Demo seed incomplete/u);
      assert.equal(result.calls, '');
    }
  } finally {
    await fixture.close();
  }
}

async function refusesForeignWorktree() {
  const fixture = await cliFixture();
  try {
    for (const marker of ['/another/worktree', 'worktree=/another/worktree\npid=123\n']) {
      await fixture.prepare('1', 'http://127.0.0.1:25106', marker);
      const result = await fixture.run('1');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Demo seed incomplete/u);
      assert.equal(result.calls, 'configuration loaded\n');
    }
  } finally {
    await fixture.close();
  }
}

async function refusesWrongOrigin() {
  const fixture = await cliFixture();
  try {
    const origins = ['http://127.0.0.1:25206', 'http://127.0.0.1:44200', 'https://remote.invalid'];
    for (const origin of origins) {
      await fixture.prepare('1', origin);
      const result = await fixture.run('1');
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Demo seed incomplete/u);
      assert.equal(result.calls, 'configuration loaded\n');
    }
  } finally {
    await fixture.close();
  }
}

async function seedsOwnedSecondaryOrigins() {
  const fixture = await cliFixture();
  try {
    const slots = [
      { id: '1', origin: 'http://127.0.0.1:25106', marker: fixture.directory },
      { id: '2', origin: 'http://127.0.0.1:25206', marker: `worktree=${fixture.directory}\npid=123\n` },
    ];
    for (const slot of slots) {
      await fixture.prepare(slot.id, slot.origin, slot.marker);
      const result = await fixture.run(slot.id);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /PASS demo groups and assistant saved/u);
      assert.ok(result.stdout.includes(`${slot.origin}/workspace`));
      const paths = [
        '/api/members/jente-rosseel',
        '/api/members/zitadel-member',
        '/api/groups/demo-acacia/changes/demo-acacia-create-v1',
        '/api/groups/demo-acacia/changes/demo-acacia-create-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-create-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-create-v1',
        '/api/groups/demo-acacia/changes/demo-acacia-jente-rosseel-v1',
        '/api/groups/demo-acacia/changes/demo-acacia-jente-rosseel-v1',
        '/api/groups/demo-acacia/changes/demo-acacia-zitadel-member-v1',
        '/api/groups/demo-acacia/changes/demo-acacia-zitadel-member-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-jente-rosseel-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-jente-rosseel-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-zitadel-member-v1',
        '/api/groups/demo-kijani/changes/demo-kijani-zitadel-member-v1',
        '/api/assistants/team-demo-acacia/changes/demo-acacia-assistant-v1',
        '/api/assistants/team-demo-acacia/changes/demo-acacia-assistant-v1',
      ];
      let expected = 'configuration loaded\n';
      for (const path of paths) {
        expected += `GET ${slot.origin}${path}\n`;
      }
      assert.equal(result.calls, expected);
    }
  } finally {
    await fixture.close();
  }
}

test('CLI refuses missing, owner and invalid ids before loading configuration',
  validatesIdBeforeConfiguration);
test('CLI refuses another worktree before making a product request', refusesForeignWorktree);
test('CLI refuses a different secondary, owner or remote origin', refusesWrongOrigin);
test('CLI seeds each owned secondary at its fixed origin with either owner marker format',
  seedsOwnedSecondaryOrigins);
