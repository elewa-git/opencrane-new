import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, chown, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile }
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
    const processOwner = process.getuid();
    const expectedOwner = processOwner === 0 ? 1000 : processOwner;
    if (processOwner === 0) {
      await chown(key, expectedOwner, expectedOwner);
    }
    await link(key, `${key}-pending`);
    const args = ['infra/package/provider-secrets.mjs', '--directory-only', personal, memory];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const personalDetails = await lstat(join(personal, 'keys'));
    const memoryDetails = await lstat(memoryKeys);
    const keyDetails = await lstat(key);
    assert.equal(personalDetails.uid, expectedOwner);
    assert.equal(memoryDetails.uid, expectedOwner);
    assert.equal(keyDetails.uid, expectedOwner);
    assert.equal(personalDetails.mode & 0o7777, 0o700);
    assert.equal(memoryDetails.mode & 0o7777, 0o700);
    assert.equal(keyDetails.nlink, 2);
    assert.equal(keyDetails.mode & 0o7777, 0o600);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('startup prepares both member key folders without interrupting live key writes',
  preparesMemberKeys);

async function refusesUnsafeMemberKey(kind) {
  const root = await mkdtemp(join(tmpdir(), 'unsafe-member-key-'));
  const keys = join(root, 'keys');
  const file = join(keys, 'a'.repeat(64));
  try {
    await mkdir(keys, { mode: 0o700 });
    if (kind === 'symlink') {
      const target = join(root, 'regular-key');
      await writeFile(target, 'synthetic-member-key', { mode: 0o600 });
      if (process.getuid() === 0) {
        await chown(target, 1000, 1000);
      }
      await symlink(target, file);
    } else {
      const mode = kind === 'wrong-owner' ? 0o600 : 0o640;
      await writeFile(file, 'synthetic-member-key', { mode });
      await chmod(file, mode);
      if (process.getuid() === 0 && kind === 'group-readable') {
        await chown(file, 1000, 1000);
      }
    }
    const args = ['infra/package/provider-secrets.mjs', '--directory-only', root];
    if (kind === 'wrong-owner' && process.getuid() !== 0) {
      // Use the actual file owner and change only the child process's expected owner.
      args.unshift('--import', 'data:text/javascript,process.getuid=()=>2000');
    }
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(result.status, 1, `Accepted an unsafe ${kind} key`);
    const refusal = kind === 'symlink' ? /Key custody requires regular key files/u : /Key custody/u;
    assert.match(result.stderr, refusal);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function refusesLinkedMemberKey() {
  return refusesUnsafeMemberKey('symlink');
}
function refusesReadableMemberKey() {
  return refusesUnsafeMemberKey('group-readable');
}
test('startup refuses a member key that is a symbolic link', refusesLinkedMemberKey);
test('startup refuses a member key that is group-readable', refusesReadableMemberKey);

function refusesWrongOwnerMemberKey() {
  return refusesUnsafeMemberKey('wrong-owner');
}
test('startup refuses a member key owned by another user', refusesWrongOwnerMemberKey);
