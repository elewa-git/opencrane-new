import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { connectionCustody } from './connection-custody.ts';

const configurationSchema = z.strictObject({
  apiUrl: z.string(), namespace: z.string(), journalDirectory: z.string().min(1),
  currentKeyId: z.string(), keys: z.record(z.string(), z.base64()),
});

/** Load private custody settings from a mounted file, never from event data. */
export async function connectionCustodyFromFile(filename: string) {
  try {
    const contents = await readFile(filename, 'utf8');
    const raw: unknown = JSON.parse(contents);
    const config = configurationSchema.parse(raw);
    const keys: Record<string, Buffer> = {};
    for (const [name, value] of Object.entries(config.keys)) {
      keys[name] = Buffer.from(value, 'base64');
    }
    const keyring = { currentKeyId: config.currentKeyId, keys };
    return connectionCustody(config.apiUrl, config.namespace, keyring, config.journalDirectory);
  } catch {
    throw new Error('Connection custody configuration unavailable');
  }
}
