import { matchesConversationRead } from '@opencrane/event-store';
import { z } from 'zod';
import type { EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';

export async function createDecisionConversationIndex(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS decision_conversation_events (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, position BIGINT NOT NULL,
    event_id TEXT NOT NULL, type TEXT NOT NULL, turn_id TEXT,
    PRIMARY KEY (silo, conversation_id, position))`);
  await db.query(`CREATE TABLE IF NOT EXISTS decision_conversation_coverage (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, event_count BIGINT NOT NULL,
    position BIGINT NOT NULL, PRIMARY KEY (silo, conversation_id))`);
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
  const subject = `conversation-${conversationId}`;
  if (!matchesConversationRead(event, subject)) return;
  const turnId = typeof fields['turnId'] === 'string' ? fields['turnId'] : null;
  await db.query(`INSERT INTO decision_conversation_events VALUES ($1,$2,$3,$4,$5,$6)`,
    [event.silo, conversationId, position, event.id, event.type, turnId]);
  // Save the expected size independently so a missing refusal row cannot look complete.
  await db.query(`INSERT INTO decision_conversation_coverage VALUES ($1,$2,1,$3)
    ON CONFLICT (silo, conversation_id) DO UPDATE
      SET event_count=decision_conversation_coverage.event_count+1, position=$3`,
  [event.silo, conversationId, position]);
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
  await requireCompleteDecisionIndex(db, lookup);
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

async function requireCompleteDecisionIndex(db: Query, lookup: DecisionConversationLookup) {
  const result = await db.query<{ expected: string; actual: string; position: string;
    latest: string | null }>(`SELECT coverage.event_count AS expected,
      coverage.position, count(events.position)::text AS actual,
      max(events.position)::text AS latest
    FROM decision_conversation_coverage coverage
    LEFT JOIN decision_conversation_events events
      USING (silo, conversation_id)
    WHERE coverage.silo=$1 AND coverage.conversation_id=$2
    GROUP BY coverage.event_count, coverage.position`,
  [lookup.silo, lookup.conversationId], { deadline: lookup.deadline });
  const counts = result.rows[0];
  if (!counts || counts.expected !== counts.actual || counts.position !== counts.latest) {
    throw new Error('Conversation index is incomplete; rebuild conversation history');
  }
}
