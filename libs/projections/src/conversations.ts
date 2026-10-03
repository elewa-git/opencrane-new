import { decisionRecordedDataSchema } from '@opencrane/events';
import type { Projection } from './runner.ts';
import type { Query } from './db.ts';

export const conversations: Projection = {
  name: 'conversations',
  async create(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS conversation_feed (
      silo TEXT NOT NULL, conversation_id TEXT NOT NULL, position BIGINT NOT NULL,
      event_id TEXT NOT NULL, type TEXT NOT NULL, data JSONB NOT NULL, time TEXT NOT NULL,
      PRIMARY KEY (silo, conversation_id, position))`);
  },
  async drop(db) { await db.query('DROP TABLE IF EXISTS conversation_feed'); },
  async apply(db, event, position) {
    const decision = event.type === 'decision.recorded' ? decisionRecordedDataSchema.parse(event.data) : undefined;
    const refusal = decision?.route === 'model' && decision.outcome === 'deny' && decision.reason === 'budget_exhausted';
    const conversationId = refusal ? decision.conversationId : event.subject.startsWith('conversation-') ? event.subject.slice('conversation-'.length) : undefined;
    if (typeof conversationId !== 'string') return;
    const data = refusal ? { turnId: decision.turnId, reason: 'budget_exhausted' } : event.data;
    await db.query('INSERT INTO conversation_feed VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [event.silo, conversationId, position, event.id, event.type, JSON.stringify(data), event.time]);
    await db.query("SELECT pg_notify('conversations', $1)", [event.silo]);
  },
};

export async function readConversation(db: Query, silo: string, conversationId: string, since = 0) {
  const result = await db.query<{ position: string; event_id: string; type: string; data: unknown; time: string }>(
    'SELECT * FROM conversation_feed WHERE silo = $1 AND conversation_id = $2 AND position > $3 ORDER BY position LIMIT 100', [silo, conversationId, since]);
  const generation = await db.query<{ generation: string }>('SELECT generation FROM projection_generations WHERE name = $1', [conversations.name]);
  const head = await db.query<{ position: string | null }>('SELECT max(position) AS position FROM conversation_feed WHERE silo = $1 AND conversation_id = $2', [silo, conversationId]);
  return { generation: Number(generation.rows[0]?.generation ?? 0), position: Number(head.rows[0]?.position ?? 0),
    rows: result.rows.map(row => ({ position: Number(row.position), id: row.event_id, type: row.type, data: row.data, time: row.time })) };
}

export async function listConversations(db: Query, silo: string) {
  const rows = await db.query<{ conversation_id: string; data: { assistantId: string; createdBy: string; mode: 'agent_session' | 'direct' | 'group' }; time: string }>(
    "SELECT conversation_id, data, time FROM conversation_feed WHERE silo = $1 AND type = 'conversation.created' ORDER BY position DESC", [silo]);
  return rows.rows.map(row => ({ conversationId: row.conversation_id, ...row.data, createdAt: row.time }));
}
