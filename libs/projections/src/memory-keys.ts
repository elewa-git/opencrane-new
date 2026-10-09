import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync,
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
function requireDirectory(directory: string): void {
  let details: ReturnType<typeof statSync>;
  try {
    details = statSync(directory);
  } catch (error) {
    throw new Error('Memory key store unavailable', { cause: error });
  }
  if (!details.isDirectory()) {
    throw new Error('Memory key store unavailable');
  }
  if ((details.mode & 0o777) !== 0o700) {
    throw new Error('Memory key store requires mode 0700');
  }
}
function readKey(directory: string, identity: MemoryIdentity): Buffer | 'destroyed' {
  const path = `${directory}/${reference(identity)}`;
  requireDirectory(directory);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error('Memory key store unavailable', { cause: error });
  }
  if (bytes.length === 0) {
    return 'destroyed';
  }
  if (bytes.length !== 32) {
    throw new Error('Memory key store damaged');
  }
  return bytes;
}
function publishKey(directory: string, identity: MemoryIdentity, bytes: Buffer, remove: boolean): void {
  const destination = `${directory}/${reference(identity)}`;
  requireDirectory(directory);
  // Keep one known temporary key name so deletion needs no directory scan.
  let temporary = `${destination}-pending`;
  if (remove) {
    temporary = `${destination}-deleting-${randomUUID()}`;
  }
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
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
  requireDirectory(directory);
  function provision(identity: MemoryIdentity): string {
    const keyReference = reference(identity);
    requireDirectory(directory);
    if (!existsSync(`${directory}/${keyReference}`)) {
      publishKey(directory, identity, randomBytes(32), false);
    }
    if (readKey(directory, identity) === 'destroyed') {
      throw new Error('Memory key destroyed');
    }
    return `key:${keyReference}`;
  }
  function remove(identity: MemoryIdentity): void {
    publishKey(directory, identity, Buffer.alloc(0), true);
    // Remove copies left by a crash between publishing a hard link and removing its temporary name.
    const temporary = `${directory}/${reference(identity)}-pending`;
    rmSync(temporary, { force: true });
    syncPath(directory);
  }
  function encrypt(identity: MemoryIdentity, text: string) {
    memoryTextSchema.parse(text);
    const key = readKey(directory, identity);
    if (key === 'destroyed') {
      throw new Error('Memory key destroyed');
    }
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
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
    if (key === 'destroyed') {
      return null;
    }
    const bytes = Buffer.from(value.ciphertext, 'base64');
    if (bytes.length < 29 || bytes.length > 4124) {
      throw new Error('Invalid memory ciphertext size');
    }
    const nonce = bytes.subarray(0, 12);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
    decipher.setAAD(binding(identity));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const text = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    // Return authenticated older text too. Let the projection quarantine refused text.
    return text.toString('utf8');
  }
  return { provision, delete: remove, encrypt, decrypt };
}
