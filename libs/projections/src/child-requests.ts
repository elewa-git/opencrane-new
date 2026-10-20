import { childRetryRequestedEventSchema, childStartFailedEventSchema, childRequestedEventSchema,
  messagePostedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';
import type { Projection } from './runner.ts';

async function create(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS child_requests_v3 (
    silo TEXT NOT NULL, parent_id TEXT NOT NULL, intent_id TEXT NOT NULL,
    intent_position BIGINT NOT NULL, child_id TEXT NOT NULL, first_input_id TEXT NOT NULL,
    failed_attempt INTEGER, request_id TEXT NOT NULL, failure_id TEXT,
    PRIMARY KEY (silo, intent_id))`);
  await db.query(`CREATE INDEX IF NOT EXISTS child_requests_v3_input
    ON child_requests_v3 (silo, child_id, first_input_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS child_requests_v3_position
    ON child_requests_v3 (silo, intent_position)`);
}
async function drop(db: Query) {
  await db.query('DROP TABLE IF EXISTS child_requests_v3');
}
async function apply(db: Query, event: EventEnvelope, position: number) {
  if (event.type === 'conversation.child_requested') {
    const parsed = childRequestedEventSchema.parse(event);
    const data = parsed.data;
    await db.query(`INSERT INTO child_requests_v3 VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,NULL)
      ON CONFLICT DO NOTHING`, [event.silo, data.conversationId, event.id, position,
      data.childConversationId, data.firstInputId, data.requestId]);
  } else if (event.type === 'conversation.child_start_failed') {
    const { data } = childStartFailedEventSchema.parse(event);
    await db.query(`UPDATE child_requests_v3 SET failed_attempt = $1, failure_id = $6
      WHERE silo = $2 AND parent_id = $3 AND intent_id = $4 AND child_id = $5`,
    [data.attempt, event.silo, data.conversationId, data.intentEventId,
      data.childConversationId, event.id]);
  } else if (event.type === 'conversation.child_retry_requested') {
    const { data } = childRetryRequestedEventSchema.parse(event);
    const result = await db.query(`SELECT intent_id, failed_attempt FROM child_requests_v3
      WHERE silo = $1 AND parent_id = $2 AND request_id = $3 AND failure_id = $4`,
    [event.silo, data.conversationId, data.requestId, data.failureEventId]);
    for (const row of result.rows) {
      if (row['failed_attempt'] !== data.attempt - 1) continue;
      await db.query(`UPDATE child_requests_v3 SET failed_attempt = NULL, failure_id = NULL
        WHERE silo = $1 AND intent_id = $2`, [event.silo, row['intent_id']]);
    }
  } else if (event.type === 'message.posted') {
    const data = messagePostedDataSchema.parse(event.data);
    if (event.subject !== `conversation-${data.conversationId}`) {
      return;
    }
    await db.query(`DELETE FROM child_requests_v3
      WHERE silo = $1 AND child_id = $2 AND first_input_id = $3`,
    [event.silo, data.conversationId, event.id]);
  }
}

// Keep only event references. Rebuilding this list must never run child commands.
export const childRequests: Projection = { name: 'child-requests-v3', create, drop, apply };
