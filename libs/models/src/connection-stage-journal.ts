import { createHash, randomUUID } from 'node:crypto';
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
    try {
      return await files.read(path) === expected;
    } catch (error) {
      if (missingFile.safeParse(error).success) {
        return false;
      }
      throw error;
    }
  }
  async function preparation(operationId: string): Promise<Record | undefined> {
    try {
      const raw: unknown = JSON.parse(await files.read(reference('stage', operationId)));
      const schema = z.strictObject({ operationId: z.literal(operationId), reference: z.string(),
        expectedSequence: z.int().nonnegative(), appendUntil: z.int().positive() });
      return schema.parse(raw);
    } catch (error) {
      if (missingFile.safeParse(error).success) {
        return undefined;
      }
      throw new Error('Connection preparation unavailable', { cause: error });
    }
  }
  async function readIdentity(kind: string, name: string): Promise<Identity | undefined> {
    try {
      const raw: unknown = JSON.parse(await files.read(reference(kind, name)));
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
  async function saveIdentity(kind: string, observed: Identity) {
    const path = reference(kind, observed.reference);
    const expected = JSON.stringify(observed);
    // Publish once and compare privately, including when another worker got the reply first.
    await publish(path, expected);
    return await files.read(path) === expected;
  }
  async function identity(name: string) {
    return readIdentity('identity', name);
  }
  async function pin(observed: Identity) {
    return saveIdentity('identity', observed);
  }
  async function claimOnce(kind: string, name: string) {
    const path = reference(kind, name);
    const attemptId = randomUUID();
    // Save before sending. A lost reply must never cause a second attempt.
    await publish(path, attemptId);
    return await files.read(path) === attemptId;
  }
  async function claimCreate(name: string) {
    return claimOnce('create', name);
  }
  async function claimSend(name: string) {
    return claimOnce('send', name);
  }
  async function hasSendClaim(name: string) {
    try {
      await files.read(reference('send', name));
      return true;
    } catch (error) {
      if (missingFile.safeParse(error).success) {
        return false;
      }
      throw error;
    }
  }
  async function deletion(name: string) {
    return readIdentity('deletion', name);
  }
  async function markDeletion(observed: Identity) {
    // Keep the exact identity across restart while Kubernetes waits for finalisers.
    return saveIdentity('deletion', observed);
  }
  async function revokeOnce(operationId: string, send: () => Promise<unknown>) {
    const path = reference('revoked', operationId);
    try {
      return await files.read(path) === 'confirmed';
    } catch (error) {
      if (!missingFile.safeParse(error).success) {
        throw error;
      }
    }
    if (!await claimOnce('revoke-send', operationId)) {
      return false;
    }
    await send();
    // Save only the successful status. Provider bodies can contain private material.
    await publish(path, 'confirmed');
    return true;
  }
  return { prepared, preparation, identity, pin, claimCreate, claimSend, hasSendClaim,
    deletion, markDeletion, revokeOnce };
}
