import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const generateScript = `
const config = await import('./infra/dev-stack/config.ts');
const { localOrigin } = await import('./infra/dev-stack/identity.ts');
await config.generate(localOrigin);
`;
function generate(home: string, id: string, supplied: NodeJS.ProcessEnv = {}) {
  const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: id, ...supplied };
  const options = { env, encoding: 'utf8' as const, timeout: 20_000 };
  const args = ['--experimental-strip-types', '--input-type=module', '--eval', generateScript];
  const result = spawnSync(process.execPath, args, options);
  assert.ifError(result.error);
  return result;
}
async function fixture(home: string, id: string) {
  const directory = `${home}/.config/opencrane/dev-stack-${id}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/zitadel.json`, JSON.stringify({
    issuer: 'https://sign-in.example.test', orgId: 'fixture', clientId: 'fixture',
    extraIdentities: [],
  }));
  await writeFile(`${directory}/zitadel-client-secret`, 'fixture-only');
  const emailFile = `${home}/.config/opencrane/dev-owner-email`;
  const fileOptions = { mode: 0o600 };
  await writeFile(emailFile, 'owner@example.test\n', fileOptions);
  return directory;
}
async function settings(directory: string, role: string) {
  const contents = await readFile(`${directory}/${role}.env`, 'utf8');
  const values: Record<string, string> = {};
  for (const line of contents.trim().split('\n')) {
    const separator = line.indexOf('=');
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}
async function separateSettings() {
  const home = await mkdtemp(`${tmpdir()}/private-settings-`);
  try {
    for (const id of ['1', '2']) {
      const directory = await fixture(home, id);
      const generated = generate(home, id);
      assert.equal(generated.status, 0, generated.stderr);
      const server = await settings(directory, 'server');
      const dispatcher = await settings(directory, 'dispatcher');
      const projection = await settings(directory, 'projection');
      for (const name of ['PERSONAL_KEY_DIRECTORY', 'MEMORY_KEY_DIRECTORY']) {
        const suffix = name === 'PERSONAL_KEY_DIRECTORY' ? 'personal-keys' : 'memory-keys';
        const path = `${directory}/${suffix}`;
        assert.equal(server[name], path);
        assert.equal(dispatcher[name], path);
        if (suffix === 'memory-keys') assert.equal(projection[name], path);
        const details = await stat(path);
        assert.equal(details.mode & 0o777, 0o700);
        assert.equal(details.uid, process.getuid!());
        await writeFile(`${path}/preserved`, 'encrypted-fixture');
        await writeFile(`${path}/deleted`, '');
      }
      assert.equal(projection['PERSONAL_KEY_DIRECTORY'], undefined);
      assert.equal((await settings(directory, 'command'))['MEMORY_KEY_DIRECTORY'], undefined);
      assert.equal(generate(home, id).status, 0);
      const ownerEmail = await readFile(`${home}/.config/opencrane/dev-owner-email`, 'utf8');
      assert.equal(ownerEmail.trim(), 'owner@example.test');
      const original = await readFile(`${directory}/server.env`, 'utf8');
      const aliased = original.replace(`${directory}/memory-keys`, `${directory}/conversation-keys`);
      await writeFile(`${directory}/server.env`, aliased);
      assert.notEqual(generate(home, id).status, 0, 'Refuse changed saved custody');
      assert.equal(await readFile(`${directory}/server.env`, 'utf8'), aliased);
      await writeFile(`${directory}/server.env`, original);
      for (const suffix of ['personal-keys', 'memory-keys']) {
        assert.equal(await readFile(`${directory}/${suffix}/preserved`, 'utf8'), 'encrypted-fixture');
        assert.equal((await stat(`${directory}/${suffix}/deleted`)).size, 0);
      }
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test('fresh slots share only their own private directories and retain contents on restart',
  separateSettings);

async function unsafePaths() {
  const home = await mkdtemp(`${tmpdir()}/private-refusal-`);
  try {
    const directory = await fixture(home, '1');
    const path = `${directory}/personal-keys`;
    for (const state of ['missing', 'file', 'symlink', 'unreadable', 'unsafe', 'foreign']) {
      const supplied = { PERSONAL_KEY_DIRECTORY: path };
      if (state === 'file') await writeFile(path, 'private-canary');
      if (state === 'symlink') await symlink(directory, path);
      if (state === 'unsafe' || state === 'unreadable') {
        await mkdir(path, { mode: state === 'unsafe' ? 0o755 : 0o000 });
      }
      if (state === 'foreign') supplied.PERSONAL_KEY_DIRECTORY = home;
      const result = generate(home, '1', supplied);
      assert.notEqual(result.status, 0, state);
      assert.doesNotMatch(result.stderr, /private-canary/u);
      if (state === 'file') assert.equal(await readFile(path, 'utf8'), 'private-canary');
      if (state === 'unsafe') assert.equal((await stat(path)).mode & 0o777, 0o755);
      if (state === 'unreadable') await chmod(path, 0o700);
      await rm(path, { recursive: true, force: true });
    }
    assert.equal(generate(home, '1').status, 0);
    await symlink(`${directory}/memory-keys`, `${directory}/conversation-keys`);
    assert.notEqual(generate(home, '1').status, 0, 'Refuse conversation custody aliases');
    await rm(`${directory}/conversation-keys`);
    await rm(`${directory}/memory-keys`, { recursive: true });
    assert.notEqual(generate(home, '1').status, 0, 'Never recreate lost custody');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
test('supplied unsafe or foreign paths and lost custody refuse without repair', unsafePaths);

async function suppliedOwnership() {
  const files = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { mock } = await import('node:test');
  const { preparePrivateDirectories } = await import('./private-directories.ts');
  const directory = await mkdtemp(`${tmpdir()}/private-owner-`);
  const settings = await preparePrivateDirectories(directory, true);
  const original = files.lstat;
  async function foreignOwner(path: Parameters<typeof original>[0]) {
    const details = await original(path);
    if (path === settings.PERSONAL_KEY_DIRECTORY) details.uid += 1;
    return details;
  }
  const mocked = mock.method(files, 'lstat', foreignOwner);
  syncBuiltinESMExports();
  try {
    await assert.rejects(preparePrivateDirectories(directory, true, settings), /unsafe/u);
    assert.equal((await stat(settings.PERSONAL_KEY_DIRECTORY)).mode & 0o777, 0o700);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
}
test('caller-supplied directories must belong to the current user', suppliedOwnership);

async function retainsOwnerEmailAfterTeardown() {
  const home = await mkdtemp(`${tmpdir()}/private-owner-email-`);
  const cleanup = { recursive: true, force: true };
  try {
    const directory = await fixture(home, '1');
    await rm(directory, cleanup);
    const script = `
const config = await import('./infra/dev-stack/config.ts');
console.log(await config.readOwnerEmail());
`;
    const args = ['--experimental-strip-types', '--input-type=module', '--eval', script];
    const env = { PATH: process.env['PATH'], HOME: home, DEV_STACK_ID: '1' };
    const options = { env, encoding: 'utf8' as const, timeout: 20_000 };
    const result = spawnSync(process.execPath, args, options);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'owner@example.test');
  } finally {
    await rm(home, cleanup);
  }
}

test('the private owner email survives deletion of a disposable stack',
  retainsOwnerEmailAfterTeardown);
