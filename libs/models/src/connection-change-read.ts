import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionCreatedDataSchema, connectionRevokedDataSchema } from '@opencrane/events';
import { connectionOperationId, foldConnection } from './bearer-connections.ts';
import { history } from './event-history.ts';
import { readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ serverId: id, profileId: id, changeRef: id });
const identitySchema = z.object({ userId: id, serverId: id, profile: id });
const operationSchema = z.object({ operationId: z.unknown().optional() });
const activationSchema = z.object({ activation: operationSchema });
const savedSchema = connectionCreatedDataSchema.required({ activation: true });
const revokedSchema = connectionRevokedDataSchema.required({ reason: true, expectedSequence: true });
const receiptSchema = z.strictObject({
  status: z.literal('confirmed'), changeRef: id, eventId: z.string().regex(/^[0-9a-f]{64}$/u),
  eventType: z.enum(['connection.created', 'connection.refreshed', 'connection.revoked']),
  recordedAt: z.iso.datetime(), sequence: z.int().positive(),
  action: z.enum(['create', 'rotate', 'revoke']), generation: z.int().positive().nullable(),
  identityStatus: z.literal('unverified'),
});
type Reference = z.infer<typeof referenceSchema>;

/** Read the original local change, without making a claim about current usability. */
export async function readOwnConnectionChange(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  id.parse(memberId);
  const subject = `connection-${memberId}-${reference.serverId}-${reference.profileId}`;
  let result: z.infer<typeof receiptSchema> | null = null;
  let failure: Error | undefined;
  try {
    const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
    result = originalReceipt(rows, binding.silo, subject, memberId, reference);
  } catch (error) {
    failure = new Error('Change history unavailable', { cause: error });
  }
  // Check membership after loading or failure so removal takes precedence over either result.
  await readActiveMember(store, binding, memberId);
  if (failure) {
    throw failure;
  }
  return result;
}

function originalReceipt(rows: StoredEvent[], silo: string, subject: string,
  memberId: string, reference: Reference) {
  const operationId = connectionOperationId(silo, subject, reference.changeRef);
  let original: StoredEvent | undefined;
  for (const row of rows) {
    if (!matchesProfile(row, silo, subject, memberId, reference)) {
      return null;
    }
    if (mentionsOperation(row, operationId, reference.changeRef)) {
      // Reject duplicate or conflicting records, including a closure for this operation.
      if (original) {
        return null;
      }
      original = row;
    }
  }
  if (!original) {
    return null;
  }
  const event = original.event;
  if (event.id !== operationId || event.commandId !== reference.changeRef ||
      event.source !== 'opencrane-server' || event.principal?.kind !== 'human' ||
      event.principal.id !== memberId) {
    return null;
  }
  const index = rows.indexOf(original);
  const preceding = rows.slice(0, index);
  const facts = operationFacts(original, preceding, memberId);
  if (!facts) {
    return null;
  }
  const receipt = receiptSchema.safeParse({ status: 'confirmed', changeRef: reference.changeRef,
    eventId: event.id, eventType: event.type, recordedAt: event.time,
    sequence: original.sequence, ...facts, identityStatus: 'unverified' });
  return receipt.success ? receipt.data : null;
}
function matchesProfile(row: StoredEvent, silo: string, subject: string,
  memberId: string, reference: Reference) {
  const identity = identitySchema.safeParse(row.event.data);
  return row.event.subject === subject && row.event.silo === silo && identity.success &&
    identity.data.userId === memberId && identity.data.serverId === reference.serverId &&
    identity.data.profile === reference.profileId;
}
function mentionsOperation(row: StoredEvent, operationId: string, changeRef: string) {
  const operation = operationSchema.safeParse(row.event.data);
  const activation = activationSchema.safeParse(row.event.data);
  return row.event.id === operationId || row.event.commandId === changeRef ||
    (operation.success && operation.data.operationId === operationId) ||
    (activation.success && activation.data.activation.operationId === operationId);
}
function operationFacts(row: StoredEvent, preceding: StoredEvent[], memberId: string) {
  const previous = foldConnection(preceding);
  if (row.sequence <= previous.sequence) {
    return null;
  }
  if (row.event.type === 'connection.revoked') {
    const parsed = revokedSchema.safeParse(row.event.data);
    if (!parsed.success || parsed.data.revokedBy !== memberId ||
        parsed.data.expectedSequence !== previous.sequence ||
        previous.status !== 'saved_unverified') {
      return null;
    }
    return { action: 'revoke', generation: null };
  }
  const parsed = savedSchema.safeParse(row.event.data);
  const throughOriginal = [...preceding, row];
  const saved = foldConnection(throughOriginal);
  if (!parsed.success || saved.status !== 'saved_unverified') {
    return null;
  }
  const action = row.event.type === 'connection.created' ? 'create' : 'rotate';
  return { action, generation: parsed.data.activation.generation };
}
