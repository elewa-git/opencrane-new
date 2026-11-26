import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it, vi } from 'vitest';
import * as fileSystem from 'node:fs';
import { sha256Hex } from '@opencrane/events/digest';
import { conversationKeys } from '../src/keys.ts';

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyStore() {
  const directory = mkdtempSync(join(tmpdir(), 'wrapped-chat-keys-'));
  directories.push(directory);
  const wrappingKeyFile = join(directory, 'wrapping-key');
  writeFileSync(wrappingKeyFile, Buffer.alloc(32, 7));
  return { directory, wrappingKeyFile };
}

it('stores wrapped conversation keys and reads them with the same secret', () => {
  const { directory, wrappingKeyFile } = keyStore();
  const keys = conversationKeys(join(directory, 'conversations'), wrappingKeyFile);
  keys.provision('dev', 'chat');
  const encrypted = keys.encrypt('dev', 'chat', 'private words');
  const reopened = conversationKeys(join(directory, 'conversations'), wrappingKeyFile);

  assert.equal(reopened.decrypt('dev', 'chat', encrypted), 'private words');
  const keyFile = join(directory, 'conversations', encrypted.keyId.slice(4));
  assert.equal(readFileSync(keyFile).length, 60);
  assert.equal(readFileSync(keyFile).includes(Buffer.alloc(32, 7)), false);
});

it('refuses a different wrapping key', () => {
  const { directory, wrappingKeyFile } = keyStore();
  const keys = conversationKeys(join(directory, 'conversations'), wrappingKeyFile);
  keys.provision('dev', 'chat');
  const encrypted = keys.encrypt('dev', 'chat', 'private words');
  const otherKeyFile = join(directory, 'other-key');
  writeFileSync(otherKeyFile, Buffer.alloc(32, 8));
  const otherKeys = conversationKeys(join(directory, 'conversations'), otherKeyFile);

  assert.throws(() => otherKeys.decrypt('dev', 'chat', encrypted));
});

function recoversInterruptedKeyWrite(published: boolean) {
  const { directory } = keyStore();
  const keysPath = join(directory, 'conversations');
  mkdirSync(keysPath, { mode: 0o700 });
  const reference = sha256Hex(JSON.stringify(['dev', 'chat']));
  const keyFile = join(keysPath, reference);
  const pending = `${keyFile}-00000000-0000-4000-8000-000000000000.pending`;
  const oldKey = Buffer.alloc(32, 7);
  writeFileSync(pending, oldKey, { mode: 0o600 });
  if (published) {
    linkSync(pending, keyFile);
  }
  const keys = conversationKeys(keysPath);
  keys.provision('dev', 'chat');
  assert.deepEqual(readdirSync(keysPath), [reference]);
  if (published) {
    assert.deepEqual(readFileSync(keyFile), oldKey);
  }
  const answer = keys.encrypt('dev', 'chat', 'recovered answer');
  assert.equal(keys.decrypt('dev', 'chat', answer), 'recovered answer');
}
function recoversBeforePublication() {
  recoversInterruptedKeyWrite(false);
}
function recoversAfterPublication() {
  recoversInterruptedKeyWrite(true);
}
it('cleans a key left by an interrupted write before publication', recoversBeforePublication);
it('keeps the published key and clears its extra name after interruption', recoversAfterPublication);

function syncFailureLeavesRecoverableKey(failDirectory: boolean) {
  const { directory } = keyStore();
  const keyDirectory = join(directory, 'conversations');
  mkdirSync(keyDirectory, { mode: 0o700 });
  const keys = conversationKeys(keyDirectory);
  const sync = fileSystem.fsyncSync;
  function failCheckedSync(descriptor: number) {
    if (fileSystem.fstatSync(descriptor).isDirectory() === failDirectory) {
      throw new Error('Synthetic sync failure');
    }
    sync(descriptor);
  }
  const syncSpy = vi.spyOn(fileSystem, 'fsyncSync');
  syncSpy.mockImplementation(failCheckedSync);
  try {
    assert.throws(() => keys.provision('dev', 'chat'), /Synthetic sync failure/u);
  } finally {
    syncSpy.mockRestore();
  }
  const files = readdirSync(keyDirectory);
  assert.equal(files.length, failDirectory ? 1 : 0);
  keys.provision('dev', 'chat');
  assert.equal(readdirSync(keyDirectory).length, 1);
  const answer = keys.encrypt('dev', 'chat', 'saved after sync');
  assert.equal(keys.decrypt('dev', 'chat', answer), 'saved after sync');
}
function requiresFileSync() {
  syncFailureLeavesRecoverableKey(false);
}
function requiresDirectorySync() {
  syncFailureLeavesRecoverableKey(true);
}
it('refuses to publish a key if its file cannot be synced', requiresFileSync);
it('refuses to acknowledge a key if its directory cannot be synced', requiresDirectorySync);
