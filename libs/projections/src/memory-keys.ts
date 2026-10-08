import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import {
  memoryWrittenIdentity, memoryRevisionIdentitySchema, memoryTextSchema,
  type MemoryIdentity,
} from '@opencrane/events';

const scopeOwnership = memoryRevisionIdentitySchema.pick({
  silo: true, scopeKind: true, ownerId: true,
});
export function memoryScopeId(silo: string, kind: MemoryIdentity['scopeKind'], ownerId: string) {
  const ownership = { silo, scopeKind: kind, ownerId };
  scopeOwnership.parse(ownership);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([silo, kind, ownerId]));
  return hash.digest('hex');
}
export function memoryIdentity(event: unknown): MemoryIdentity | null {
  const identity = memoryWrittenIdentity(event);
  if (identity !== null) {
    binding(identity);
  }
  return identity;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
function syncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function binding(identity: MemoryIdentity): Buffer {
  const checked = memoryRevisionIdentitySchema.parse(identity);
  if (checked.scopeId !== memoryScopeId(checked.silo, checked.scopeKind, checked.ownerId)) {
    throw new Error('Memory scope identity mismatch');
  }
  const fields = [checked.silo, checked.scopeId, checked.scopeKind, checked.ownerId,
    checked.memoryId, checked.revision];
  return Buffer.from(JSON.stringify(fields));
}
function reference(identity: MemoryIdentity): string {
  const hash = createHash('sha256');
  hash.update(binding(identity));
  return hash.digest('hex');
}
function readKey(directory: string, identity: MemoryIdentity): Buffer | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(`${directory}/${reference(identity)}`);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      if (!statSync(directory).isDirectory()) {
        throw new Error('Memory key store unavailable', { cause: error });
      }
      return null;
    }
    throw error;
  }
  if (bytes.length === 0) {
    return null;
  }
  if (bytes.length !== 32) {
    throw new Error('Memory key store damaged');
  }
  return bytes;
}
function publishKey(directory: string, identity: MemoryIdentity, bytes: Buffer, remove: boolean): void {
  const destination = `${directory}/${reference(identity)}`;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${destination}-pending-${randomUUID()}`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    syncPath(temporary);
    if (remove) {
      // Replace the key atomically with an empty permanent marker, including during provision.
      renameSync(temporary, destination);
    } else {
      try {
        linkSync(temporary, destination);
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) {
          throw error;
        }
      }
    }
    syncPath(directory);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** Keep revision keys on the server. Never return key bytes to callers. */
export function memoryKeys(directory: string) {
  function provision(identity: MemoryIdentity): string {
    publishKey(directory, identity, randomBytes(32), false);
    if (readKey(directory, identity) === null) {
      throw new Error('Memory key destroyed');
    }
    return `key:${reference(identity)}`;
  }
  function remove(identity: MemoryIdentity): void {
    publishKey(directory, identity, Buffer.alloc(0), true);
    const prefix = `${reference(identity)}-pending-`;
    // Remove copies left by a crash between publishing a hard link and removing its temporary name.
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(prefix)) {
        rmSync(`${directory}/${entry}`, { force: true });
      }
    }
    syncPath(directory);
  }
  function encrypt(identity: MemoryIdentity, text: string) {
    memoryTextSchema.parse(text);
    const key = readKey(directory, identity);
    if (key === null) {
      throw new Error('Memory key missing or destroyed');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(binding(identity));
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    return { ciphertext: bytes.toString('base64'), keyId: `key:${reference(identity)}` };
  }
  function decrypt(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
    if (value.keyId !== `key:${reference(identity)}`) {
      throw new Error('Memory key identity mismatch');
    }
    const key = readKey(directory, identity);
    if (key === null) {
      return null;
    }
    const bytes = Buffer.from(value.ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(binding(identity));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    return memoryTextSchema.parse(text.toString('utf8'));
  }
  return { provision, delete: remove, encrypt, decrypt };
}
