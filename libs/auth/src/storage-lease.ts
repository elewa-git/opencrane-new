import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const storageLease = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
  sessionToken: z.string().min(1),
  expiresAt: z.int(),
});

/** Read current rotation and refuse expired or overlong storage credentials. */
export async function readStorageLease(path: string) {
  const content = await readFile(path, 'utf8');
  const value: unknown = JSON.parse(content);
  const lease = storageLease.parse(value);
  const now = Date.now();
  if (lease.expiresAt <= now || lease.expiresAt > now + 900_000) {
    throw new Error('Storage lease expired or overlong');
  }
  return lease;
}
