import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { providerSecrets } from './provider-secrets.ts';

const missingFile = z.object({ code: z.literal('ENOENT') });
const identitySchema = z.object({ reference: z.string(), uid: z.string(),
  resourceVersion: z.string() }).strict();
type Identity = z.infer<typeof identitySchema>;
interface Record {
  operationId: string;
  reference: string;
  expectedSequence: number;
  appendUntil: number;
}

/** Keep repair records private. These records never decide which connection is active. */
export function connectionStageJournal(directory: string) {
  const files = providerSecrets(directory);
  function reference(kind: string, name: string) {
    const hash = createHash('sha256');
    hash.update(JSON.stringify([kind, name]));
    return `secret:provider-${hash.digest('hex')}`;
  }
  async function publish(path: string, value: string) {
    await files.save(path, value);
    const filename = `${directory}/${path.slice('secret:provider-'.length)}`;
    // Flush the file and its name before returning a confirmed recovery record.
    for (const target of [filename, directory]) {
      const descriptor = await open(target, 'r');
      try {
        await descriptor.sync();
      } finally {
        await descriptor.close();
      }
    }
  }
  async function prepared(record: Record, create: boolean) {
    const path = reference('stage', record.operationId);
    const expected = JSON.stringify(record);
    if (create) {
      await publish(path, expected);
    }
    return await files.read(path) === expected;
  }
  async function identity(name: string): Promise<Identity | undefined> {
    try {
      const raw: unknown = JSON.parse(await files.read(reference('identity', name)));
      const checked = identitySchema.safeParse(raw);
      if (!checked.success) {
        throw new Error('Connection recovery record invalid');
      }
      return checked.data;
    } catch (error) {
      if (missingFile.safeParse(error).success) {
        return undefined;
      }
      throw new Error('Connection recovery record unavailable', { cause: error });
    }
  }
  async function pin(observed: Identity) {
    const path = reference('identity', observed.reference);
    const expected = JSON.stringify(observed);
    // Publish once and compare privately, including when another worker got the reply first.
    await publish(path, expected);
    return await files.read(path) === expected;
  }
  return { prepared, identity, pin };
}
