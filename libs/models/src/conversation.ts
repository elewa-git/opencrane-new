import { conversationCreatedDataSchema, conversationParticipantIds } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';

export function conversationParticipation(creation: StoredEvent) {
  const created = conversationCreatedDataSchema.parse(creation.event.data);
  const participantIds = conversationParticipantIds(created);
  const joins = new Map<string, StoredEvent>();
  for (const participantId of participantIds) {
    joins.set(participantId, creation);
  }
  return { created, joins };
}

export function conversationHistoryPosition(creation: StoredEvent, join: StoredEvent) {
  const created = conversationCreatedDataSchema.parse(creation.event.data);
  // Release shared child history from creation while keeping the authority join separate.
  if ('contextKind' in created) return creation.sequence;
  return join.sequence;
}
