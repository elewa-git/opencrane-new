import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, it } from 'vitest';
import { conversationKeys } from '../src/keys.ts';

const directories: string[] = [];

afterEach(() => {
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
