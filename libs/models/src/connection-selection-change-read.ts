import { z } from 'zod';
import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { connectionSelectedDataSchema } from '@opencrane/events';
import { validSelectionIdentity } from './connection-selection.ts';
import { history } from './event-history.ts';
import { readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ serverId: id, changeRef: id });
const receiptFields = {
  status: z.literal('confirmed'), changeRef: id, eventId: z.string().regex(/^[0-9a-f]{64}$/u),
  eventType: z.literal('connection.selected'), recordedAt: z.iso.datetime(),
  sequence: z.int().positive(),
};
const receiptSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...receiptFields, action: z.literal('select'),
    profileId: id, profileRevision: z.int().positive() }),
  z.strictObject({ ...receiptFields, action: z.literal('clear') }),
]);
type Reference = z.infer<typeof referenceSchema>;

/** Read a saved choice without changing it or claiming that it can still be used. */
export async function readOwnSelectionChange(store: EventStore, binding: Binding,
  memberId: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  id.parse(memberId);
  const subject = `connection-selection-${memberId}-${reference.serverId}`;
  let result: z.infer<typeof receiptSchema> | null = null;
  let failure: Error | undefined;
  try {
    const rows = await history(store, subject, binding.silo, performance.now() + 10_000);
    result = originalReceipt(rows, binding.silo, subject, memberId, reference);
  } catch (error) {
    failure = new Error('Selection history unavailable', { cause: error });
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
  let previousSequence = 0;
  let original: StoredEvent | undefined;
  for (const row of rows) {
    const parsed = connectionSelectedDataSchema.safeParse(row.event.data);
    if (!parsed.success || !validSelectionIdentity(row, parsed.data) ||
        row.event.silo !== silo || row.event.subject !== subject ||
        !id.safeParse(row.event.commandId).success ||
        parsed.data.userId !== memberId || parsed.data.serverId !== reference.serverId ||
        parsed.data.expectedSequence !== previousSequence || row.sequence <= previousSequence) {
      return null;
    }
    previousSequence = row.sequence;
    if (row.event.commandId === reference.changeRef) {
      // Refuse repeated references even when each record is otherwise valid.
      if (original) {
        return null;
      }
      original = row;
    }
  }
  if (!original) {
    return null;
  }
  return selectionReceipt(original);
}

function selectionReceipt(original: StoredEvent) {
  const selected = connectionSelectedDataSchema.parse(original.event.data);
  const fields = { status: 'confirmed', changeRef: original.event.commandId,
    eventId: original.event.id, eventType: original.event.type, recordedAt: original.event.time,
    sequence: original.sequence, action: selected.action };
  let receipt: unknown = fields;
  if (selected.action === 'select') {
    receipt = { ...fields, profileId: selected.profileId, profileRevision: selected.profileRevision };
  }
  const parsed = receiptSchema.safeParse(receipt);
  return parsed.success ? parsed.data : null;
}
