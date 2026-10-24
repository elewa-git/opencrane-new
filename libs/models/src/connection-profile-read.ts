import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { history } from './event-history.ts';
import { foldConnection } from './bearer-connections.ts';
import { connectionServer } from './connection-server.ts';
import { readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ serverId: id, profileId: id });
const identitySchema = z.object({ userId: id, serverId: id, profile: id });
const metadataSchema = z.strictObject({
  serverId: id, profileId: id, profileRevision: z.int().positive(),
  status: z.enum(['saved_unverified', 'unavailable']), generation: z.int().positive().nullable(),
  adminBlocked: z.boolean(), serverAvailable: z.boolean(), callsAvailable: z.literal(false),
});

/** Read the caller's exact profile. Saved material never proves an upstream identity. */
export async function readOwnConnectionProfile(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  id.parse(memberId);
  let metadata: z.infer<typeof metadataSchema> | null = null;
  let failure: Error | undefined;
  try {
    metadata = await loadMetadata(store, binding.silo, memberId, reference);
  } catch (error) {
    failure = new Error('Profile history unavailable', { cause: error });
  }
  // Check current membership after loading, even when history failed or the profile is missing.
  await readActiveMember(store, binding, memberId);
  if (failure) {
    throw failure;
  }
  return metadata;
}

async function loadMetadata(store: EventStore, silo: string, memberId: string,
  reference: z.infer<typeof referenceSchema>) {
  const { serverId, profileId } = reference;
  const subject = `connection-${memberId}-${serverId}-${profileId}`;
  const deadline = performance.now() + 10_000;
  const rows = await history(store, subject, silo, deadline);
  const control = await history(store, `connection-control-${memberId}-${serverId}`, silo, deadline);
  const serverRows = await history(store, `mcp-${serverId}`, silo, deadline);
  if (rows.length === 0) {
    return null;
  }
  for (const row of rows) {
    const identity = identitySchema.safeParse(row.event.data);
    if (row.event.subject !== subject || !identity.success ||
        identity.data.userId !== memberId || identity.data.serverId !== serverId ||
        identity.data.profile !== profileId) {
      return null;
    }
  }
  const profile = foldConnection(rows);
  const saved = profile.data;
  const server = connectionServer(serverRows, saved?.activation.connectionId ?? '');
  const serverAvailable = server.available && Date.now() < server.expiresAt &&
    saved?.activation.endpointDigest === server.endpointDigest;
  // Treat every control record as a block, matching bearer saves and explicit selection.
  const metadata = { serverId, profileId, profileRevision: profile.sequence,
    status: profile.status, generation: saved?.activation.generation ?? null,
    adminBlocked: control.length > 0, serverAvailable, callsAvailable: false };
  return metadataSchema.parse(metadata);
}
