import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionDisabledDataSchema } from '@opencrane/events';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import { isPersonalProfile } from './connection-profile-admin-read.ts';
import { history } from './event-history.ts';
import { readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ userId: id, serverId: id, profileId: id,
  changeRef: id });
const receiptSchema = z.strictObject({
  status: z.literal('confirmed'), changeRef: id,
  eventId: z.string().regex(/^[0-9a-f]{64}$/u),
  recordedAt: z.iso.datetime(), sequence: z.int().positive(),
  action: z.literal('disable'), adminBlocked: z.boolean(),
  controlRevision: z.int().nonnegative(),
  profileStatus: z.enum(['saved_unverified', 'unavailable']),
});
type Reference = z.infer<typeof referenceSchema>;

/** Read the original local disable without retrying it or reading stored material. */
export async function readAdminDisableChange(store: EventStore, binding: Binding,
  actorId: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  id.parse(actorId);
  let result: z.infer<typeof receiptSchema> | null = null;
  let failure: Error | undefined;
  try {
    result = await loadReceipt(store, binding.silo, actorId, reference);
  } catch (error) {
    failure = new Error('Disable history unavailable', { cause: error });
  }
  // Check current admin access after history, even when the original result is missing.
  await readActiveMember(store, binding, actorId, 'admin');
  if (failure) {
    throw failure;
  }
  return result;
}

async function loadReceipt(store: EventStore, silo: string, actorId: string,
  reference: Reference) {
  const { userId, serverId, profileId, changeRef } = reference;
  const profileSubject = `connection-${userId}-${serverId}-${profileId}`;
  const controlSubject = `connection-control-${userId}-${serverId}`;
  const deadline = performance.now() + 10_000;
  const profileRows = await history(store, profileSubject, silo, deadline);
  const controlRows = await history(store, controlSubject, silo, deadline);
  if (!isPersonalProfile(profileRows, profileSubject, reference)) {
    return null;
  }
  const operationId = connectionOperationId(silo, controlSubject, changeRef);
  const original = findOriginal(controlRows, controlSubject, reference, actorId, operationId);
  if (!original) {
    return null;
  }
  const profile = foldConnection(profileRows);
  const receipt = {
    status: 'confirmed', changeRef, eventId: original.event.id,
    recordedAt: original.event.time, sequence: original.sequence,
    action: 'disable', adminBlocked: controlRows.length > 0,
    controlRevision: controlRows.at(-1)?.sequence ?? 0,
    profileStatus: profile.status,
  };
  const parsed = receiptSchema.safeParse(receipt);
  return parsed.success ? parsed.data : null;
}

function findOriginal(rows: StoredEvent[], subject: string, reference: Reference,
  actorId: string, operationId: string) {
  let original: StoredEvent | undefined;
  let previousSequence = 0;
  for (const row of rows) {
    if (!validControlRecord(row, subject, reference)) {
      return undefined;
    }
    const mentionsReference = row.event.id === operationId ||
      row.event.commandId === reference.changeRef;
    if (mentionsReference) {
      if (original || !matchesOriginal(row, reference, actorId, operationId,
        previousSequence)) {
        return undefined;
      }
      original = row;
    }
    previousSequence = row.sequence;
  }
  return original;
}

function validControlRecord(row: StoredEvent, subject: string, reference: Reference) {
  const parsed = connectionDisabledDataSchema.safeParse(row.event.data);
  return row.event.subject === subject && row.event.type === 'connection.disabled' &&
    parsed.success && parsed.data.userId === reference.userId &&
    parsed.data.serverId === reference.serverId;
}

function matchesOriginal(row: StoredEvent, reference: Reference, actorId: string,
  operationId: string, previousSequence: number) {
  const parsed = connectionDisabledDataSchema.safeParse(row.event.data);
  return parsed.success && row.event.id === operationId &&
    row.event.commandId === reference.changeRef &&
    row.event.source === 'opencrane-server' &&
    row.event.principal?.kind === 'human' && row.event.principal.id === actorId &&
    parsed.data.disabledBy === actorId && parsed.data.profile === reference.profileId &&
    parsed.data.expectedSequence === previousSequence;
}
