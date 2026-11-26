import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile }
  from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function prepare(directory) {
  return spawnSync(process.execPath, ['infra/package/provider-secrets.mjs', directory],
    { encoding: 'utf8' });
}

async function repairsRemountedKeys() {
  const directory = await mkdtemp(join(tmpdir(), 'provider-modes-'));
  const keys = join(directory, 'keys');
  const file = join(keys, 'a'.repeat(64));
  try {
    await mkdir(keys, { mode: 0o700 });
    await writeFile(file, 'synthetic-provider-credential', { mode: 0o600 });
    await chmod(keys, 0o2770);
    await chmod(file, 0o660);
    const result = prepare(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(keys)).mode & 0o7777, 0o700);
    assert.equal((await lstat(file)).mode & 0o7777, 0o600);
    assert.equal(await readFile(file, 'utf8'), 'synthetic-provider-credential');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('startup repairs private key modes widened by a volume remount', repairsRemountedKeys);

async function refusesLinkedCustody() {
  const directory = await mkdtemp(join(tmpdir(), 'provider-link-'));
  try {
    const elsewhere = join(directory, 'elsewhere');
    await mkdir(elsewhere);
    await chmod(elsewhere, 0o755);
    await symlink(elsewhere, join(directory, 'keys'));
    const result = prepare(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Provider custody must contain only private directories and files/u);
    assert.equal((await lstat(elsewhere)).mode & 0o777, 0o755);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('startup refuses linked custody without changing its target', refusesLinkedCustody);


async function preparesMemberKeys() {
  const root = await mkdtemp(join(tmpdir(), 'member-key-modes-'));
  const personal = join(root, 'personal');
  const memory = join(root, 'memory');
  const memoryKeys = join(memory, 'keys');
  try {
    await mkdir(memoryKeys, { recursive: true, mode: 0o700 });
    await chmod(memoryKeys, 0o2770);
    const key = join(memoryKeys, 'memory-key');
    await writeFile(key, 'synthetic-revision-key', { mode: 0o600 });
    await link(key, `${key}-pending`);
    const args = ['infra/package/provider-secrets.mjs', '--directory-only', personal, memory];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(join(personal, 'keys'))).mode & 0o7777, 0o700);
    assert.equal((await lstat(memoryKeys)).mode & 0o7777, 0o700);
    assert.equal((await lstat(key)).nlink, 2);
    assert.equal((await lstat(key)).mode & 0o7777, 0o600);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('startup prepares both member key folders without interrupting live key writes',
  preparesMemberKeys);
