import { createHash } from 'node:crypto';

export function hashBackupBytes(bytes: Buffer | string) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}
