import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

function reference(silo: string, conversation: string) {
  const identity = JSON.stringify([silo, conversation]);
  return createHash('sha256').update(identity).digest('hex');
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
      if (storedKey.length !== 32) throw new Error('Conversation key is damaged');
      return storedKey;
    }
    const unwrapped = decryptBytes(masterKey, identity(silo, conversation), storedKey);
    if (unwrapped.length !== 32) throw new Error('Conversation key is damaged');
    return unwrapped;
  }

  return {
    provision(silo: string, conversation: string) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const newKey = randomBytes(32);
      const storedKey = masterKey
        ? encryptBytes(masterKey, identity(silo, conversation), newKey)
        : newKey;
      try {
        writeFileSync(keyPath(silo, conversation), storedKey, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
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
