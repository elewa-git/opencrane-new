import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';

export async function createDecisionConversationIndex(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS decision_conversation_events (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, position BIGINT NOT NULL,
    event_id TEXT NOT NULL, type TEXT NOT NULL, turn_id TEXT,
    PRIMARY KEY (silo, conversation_id, position))`);
  await db.query(`CREATE INDEX IF NOT EXISTS decision_conversation_turn
    ON decision_conversation_events (silo, conversation_id, turn_id, position)`);
  await db.query(`CREATE INDEX IF NOT EXISTS decision_conversation_type
    ON decision_conversation_events (silo, conversation_id, type, position)`);
  await db.query(`CREATE INDEX IF NOT EXISTS decision_conversation_event
    ON decision_conversation_events (silo, conversation_id, event_id)`);
}

export async function indexDecisionConversationEvent(db: Query, event: EventEnvelope,
  position: number) {
  const conversation = event.subject.startsWith('conversation-');
  const participation = event.subject.startsWith('participation-');
  if (!conversation && !participation) return;
  const fields = z.record(z.string(), z.unknown()).parse(event.data);
  const prefix = conversation ? 'conversation-' : 'participation-';
  const conversationId = event.subject.slice(prefix.length);
  const turnId = typeof fields['turnId'] === 'string' ? fields['turnId'] : null;
  await db.query(`INSERT INTO decision_conversation_events VALUES ($1,$2,$3,$4,$5,$6)`,
    [event.silo, conversationId, position, event.id, event.type, turnId]);
}

export type DecisionConversationLookup = {
  silo: string;
  conversationId: string;
  turnId: string;
  metadataTypes: string[];
  latestTypes: string[];
  deadline: number;
  head: number;
  ignoredTypes: readonly string[];
};

export async function decisionConversationPositions(db: Query, lookup: DecisionConversationLookup) {
  const options = { deadline: lookup.deadline };
  const checkpoint = await db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['conversations'], options);
  const checkpointPosition = Number(checkpoint.rows[0]?.sequence);
  const position = Math.min(checkpointPosition, lookup.head);
  if (!Number.isSafeInteger(position) || position <= 0) {
    throw new Error('Conversation projection unavailable');
  }
  const parameters = [lookup.silo, lookup.conversationId, position, lookup.turnId,
    lookup.metadataTypes, lookup.latestTypes, lookup.ignoredTypes];
  const result = await db.query<{ position: string; event_id: string; type: string }>(`
    SELECT position, event_id, type FROM decision_conversation_events
      WHERE silo=$1 AND conversation_id=$2 AND position <= $3
        AND ((turn_id=$4 AND NOT(type=ANY($7))) OR event_id=$4 OR type=ANY($5))
    UNION
    SELECT position, event_id, type FROM (
      SELECT DISTINCT ON (type) position, event_id, type
        FROM decision_conversation_events
        WHERE silo=$1 AND conversation_id=$2 AND position <= $3 AND type=ANY($6)
        ORDER BY type, position DESC
    ) latest ORDER BY position`, parameters, options);
  return { checkpointPosition, position, rows: result.rows };
}
