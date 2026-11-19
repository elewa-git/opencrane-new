import { createHash } from 'node:crypto';

export function sha256Hex(value: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

// Preserve JSON.stringify order and failures because these hashes identify saved values.
export function sha256HexOfJson(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}
