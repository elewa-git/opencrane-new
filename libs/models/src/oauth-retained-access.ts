import { z } from 'zod';
import { connectionOperationId } from './bearer-connections.ts';
import type { connectionCustody, ConnectionStage } from './connection-custody.ts';

type Custody = ReturnType<typeof connectionCustody>;
type Identity = Parameters<Custody['retire']>[1];
const accessSchema = z.object({ access_token: z.string().regex(/^[\x21-\x7e]{1,4096}$/u) });

/** Keep one access-only copy tied to the original saved generation. */
export function retainedAccessStage(generation: ConnectionStage,
  expiresAt: number): ConnectionStage {
  const subject = `connection-${generation.userId}-${generation.serverId}-${generation.profileId}`;
  const operationId = connectionOperationId(generation.siloId, subject,
    `${generation.operationId}-retained-access`);
  return { ...generation, generation: 1, operationId, attemptId: operationId,
    attemptDigest: generation.endpointDigest, appendUntil: expiresAt };
}

export async function readRetainedAccess(custody: Custody, generation: ConnectionStage,
  expiresAt: number) {
  const stage = retainedAccessStage(generation, expiresAt);
  const recovered = await custody.recover(stage);
  if (recovered.status !== 'recovered' || !recovered.identity) {
    throw new Error('OAuth retained access unavailable');
  }
  const contents = await custody.readAttempt(stage, recovered.identity);
  if (contents === undefined) {
    throw new Error('OAuth retained access unavailable');
  }
  return accessSchema.parse(JSON.parse(contents)).access_token;
}

/** Save the still-live access token before deleting either old refresh-token copy. */
export async function retainAccessToken(custody: Custody, generation: ConnectionStage,
  identity: Identity, expiresAt: number) {
  const contents = await custody.readRevocationMaterial(generation, identity);
  if (contents === undefined) {
    // Require the earlier retained copy when deletion already removed the original.
    await readRetainedAccess(custody, generation, expiresAt);
    return;
  }
  const access = accessSchema.parse(JSON.parse(contents));
  const stage = retainedAccessStage(generation, expiresAt);
  const saved = await custody.stage(stage, JSON.stringify(access));
  if (!saved.identity || !['staged', 'recovered'].includes(saved.status)) {
    throw new Error('OAuth access retention unconfirmed');
  }
}
