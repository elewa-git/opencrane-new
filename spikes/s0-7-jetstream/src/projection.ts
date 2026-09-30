// A tiny PGlite-backed projection: a real Postgres engine (embedded, no
// server process) standing in for the CNPG Postgres content database.
// The point being tested is that a projection row and the consumer's
// checkpoint land in ONE atomic transaction, so a crash mid-stream can
// never apply an event twice or skip one.
import { PGlite } from "@electric-sql/pglite";

export async function openProjectionDb(dataDir: string): Promise<PGlite> {
  const db = new PGlite(dataDir);
  await db.waitReady;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_projection (
      conversation_id TEXT PRIMARY KEY,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_message TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS consumer_checkpoint (
      consumer_name TEXT PRIMARY KEY,
      last_stream_seq BIGINT NOT NULL DEFAULT 0
    );
    -- Records every event id this projection has ever applied. Its PRIMARY
    -- KEY makes a second apply of the same event id fail loudly instead of
    -- silently double-counting, so "no event applied twice" is provable,
    -- not just asserted.
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      stream_seq BIGINT NOT NULL
    );
  `);
  return db;
}

export async function getCheckpoint(db: PGlite, consumerName: string): Promise<number> {
  const res = await db.query<{ last_stream_seq: string }>(
    `SELECT last_stream_seq FROM consumer_checkpoint WHERE consumer_name = $1`,
    [consumerName],
  );
  if (res.rows.length === 0) return 0;
  return Number(res.rows[0].last_stream_seq);
}

export interface ConversationEvent {
  eventId: string;
  conversationId: string;
  text: string;
}

/** Applies one event to the projection and advances the checkpoint, both in
 * the same Postgres transaction — the property the spike must prove. */
export async function applyEventTransactionally(
  db: PGlite,
  consumerName: string,
  streamSeq: number,
  event: ConversationEvent,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`INSERT INTO processed_events (event_id, stream_seq) VALUES ($1, $2)`, [
      event.eventId,
      streamSeq,
    ]);
    await tx.query(
      `INSERT INTO conversation_projection (conversation_id, message_count, last_message, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (conversation_id)
       DO UPDATE SET message_count = conversation_projection.message_count + 1,
                     last_message = EXCLUDED.last_message,
                     updated_at = now()`,
      [event.conversationId, event.text],
    );
    await tx.query(
      `INSERT INTO consumer_checkpoint (consumer_name, last_stream_seq)
       VALUES ($1, $2)
       ON CONFLICT (consumer_name) DO UPDATE SET last_stream_seq = EXCLUDED.last_stream_seq`,
      [consumerName, streamSeq],
    );
  });
}

export async function dumpProjection(
  db: PGlite,
): Promise<Array<{ conversation_id: string; message_count: number; last_message: string | null }>> {
  const res = await db.query<{
    conversation_id: string;
    message_count: number;
    last_message: string | null;
  }>(`SELECT conversation_id, message_count, last_message FROM conversation_projection ORDER BY conversation_id`);
  return res.rows;
}

export async function processedEventCount(db: PGlite): Promise<number> {
  const res = await db.query<{ count: string }>(`SELECT count(*)::text FROM processed_events`);
  return Number(res.rows[0].count);
}

export async function dropProjectionTables(db: PGlite): Promise<void> {
  await db.exec(`
    TRUNCATE conversation_projection, consumer_checkpoint, processed_events;
  `);
}
