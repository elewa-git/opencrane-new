import { sha256Hex } from '@opencrane/events/digest';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';

function reference(silo: string, conversation: string) {
  const identity = JSON.stringify([silo, conversation]);
  return sha256Hex(identity);
}

export function onboardingKeyIdentity(memberId: string) {
  return `personal:${memberId}`;
}

function encryptBytes(key: Buffer, identity: Buffer, plaintext: Buffer) {
  const initialisationVector = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, initialisationVector);
  cipher.setAAD(identity);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([initialisationVector, cipher.getAuthTag(), ciphertext]);
}

function decryptBytes(key: Buffer, identity: Buffer, encrypted: Buffer) {
  if (encrypted.length < 28) throw new Error('Encrypted conversation data is damaged');
  const cipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12));
  cipher.setAAD(identity);
  cipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([cipher.update(encrypted.subarray(28)), cipher.final()]);
}

function wrappingKey(path: string | undefined) {
  if (!path) return undefined;
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error('Conversation wrapping key must be 32 bytes');
  return key;
}

function syncDirectory(directory: string) {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishKey(path: string, key: Buffer) {
  // Publish only a complete key when a server and worker both try to create it.
  const temporary = `${path}-${randomUUID()}.pending`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, key);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, path);
  } catch (error) {
    // A concurrent writer can publish first and remove this unused name.
    const anotherKeyPublished = error instanceof Error && 'code' in error &&
      (error.code === 'EEXIST' || (error.code === 'ENOENT' && existsSync(path)));
    if (!anotherKeyPublished) {
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

function finishPublication(path: string) {
  const directory = dirname(path);
  const prefix = basename(path) + '-';
  // Remove abandoned names only once the real key exists, so a competing writer can use it.
  for (const name of readdirSync(directory)) {
    if (name.startsWith(prefix) && name.endsWith('.pending')) {
      rmSync(join(directory, name), { force: true });
    }
  }
  syncDirectory(directory);
}

/** Store each conversation key separately so deleting one does not affect another. */
export function conversationKeys(directory: string, wrappingKeyFile?: string) {
  const masterKey = wrappingKey(wrappingKeyFile);

  function identity(silo: string, conversation: string) {
    return Buffer.from(JSON.stringify([silo, conversation]));
  }

  function keyPath(silo: string, conversation: string) {
    return `${directory}/${reference(silo, conversation)}`;
  }

  function conversationKey(silo: string, conversation: string) {
    const storedKey = readFileSync(keyPath(silo, conversation));
    if (!masterKey) {
      if (storedKey.length !== 32) {
        throw new Error('Conversation key is damaged');
      }
      return storedKey;
    }
    const unwrapped = decryptBytes(masterKey, identity(silo, conversation), storedKey);
    if (unwrapped.length !== 32) throw new Error('Conversation key is damaged');
    return unwrapped;
  }

  return {
    provision(silo: string, conversation: string) {
      const path = keyPath(silo, conversation);
      if (!existsSync(path)) {
        const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
        if (firstCreated) {
          syncDirectory(dirname(firstCreated));
        }
        const newKey = randomBytes(32);
        const storedKey = masterKey
          ? encryptBytes(masterKey, identity(silo, conversation), newKey)
          : newKey;
        publishKey(path, storedKey);
      }
      finishPublication(path);
    },
    encrypt(silo: string, conversation: string, text: string) {
      const bytes = Buffer.from(text, 'utf8');
      const encrypted = encryptBytes(conversationKey(silo, conversation), identity(silo, conversation), bytes);
      return {
        ciphertext: encrypted.toString('base64'),
        keyId: `key:${reference(silo, conversation)}`,
      };
    },
    decrypt(silo: string, conversation: string, value: unknown) {
      const data = z.object({ ciphertext: z.string(), keyId: z.string() }).parse(value);
      if (data.keyId !== `key:${reference(silo, conversation)}`) {
        throw new Error('Conversation key mismatch');
      }
      const encrypted = Buffer.from(data.ciphertext, 'base64');
      const bytes = decryptBytes(conversationKey(silo, conversation), identity(silo, conversation), encrypted);
      return bytes.toString('utf8');
    },
  };
}
