import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const orgId = '393311211338337681';
const ownerId = '378127409465593948';
function machine(slot: string) {
  const userName = `opencrane2-dev-ci-${slot}-directory`;
  return { id: `directory-${slot}`, userName, machine: {}, details: { resourceOwner: orgId } };
}
function initialState() {
  return {
    apps: {},
    users: { 'directory-1': machine('1'), 'directory-2': machine('2'),
      [ownerId]: { id: ownerId, userName: 'owner', human: {} } },
    members: {
      'directory-1': [{ userId: 'directory-1', roles: ['ORG_OWNER_VIEWER'] }],
      'directory-2': [{ userId: 'directory-2', roles: ['ORG_OWNER_VIEWER'] }],
    },
    keys: { 'directory-1': [{ id: 'key-1' }], 'directory-2': [{ id: 'key-2a' }, { id: 'key-2b' }] },
  };
}
async function fixture() {
  const home = await mkdtemp(`${tmpdir()}/directory-cleanup-`);
  const providerFile = `${home}/provider.json`;
  const retained = `${home}/.config/opencrane/dev-stack-ci-2`;
  const disposable = `${home}/.config/opencrane/dev-stack-2`;
  await mkdir(retained, { recursive: true });
  await mkdir(disposable, { recursive: true });
  await writeFile(`${retained}/zitadel-directory-key`, 'fake-directory-key');
  await writeFile(`${disposable}/zitadel-directory-key`, 'fake-directory-key');
  await writeFile(`${home}/pat`, 'fake-test-pat');
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: '2',
    ZITADEL_KEY_FILE: `${home}/pat`, MOCK_ZITADEL_FILE: providerFile };
  function cleanup(slot = '2') {
    const args = ['--experimental-strip-types', '--import',
      './infra/dev-stack/test/zitadel-provider.mjs', 'infra/dev-stack/zitadel-setup.ts',
      '--remove-directory'];
    const options = { env: { ...env, DEV_STACK_ID: slot } };
    return exec(process.execPath, args, options);
  }
  return { home, providerFile, retained, disposable, cleanup };
}

async function removesOnlyTheSelectedMachine() {
  const files = await fixture();
  try {
    const initial = initialState();
    await writeFile(files.providerFile, JSON.stringify(initial));
    const result = await files.cleanup();
    const expected = initialState();
    Reflect.deleteProperty(expected.users, 'directory-2');
    Reflect.deleteProperty(expected.members, 'directory-2');
    expected.keys['directory-2'] = [];
    assert.deepEqual(JSON.parse(await readFile(files.providerFile, 'utf8')), expected);
    const receipt = { organisation: 'PASS', membership: 'PASS', keys: 'PASS',
      user: 'PASS', localFiles: 'PASS' };
    assert.deepEqual(JSON.parse(result.stdout), receipt);
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fake-test-pat'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes('fake-directory-key'));
    await assert.rejects(stat(`${files.retained}/zitadel-directory-key`));
    await assert.rejects(stat(`${files.disposable}/zitadel-directory-key`));
    assert.deepEqual(JSON.parse((await files.cleanup()).stdout), receipt);
    assert.deepEqual(JSON.parse(await readFile(files.providerFile, 'utf8')), expected);
    await files.cleanup('1');
    Reflect.deleteProperty(expected.users, 'directory-1');
    Reflect.deleteProperty(expected.members, 'directory-1');
    expected.keys['directory-1'] = [];
    assert.deepEqual(JSON.parse(await readFile(files.providerFile, 'utf8')), expected);
  } finally {
    await rm(files.home, { recursive: true, force: true });
  }
}
test('removes the selected directory membership, keys, machine and local files; repeat is safe',
  removesOnlyTheSelectedMachine);

async function refusesUnsafeResources() {
  const files = await fixture();
  const state = initialState();
  const user = machine('2');
  const variants = [
    { ...state, org: { id: 'foreign', name: 'OpenCrane 2 Dev' } },
    { ...state, org: { id: orgId, name: 'Wrong name' } },
    { ...state, users: { ...state.users, 'directory-2': { ...user, machine: undefined, human: {} } } },
    { ...state, users: { ...state.users,
      'directory-2': { ...user, details: { resourceOwner: 'foreign' } } } },
    { ...state, users: { ...state.users, 'directory-2': { ...user, id: ownerId } } },
    { ...state, members: { ...state.members,
      'directory-2': [{ userId: ownerId, roles: ['ORG_OWNER_VIEWER'] }] } },
    { ...state, members: { ...state.members,
      'directory-2': [{ userId: user.id, roles: ['ORG_OWNER'] }] } },
    { ...state, keyCount: 3 },
  ];
  try {
    for (const variant of variants) {
      await writeFile(files.providerFile, JSON.stringify(variant));
      await assert.rejects(files.cleanup());
      const stored = JSON.parse(await readFile(files.providerFile, 'utf8'));
      assert.deepEqual(stored, JSON.parse(JSON.stringify(variant)));
      assert.equal(await readFile(`${files.retained}/zitadel-directory-key`, 'utf8'),
        'fake-directory-key');
    }
    await writeFile(files.providerFile, JSON.stringify(state));
    await assert.rejects(files.cleanup('owner'));
    assert.deepEqual(JSON.parse(await readFile(files.providerFile, 'utf8')), state);
    await rm(files.retained, { recursive: true });
    await symlink(files.disposable, files.retained);
    await assert.rejects(files.cleanup());
    assert.deepEqual(JSON.parse(await readFile(files.providerFile, 'utf8')), state);
    assert.equal(await readFile(`${files.disposable}/zitadel-directory-key`, 'utf8'),
      'fake-directory-key');
  } finally {
    await rm(files.home, { recursive: true, force: true });
  }
}
test('refuses wrong organisations, humans, owner ids, unexpected roles, incomplete keys and links',
  refusesUnsafeResources);
