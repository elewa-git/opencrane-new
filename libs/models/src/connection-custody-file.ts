import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { connectionCustody } from './connection-custody.ts';

const configurationSchema = z.strictObject({
  apiUrl: z.string(), namespace: z.string(), journalDirectory: z.string().min(1),
  currentKeyId: z.string(), keys: z.record(z.string(), z.base64()),
});

function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

async function readConfiguration(filename: string) {
  let contents: string;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return { kind: 'missing' as const };
    }
    return { kind: 'invalid' as const };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    return { kind: 'invalid' as const };
  }

  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) {
    return { kind: 'invalid' as const };
  }
  return { kind: 'configured' as const, config: parsed.data };
}

function buildCustody(config: z.infer<typeof configurationSchema>) {
  try {
    const keys: Record<string, Buffer> = {};
    for (const [name, value] of Object.entries(config.keys)) {
      keys[name] = Buffer.from(value, 'base64');
    }
    const keyring = { currentKeyId: config.currentKeyId, keys };
    return connectionCustody(config.apiUrl, config.namespace, keyring, config.journalDirectory);
  } catch {
    return undefined;
  }
}

/** Load private custody settings from a mounted file, never from event data. */
export async function connectionCustodyFromFile(filename: string) {
  const result = await readConfiguration(filename);
  if (result.kind === 'missing') {
    return undefined;
  }
  if (result.kind === 'invalid') {
    throw new Error('Connection custody configuration unavailable');
  }

  const custody = buildCustody(result.config);
  if (!custody) {
    throw new Error('Connection custody configuration unavailable');
  }
  return custody;
}
