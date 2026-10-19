import { childStartFailedEventSchema, childRequestedEventSchema, messagePostedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

async function create(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS child_requests_v2 (
    silo TEXT NOT NULL, parent_id TEXT NOT NULL, intent_id TEXT NOT NULL,
    intent_position BIGINT NOT NULL, child_id TEXT NOT NULL, first_input_id TEXT NOT NULL,
    failed_attempt INTEGER,
    PRIMARY KEY (silo, intent_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS child_requests_v2_input
    ON child_requests_v2 (silo, child_id, first_input_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS child_requests_v2_position
    ON child_requests_v2 (silo, intent_position)`);
}
async function drop(db: Query) {
  await db.query('DROP TABLE IF EXISTS child_requests_v2');
}
async function apply(db: Query, event: EventEnvelope, position: number) {
  if (event.type === 'conversation.child_requested') {
    const parsed = childRequestedEventSchema.parse(event);
    const data = parsed.data;
    await db.query(`INSERT INTO child_requests_v2 VALUES ($1,$2,$3,$4,$5,$6,NULL)
      ON CONFLICT DO NOTHING`, [event.silo, data.conversationId, event.id, position,
      data.childConversationId, data.firstInputId]);
  } else if (event.type === 'conversation.child_start_failed') {
    const { data } = childStartFailedEventSchema.parse(event);
    await db.query(`UPDATE child_requests_v2 SET failed_attempt = $1
      WHERE silo = $2 AND parent_id = $3 AND intent_id = $4 AND child_id = $5`,
    [data.attempt, event.silo, data.conversationId, data.intentEventId, data.childConversationId]);
  } else if (event.type === 'message.posted') {
    const data = messagePostedDataSchema.parse(event.data);
    if (event.subject !== `conversation-${data.conversationId}`) {
      return;
    }
    await db.query(`DELETE FROM child_requests_v2
      WHERE silo = $1 AND child_id = $2 AND first_input_id = $3`,
    [event.silo, data.conversationId, event.id]);
  }
}

// Keep only event references. Rebuilding this list must never run child commands.
export const childRequests: Projection = { name: 'child-requests-v2', create, drop, apply };
