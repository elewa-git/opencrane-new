import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, connectionRevokedDataSchema } from '@opencrane/events';
import { foldConnection } from './bearer-connections.ts';
import { metadataSchema } from './connection-profile-read.ts';
import { connectionServer } from './connection-server.ts';
import { history } from './event-history.ts';
import { readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ userId: id, serverId: id, profileId: id });
const identitySchema = z.object({ userId: id, serverId: id, profile: id });
const serverIdentitySchema = z.object({ serverId: id });
const savedSchema = connectionCreatedDataSchema.required({ activation: true });
const adminMetadataSchema = metadataSchema.extend({ controlRevision: z.int().nonnegative() });
type Reference = z.infer<typeof referenceSchema>;

/** Read one member's saved profile without using their credentials or permissions. */
export async function readAdminConnectionProfile(store: EventStore, binding: Binding,
  actorId: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  id.parse(actorId);
  let result: z.infer<typeof adminMetadataSchema> | null = null;
  let failure: Error | undefined;
  try {
    result = await loadMetadata(store, binding.silo, reference);
  } catch (error) {
    failure = new Error('Profile history unavailable', { cause: error });
  }
  // Check current admin access once, including when history failed or the target is missing.
  await readActiveMember(store, binding, actorId, 'admin');
  if (failure) {
    throw failure;
  }
  return result;
}

async function loadMetadata(store: EventStore, silo: string, reference: Reference) {
  const { userId, serverId, profileId } = reference;
  const subject = `connection-${userId}-${serverId}-${profileId}`;
  const controlSubject = `connection-control-${userId}-${serverId}`;
  const serverSubject = `mcp-${serverId}`;
  const deadline = performance.now() + 10_000;
  const rows = await history(store, subject, silo, deadline);
  const control = await history(store, controlSubject, silo, deadline);
  const serverRows = await history(store, serverSubject, silo, deadline);
  if (!validRelatedHistories(control, serverRows, reference)) {
    return null;
  }
  if (!isPersonalProfile(rows, subject, reference)) {
    return null;
  }
  const profile = foldConnection(rows);
  const saved = profile.data;
  const server = connectionServer(serverRows, saved?.activation.connectionId ?? '');
  const serverAvailable = server.available && Date.now() < server.expiresAt &&
    saved?.activation.endpointDigest === server.endpointDigest;
  const metadata = { serverId, profileId, profileRevision: profile.sequence,
    controlRevision: control.at(-1)?.sequence ?? 0, status: profile.status,
    generation: saved?.activation.generation ?? null, adminBlocked: control.length > 0,
    serverAvailable, callsAvailable: false };
  return adminMetadataSchema.parse(metadata);
}

function isPersonalProfile(rows: StoredEvent[], subject: string, reference: Reference) {
  // Require an original personal activation before exposing any binding, even after revocation.
  const first = rows.slice(0, 1);
  if (!foldConnection(first).data) {
    return false;
  }
  for (const row of rows) {
    const identity = identitySchema.safeParse(row.event.data);
    if (row.event.subject !== subject || !identity.success ||
        identity.data.userId !== reference.userId || identity.data.serverId !== reference.serverId ||
        identity.data.profile !== reference.profileId) {
      return false;
    }
    if (row.event.type === 'connection.created' || row.event.type === 'connection.refreshed') {
      if (!savedSchema.safeParse(row.event.data).success) {
        return false;
      }
    }
  }
  const profile = foldConnection(rows);
  const last = rows.at(-1)?.event;
  return profile.data !== undefined || (last?.type === 'connection.revoked' &&
    connectionRevokedDataSchema.safeParse(last.data).success);
}

function validRelatedHistories(control: StoredEvent[], serverRows: StoredEvent[],
  reference: Reference) {
  const { userId, serverId } = reference;
  const controlSubject = `connection-control-${userId}-${serverId}`;
  const serverSubject = `mcp-${serverId}`;
  for (const row of control) {
    const parsed = identitySchema.safeParse(row.event.data);
    if (row.event.subject !== controlSubject || row.event.type !== 'connection.disabled' ||
        !parsed.success || parsed.data.userId !== userId || parsed.data.serverId !== serverId) {
      throw new Error('Profile history unavailable');
    }
  }
  for (const row of serverRows) {
    const parsed = serverIdentitySchema.safeParse(row.event.data);
    if (row.event.subject !== serverSubject || !parsed.success || parsed.data.serverId !== serverId) {
      return false;
    }
  }
  return true;
}
