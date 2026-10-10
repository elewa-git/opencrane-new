import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';

export const chatIdSchema = z.string().min(1).max(200).regex(/^[^.*>\s]+$/u);
function isUserConversation(id: string) {
  return !id.startsWith('provider-');
}
const conversationId = chatIdSchema.refine(isUserConversation, 'Reserved conversation prefix');

function hasGroupAudience(data: { createdBy: string; participantIds: string[] }) {
  const distinct = new Set(data.participantIds);
  return distinct.size === data.participantIds.length && distinct.has(data.createdBy);
}
function hasPairedSnapshot(data: {
  groupId?: string | undefined; groupSnapshotPosition?: number | undefined;
}) {
  return (data.groupId === undefined) === (data.groupSnapshotPosition === undefined);
}
const participants = z.array(chatIdSchema);
const minimumAudience = participants.min(2);
const boundedAudience = minimumAudience.max(100);
const snapshotPosition = z.int().nonnegative();
const groupData = z.strictObject({
  conversationId, createdBy: chatIdSchema, mode: z.literal('group'),
  participantIds: boundedAudience, groupId: chatIdSchema.optional(),
  groupSnapshotPosition: snapshotPosition.optional(),
});
const groupAudience = groupData.refine(hasGroupAudience,
  'Require distinct participants including the creator');
export const groupConversationSchema = groupAudience.refine(hasPairedSnapshot,
  'Require both group snapshot fields');

function fitsDefaultTupleWrite(data: { participantIds: string[] }) {
  // Leave three tuples for the creator, silo and event receipt in OpenFGA's 100-tuple write.
  return data.participantIds.length <= 97;
}
// Keep older 100-person records readable. Restrict only new creation commands.
export const groupConversationCommandSchema = groupConversationSchema.refine(fitsDefaultTupleWrite,
  'Group conversations allow at most 97 people including the creator');

const parentJoin = z.strictObject({
  participantId: chatIdSchema, parentJoinEventId: chatIdSchema,
  parentJoinPosition: z.int().positive(),
});
const childOrigin = z.strictObject({
  parentConversationId: conversationId, sourceMessageId: chatIdSchema,
  sourcePosition: z.int().positive(), intentEventId: chatIdSchema,
  intentPosition: z.int().positive(), requestId: chatIdSchema, firstInputId: chatIdSchema,
});
const childData = z.strictObject({
  conversationId, mode: z.literal('agent_session'), contextKind: z.literal('shared_child'),
  assistantId: chatIdSchema, payingGroupId: chatIdSchema, createdBy: chatIdSchema,
  origin: childOrigin, initialJoins: z.array(parentJoin).min(1).max(97),
});
function hasValidChildReferences(data: z.infer<typeof childData>) {
  const people = new Set<string>();
  for (const join of data.initialJoins) {
    if (people.has(join.participantId) || join.parentJoinPosition >= data.origin.sourcePosition) {
      return false;
    }
    people.add(join.participantId);
  }
  return people.has(data.createdBy)
    && data.origin.parentConversationId !== data.conversationId
    && data.origin.intentPosition > data.origin.sourcePosition;
}
export const sharedChildConversationSchema = childData.refine(hasValidChildReferences,
  'Require distinct people including the creator and ordered parent references');

export const childParticipantAddedSchema = z.strictObject({
  conversationId, participantId: chatIdSchema, addedBy: chatIdSchema,
  contextKind: z.literal('shared_child'), joinKind: z.literal('explicit_child'),
  reviewPosition: z.int().positive(),
});
export const childParticipantRemovedSchema = z.strictObject({
  conversationId, participantId: chatIdSchema, removedBy: chatIdSchema,
  contextKind: z.literal('shared_child'), reviewPosition: z.int().positive(),
});

/** Match the recorded id exactly. Accept old participant subjects only when reading history. */
export function conversationEventId(event: EventEnvelope): string {
  if (typeof event.data !== 'object' || event.data === null || !event.silo) {
    throw new Error('Invalid conversation identity');
  }
  const id: unknown = Reflect.get(event.data, 'conversationId');
  if (typeof id !== 'string' || !id) throw new Error('Invalid conversation identity');
  const participant = ['participant.added', 'participant.removed'].includes(event.type);
  const legacySubject = `conversation-${id}`;
  if (event.subject !== legacySubject && !(participant && event.subject === `participation-${id}`)) {
    throw new Error('Conversation subject mismatch');
  }
  return id;
}

const preferenceFields = { conversationId, memberId: chatIdSchema,
  joinEventId: z.string().min(1) };
export const conversationArchiveSetDataSchema = z.strictObject({
  ...preferenceFields, archived: z.boolean(),
});
export const conversationReadAdvancedDataSchema = z.strictObject({
  ...preferenceFields, throughPosition: z.int().positive(), throughEventId: z.string().min(1),
});

export function validPreferenceIdentity(event: EventEnvelope): boolean {
  if (typeof event.data !== 'object' || event.data === null) return false;
  const memberId: unknown = Reflect.get(event.data, 'memberId');
  return typeof memberId === 'string' && event.subject === `chat-state-${memberId}` &&
    event.principal?.kind === 'human' && event.principal.id === memberId &&
    event.commandId !== undefined;
}
