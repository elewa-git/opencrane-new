import { conversationArchiveSetDataSchema, conversationReadAdvancedDataSchema,
  getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';

const preferenceSchema = conversationArchiveSetDataSchema.or(conversationReadAdvancedDataSchema);

type ListState = { archived: boolean; archivePosition: number; readPosition: number;
  throughPosition: number; throughEventId?: string; archiveEventId?: string;
  archiveCommandId?: string; readEventId?: string; readCommandId?: string };

export async function createConversationListState(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS conversation_list_state (
    silo TEXT NOT NULL, member_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
    join_event_id TEXT NOT NULL, state JSONB NOT NULL,
    PRIMARY KEY (silo, member_id, conversation_id, join_event_id))`);
}

export async function applyConversationPreference(db: Query, event: EventEnvelope,
  position: number): Promise<boolean> {
  if (getEventDefinition(event.type)?.stream !== 'chat-state') return false;
  const commandId = event.commandId;
  if (!parseEventByType(event).success || !commandId) {
    throw new Error('Invalid conversation preference');
  }
  const data = preferenceSchema.parse(event.data);
  const identity = [event.silo, data.memberId, data.conversationId, data.joinEventId];
  const joins = await db.query<{ join_position: string; end_position: string | null }>(
    `SELECT join_position, end_position FROM conversation_participants
      WHERE silo = $1 AND participant_id = $2 AND conversation_id = $3 AND join_event_id = $4`,
    identity);
  const join = joins.rows[0];
  if (!join) throw new Error('Invalid preference join');
  const saved = await db.query<{ state: ListState }>(
    `SELECT state FROM conversation_list_state
      WHERE silo = $1 AND member_id = $2 AND conversation_id = $3 AND join_event_id = $4`,
    identity);
  const state = saved.rows[0]?.state ?? {
    archived: false, archivePosition: 0, readPosition: 0, throughPosition: 0,
  };
  if ('archived' in data) {
    state.archived = data.archived;
    state.archivePosition = position;
    state.archiveEventId = event.id;
    state.archiveCommandId = commandId;
  } else {
    const target = await db.query<{ event_id: string }>(
      `SELECT event_id FROM conversation_feed
        WHERE silo = $1 AND conversation_id = $2 AND position = $3`,
      [event.silo, data.conversationId, data.throughPosition]);
    if (target.rows[0]?.event_id !== data.throughEventId ||
        data.throughPosition < Number(join.join_position) ||
        (join.end_position !== null && data.throughPosition >= Number(join.end_position))) {
      throw new Error('Invalid read reference');
    }
    // Keep the furthest checked row when another device reports an older read position.
    if (data.throughPosition > state.throughPosition) {
      state.throughPosition = data.throughPosition;
      state.throughEventId = data.throughEventId;
      state.readPosition = position;
      state.readEventId = event.id;
      state.readCommandId = commandId;
    }
  }
  // Keep old choices tied to their join. A later join starts with no saved choice.
  await db.query(`INSERT INTO conversation_list_state VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (silo, member_id, conversation_id, join_event_id) DO UPDATE SET state = $5`,
  [...identity, JSON.stringify(state)]);
  return true;
}
