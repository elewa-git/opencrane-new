import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';

export const chatIdSchema = z.string().regex(/^[\w-]{1,200}$/u);
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
