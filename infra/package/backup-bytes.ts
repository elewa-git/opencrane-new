import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

const nonceLength = 12;
const tagLength = 16;

export function beginBackupEncryption(key: Buffer, identity: Buffer) {
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength });
  cipher.setAAD(identity);
  return { nonce, cipher };
}

export function beginBackupDecryption(key: Buffer, identity: Buffer, bytes: Buffer) {
  if (bytes.length < nonceLength + tagLength) throw new Error('Encrypted backup bytes missing');
  const nonce = bytes.subarray(0, nonceLength);
  const tag = bytes.subarray(bytes.length - tagLength);
  const ciphertext = bytes.subarray(nonceLength, bytes.length - tagLength);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: tagLength });
  decipher.setAAD(identity);
  decipher.setAuthTag(tag);
  return { ciphertext, decipher };
}

export function hashBackupBytes(bytes: Buffer | string) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

export async function privateDirectory(directory: string) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700 || await realpath(directory) !== resolve(directory)) {
    throw new Error('Private directory refused');
  }
}
