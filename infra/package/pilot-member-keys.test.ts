import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { conversationKeys, memoryKeys, memoryScopeId } from '@opencrane/projections';
import { expect, it, onTestFinished } from 'vitest';
import {
  captureMemberKeys, openMemberKeyArchive, restoreMemberKeys, verifyMemberKeys,
} from './pilot-member-keys.ts';

const privateFile = { mode: 0o600 };
const identity = { id: 'test-backup', silo: 'silo', sequence: 2 };
const person = 'personal:member';
const note = 'Read the weekly report before the summary.';
const scopeId = memoryScopeId(identity.silo, 'person', 'member');
const fact = { silo: identity.silo, scopeId, scopeKind: 'person' as const,
  ownerId: 'member', memoryId: 'fact', revision: 1 };
const erased = { ...fact, memoryId: 'erased-fact' };

async function keyFolders(directory: string) {
  const personal = join(directory, 'personal');
  const memory = join(directory, 'memory');
  await mkdir(personal, { recursive: true, mode: 0o700 });
  await mkdir(memory, { recursive: true, mode: 0o700 });
  return { personal, memory };
}

async function fixture() {
  const directory = await mkdtemp('/tmp/pilot-member-keys-');
  async function clean() { await rm(directory, { recursive: true, force: true }); }
  onTestFinished(clean);
  const source = await keyFolders(join(directory, 'source'));
  const target = await keyFolders(join(directory, 'target'));
  const wrappingKey = join(directory, 'encryption-key');
  await writeFile(wrappingKey, Buffer.alloc(32, 8), privateFile);
  const destination = join(directory, 'member-keys');
  return { source, target, wrappingKey, destination };
}

async function restoresOnlyProtectedKeysAndKeepsErasureMarkers() {
  const { source, target, wrappingKey, destination } = await fixture();
  const personal = conversationKeys(source.personal);
  personal.provision(identity.silo, person);
  const onboarding = personal.encrypt(identity.silo, person, note);
  const memory = memoryKeys(source.memory);
  memory.provision(fact);
  const savedFact = memory.encrypt(fact, note);
  memory.provision(erased);
  memory.delete(erased);
  const name = onboarding.keyId.slice(4);
  const personalKey = await readFile(join(source.personal, name));
  await expect(captureMemberKeys(destination, identity, wrappingKey, source))
    .resolves.toEqual({ encryption: 'aes-256-gcm' });
  const encrypted = await readFile(destination);
  expect(encrypted.includes(personalKey)).toBe(false);
  expect(encrypted.includes(personalKey.toString('hex'))).toBe(false);
  expect(encrypted.includes(name)).toBe(false);
  const keys = openMemberKeyArchive(encrypted, identity, wrappingKey);
  await restoreMemberKeys(target, keys);
  await restoreMemberKeys(target, keys);
  const restoredPersonal = conversationKeys(target.personal);
  const restoredMemory = memoryKeys(target.memory);
  expect(restoredPersonal.decrypt(identity.silo, person, onboarding)).toBe(note);
  expect(restoredMemory.decrypt(fact, savedFact)).toBe(note);
  expect(restoredMemory.status(erased)).toBe('destroyed');
  const restoredPath = join(target.personal, name);
  expect((await lstat(restoredPath)).mode & 0o7777).toBe(0o600);
  await rm(restoredPath);
  await expect(verifyMemberKeys(target, keys)).rejects.toThrow('keys are missing');
}
it('restores readable onboarding and Memory values and keeps forgotten keys erased',
  restoresOnlyProtectedKeysAndKeepsErasureMarkers);

async function refusesUnauthenticatedArchive(condition: 'changed bytes' | 'wrong set' | 'wrong key') {
  const { source, wrappingKey, destination } = await fixture();
  await captureMemberKeys(destination, identity, wrappingKey, source);
  const encrypted = await readFile(destination);
  let reference = identity;
  if (condition === 'changed bytes') encrypted[20] = encrypted[20]! ^ 1;
  if (condition === 'wrong set') reference = { ...identity, id: 'another-backup' };
  if (condition === 'wrong key') {
    await writeFile(wrappingKey, Buffer.alloc(32, 9), privateFile);
  }
  function open() {
    openMemberKeyArchive(encrypted, reference, wrappingKey);
  }
  expect(open).toThrow('keys are missing or could not be verified');
}
it.each(['changed bytes', 'wrong set', 'wrong key'] as const)(
  'refuses the encrypted key part with %s', refusesUnauthenticatedArchive);

async function refusesForeignTargetKeys() {
  const { source, target, wrappingKey, destination } = await fixture();
  const foreign = join(target.memory, 'a'.repeat(64));
  await writeFile(foreign, Buffer.alloc(32, 3), privateFile);
  await captureMemberKeys(destination, identity, wrappingKey, source);
  const bytes = await readFile(destination);
  const keys = openMemberKeyArchive(bytes, identity, wrappingKey);
  await expect(restoreMemberKeys(target, keys)).rejects.toThrow('keys are missing');
  expect(await readFile(foreign)).toEqual(Buffer.alloc(32, 3));
}
it('refuses a foreign key in the target and preserves it', refusesForeignTargetKeys);

async function refusesSymlinkedSourceKeys() {
  const { source, wrappingKey, destination } = await fixture();
  await symlink(wrappingKey, join(source.personal, 'a'.repeat(64)));
  await expect(captureMemberKeys(destination, identity, wrappingKey, source))
    .rejects.toThrow('keys are missing');
  await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
}
it('refuses a linked key file without saving an archive', refusesSymlinkedSourceKeys);
