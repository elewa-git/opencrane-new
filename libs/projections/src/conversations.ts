import { conversationParticipantIds, conversationCreatedDataSchema, conversationEventId,
  decisionRecordedDataSchema, messagePostedDataSchema,
  toolDispatchRecordedDataSchema,
  getEventDefinition, parseEventByType, type EventEnvelope } from '@opencrane/events';
import { ProjectionRunner, type EventSource, type Projection } from './runner.ts';
import type { Logger } from '@opencrane/observability';
import type { Db, Query } from './db.ts';
import { createConversationListState, applyConversationPreference }
  from './conversation-list-state.ts';

export const conversations: Projection = {
  name: 'conversations',
  async create(db) {
    await requireLegacyReplay(db);
    await requireActivityReplay(db);
    await createConversationTables(db);
    await refuseMissingParticipation(db);
  },
  async drop(db) {
    const tables = 'conversation_participants, conversations, conversation_feed, ' +
      'conversation_legacy_participation, conversation_list_state';
    await db.query(`DROP TABLE IF EXISTS ${tables}`);
  },
  async apply(db, event, position) {
    if (await applyConversationPreference(db, event, position)) return;
    const entry = conversationFeedEntry(event);
    if (!entry) return;
    const { conversationId, data } = entry;
    await validateMode(db, event, conversationId);
    await foldConversation(db, event, conversationId, position);
    if (event.subject === `conversation-${conversationId}` &&
        event.type.startsWith('participant.')) {
      await db.query('INSERT INTO conversation_legacy_participation VALUES ($1,$2,$3,$4)',
        [event.silo, conversationId, position, event.id]);
    }
    await db.query('INSERT INTO conversation_feed VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [event.silo, conversationId, position, event.id, event.type, JSON.stringify(data), event.time]);
    await db.query("SELECT pg_notify('conversations', $1)", [event.silo]);
  },
};

async function requireActivityReplay(db: Query): Promise<void> {
  const result = await db.query<{ name: string | null }>(
    "SELECT to_regclass('conversations')::text AS name");
  const table = result.rows[0];
  if (!table?.name) return;
  const columns = await db.query<{ attname: string }>(`SELECT attname FROM pg_attribute
    WHERE attrelid = 'conversations'::regclass AND NOT attisdropped
      AND attname IN ('closed_event_id', 'closed_position', 'closed_by', 'closed_at')`);
  const participantColumns = await db.query(`SELECT attname FROM pg_attribute
    WHERE attrelid = to_regclass('conversation_participants') AND NOT attisdropped
      AND attname = 'latest_activity'`);
  if (columns.rows.length !== 4 || participantColumns.rows.length !== 1) {
    throw new Error('Conversation tables need rebuilding. Stop conversation readers and workers, '
      + 'then run npm run replay -- conversations --confirm-conversations-stopped');
  }
}

async function requireLegacyReplay(db: Query) {
  const result = await db.query<{ feed: string | null; legacy: string | null }>(
    `SELECT to_regclass('conversation_feed')::text AS feed,
      to_regclass('conversation_legacy_participation')::text AS legacy`);
  const tables = result.rows[0];
  if (!tables?.feed || tables.legacy) return;
  const saved = await db.query<{ position: string }>(
    `SELECT position FROM conversation_feed
      WHERE type IN ('participant.added', 'participant.removed') LIMIT 1`);
  if (saved.rows.length) {
    throw new Error('Conversation tables need rebuilding. Stop conversation readers and workers, '
      + 'then run npm run replay -- conversations --confirm-conversations-stopped');
  }
}

async function createConversationTables(db: Query): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS conversation_feed (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, position BIGINT NOT NULL,
    event_id TEXT NOT NULL, type TEXT NOT NULL, data JSONB NOT NULL, time TEXT NOT NULL,
    PRIMARY KEY (silo, conversation_id, position))`);
  await createParticipationTables(db);
  await createConversationListState(db);
  await db.query(`CREATE TABLE IF NOT EXISTS conversation_legacy_participation (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, position BIGINT NOT NULL,
    event_id TEXT NOT NULL, PRIMARY KEY (silo, conversation_id, position))`);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_feed_silo_type
    ON conversation_feed (silo, type)`);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_feed_message_event
    ON conversation_feed (silo, conversation_id, event_id) WHERE type='message.posted'`);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_feed_message_reply
    ON conversation_feed (silo, conversation_id, (data->>'messageId'))
    WHERE type='agent.message_completed'`);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_feed_participation
    ON conversation_feed (silo, conversation_id, position)
    WHERE type IN ('participant.added', 'participant.removed')`);
}

async function refuseMissingParticipation(db: Query): Promise<void> {
  const result = await db.query<{ has_creations: boolean; has_conversations: boolean;
    has_participants: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM conversation_feed WHERE type = 'conversation.created') AS has_creations,
      EXISTS (SELECT 1 FROM conversations) AS has_conversations,
      EXISTS (SELECT 1 FROM conversation_participants) AS has_participants`);
  const state = result.rows[0];
  if (state?.has_creations && (!state.has_conversations || !state.has_participants)) {
    throw new Error('Conversation tables need rebuilding. Stop conversation readers and workers, '
      + 'then run npm run replay -- conversations --confirm-conversations-stopped');
  }
}

/** Stop readers and workers before replacing the feed and participation tables. */
export async function rebuildConversationsProjection(db: Db, source: EventSource, logger: Logger) {
  if (!db.lock) {
    throw new Error('Conversations replay requires projection locking');
  }
  // Initialise runner records before rebuilding old tables and creating new indexes.
  async function initialiseReplay() {
    // Leave old tables intact until rebuild drops them and creates the new shape.
  }
  const initialProjection: Projection = { ...conversations, create: initialiseReplay };
  const replayProjection: Projection = { ...conversations, create: createConversationTables };
  async function rebuild(locked: Db): Promise<number> {
    const runner = new ProjectionRunner(locked, source, logger);
    await runner.initialise(initialProjection);
    await runner.rebuild(replayProjection);
    return runner.checkpoint(replayProjection);
  }
  return db.lock(conversations.name, rebuild);
}

function conversationFeedEntry(event: EventEnvelope) {
  // Keep private memory evidence in the event log, away from public chat replies.
  if (event.type === 'agent.memory_context_recorded' ||
      event.type === 'conversation.child_requested') return;
  if (event.type === 'decision.recorded') {
    const decision = decisionRecordedDataSchema.parse(event.data);
    const conversationId = decision.conversationId;
    if (!conversationId) return;
    if (decision.route === 'mcp') {
      const data = { turnId: decision.turnId, callId: decision.callId, outcome: decision.outcome,
        reason: decision.reason, requestId: decision.requestId,
        approvalId: event.correlation.approval };
      return { conversationId, data };
    }
    if (decision.route === 'model' && decision.outcome === 'deny'
      && decision.reason === 'budget_exhausted') {
      return { conversationId, data: { turnId: decision.turnId, reason: decision.reason } };
    }
    return;
  }
  if (event.type === 'tool.dispatch_recorded') {
    const data = toolDispatchRecordedDataSchema.parse(event.data);
    return { conversationId: data.conversationId, data };
  }
  const stream = getEventDefinition(event.type)?.stream;
  if (stream !== 'conversation' && stream !== 'participation') return;
  const parsed = parseEventByType(event);
  if (!parsed.success) throw new Error('Invalid conversation event');
  const conversationId = conversationEventId(parsed.event);
  const data = parsed.event.data;
  return { conversationId, data };
}

type FeedRow = { position: string; event_id: string; type: string; data: unknown; time: string };

export async function readConversation(db: Query, silo: string, conversationId: string, since = 0) {
  const deadline = performance.now() + 10_000;
  // Read the boundary and close together. Later appends belong to the next request.
  const metadata = await db.query<{ position: string | null; closed_position: string | null;
    generation: string | null }>(
    `SELECT (SELECT max(position) FROM conversation_feed
        WHERE silo=$1 AND conversation_id=$2) AS position,
      (SELECT closed_position FROM conversations
        WHERE silo=$1 AND conversation_id=$2) AS closed_position,
      (SELECT generation FROM projection_generations WHERE name='conversations') AS generation`,
    [silo, conversationId]);
  const position = Number(metadata.rows[0]?.position ?? 0);
  const closedPosition = Number(metadata.rows[0]?.closed_position ?? 0);
  const rows: ReturnType<typeof displayRow>[] = [];
  let scannedPosition = since;
  while (scannedPosition < position && rows.length < 100) {
    const page = await db.query<FeedRow>(
      `SELECT * FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
        AND position > $3 AND position <= $4 ORDER BY position LIMIT $5`,
      [silo, conversationId, scannedPosition, position, 100 - rows.length]);
    if (performance.now() >= deadline) throw new Error('Conversation history unavailable');
    if (!page.rows.length) break;
    for (const row of page.rows) {
      // Advance past hidden reports too, without changing a visible row's saved position.
      scannedPosition = Number(row.position);
      if (isHiddenConversationRow(row.type, row.data, scannedPosition, closedPosition)) continue;
      rows.push(displayRow(row));
    }
  }
  return { generation: Number(metadata.rows[0]?.generation ?? 0), position, rows };
}

export function isHiddenConversationRow(type: string, data: unknown, position: number,
  closedPosition: number) {
  if (closedPosition === 0 || position <= closedPosition) return false;
  // Keep human posts that were saved after close, but freeze all other displayed output.
  if (type !== 'message.posted') return true;
  const post = messagePostedDataSchema.safeParse(data);
  return !post.success || post.data.authorKind !== 'human';
}

function displayRow(row: FeedRow) {
  return { position: Number(row.position), id: row.event_id, type: row.type,
    data: row.data, time: row.time };
}

export async function listConversations(db: Query, silo: string, memberId?: string) {
  const rows = await db.query<{ conversation_id: string; data: unknown; time: string;
    kind: 'personal' | 'team' | null }>(
    `SELECT f.conversation_id, f.data, f.time, c.kind FROM conversation_feed f
      LEFT JOIN computers c ON c.silo = f.silo AND c.assistant_id = f.data->>'assistantId'
      WHERE f.silo = $1 AND f.type = 'conversation.created'
        AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM conversation_participants p
          WHERE p.silo = f.silo AND p.conversation_id = f.conversation_id
            AND p.participant_id = $2 AND p.end_position IS NULL))
      ORDER BY f.position DESC`, [silo, memberId ?? null]);
  function conversationRow(row: (typeof rows.rows)[number]) {
    const data = conversationCreatedDataSchema.parse(row.data);
    return { ...data, conversationId: row.conversation_id, createdAt: row.time,
      assistantKind: row.kind ?? undefined };
  }
  return rows.rows.map(conversationRow);
}

export async function listOpenConversations(db: Query, silo: string) {
  const rows = await db.query<{
    conversation_id: string; type: string; data: unknown; time: string;
  }>(
    `SELECT conversation_id, type, data, time FROM conversation_feed
      WHERE silo = $1 AND type IN ('conversation.created', 'conversation.closed')`, [silo]);
  const closed = new Set<string>();
  const created = new Map<string, { data: unknown; time: string }>();
  for (const row of rows.rows) {
    if (row.type === 'conversation.closed') {
      closed.add(row.conversation_id);
      continue;
    }
    created.set(row.conversation_id, { data: row.data, time: row.time });
  }
  const sessions = [];
  for (const [conversationId, row] of created) {
    if (closed.has(conversationId)) continue;
    const data = conversationCreatedDataSchema.parse(row.data);
    sessions.push({ ...data, conversationId, createdAt: row.time });
  }
  return sessions;
}

async function validateMode(db: Query, event: EventEnvelope, conversationId: string) {
  const result = await db.query<{ data: unknown }>(
    `SELECT data FROM conversation_feed
      WHERE silo = $1 AND conversation_id = $2 AND type = 'conversation.created'`,
    [event.silo, conversationId]);
  const original = result.rows[0];
  if (!original) return;
  const created = conversationCreatedDataSchema.parse(original.data);
  if (created.mode !== 'direct') {
    if (event.type === 'conversation.created') throw new Error('Conversation mode is immutable');
    return;
  }
  if (!['message.posted', 'conversation.closed'].includes(event.type)) {
    throw new Error('Direct conversation is immutable');
  }
}

async function createParticipationTables(db: Query) {
  await db.query(`CREATE TABLE IF NOT EXISTS conversations (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, mode TEXT NOT NULL,
    created_by TEXT NOT NULL, group_id TEXT, group_snapshot_position BIGINT,
    closed BOOLEAN NOT NULL, position BIGINT NOT NULL, latest_activity BIGINT NOT NULL,
    closed_event_id TEXT, closed_position BIGINT, closed_by TEXT, closed_at TEXT,
    PRIMARY KEY (silo, conversation_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS conversation_participants (
    silo TEXT NOT NULL, conversation_id TEXT NOT NULL, participant_id TEXT NOT NULL,
    join_position BIGINT NOT NULL, join_event_id TEXT NOT NULL,
    end_position BIGINT, end_event_id TEXT, latest_activity BIGINT NOT NULL,
    PRIMARY KEY (silo, conversation_id, participant_id, join_position))`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_participants_current
    ON conversation_participants (silo, conversation_id, participant_id)
    WHERE end_position IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS conversation_participants_activity
    ON conversation_participants (silo, participant_id, latest_activity DESC, join_position DESC)
    WHERE end_position IS NULL`);
}

async function foldConversation(db: Query, event: EventEnvelope,
  conversationId: string, position: number) {
  if (event.type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(event.data);
    let groupId: string | undefined;
    let snapshot: number | undefined;
    if (created.mode === 'group') {
      groupId = created.groupId;
      snapshot = created.groupSnapshotPosition;
    }
    const values = [event.silo, conversationId, created.mode, created.createdBy,
      groupId ?? null, snapshot ?? null, false, position, position];
    await db.query(`INSERT INTO conversations
      (silo, conversation_id, mode, created_by, group_id, group_snapshot_position,
        closed, position, latest_activity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, values);
    const participantIds = conversationParticipantIds(created);
    for (const participantId of participantIds) {
      await startParticipant(db, event, conversationId, participantId, position);
    }
    return;
  }
  const state = await db.query<ConversationActivity>(
    `SELECT closed, latest_activity, closed_event_id, closed_position, closed_by, closed_at
      FROM conversations WHERE silo = $1 AND conversation_id = $2`,
    [event.silo, conversationId]);
  const conversation = state.rows[0];
  // Refuse participant events without creation in this silo, including foreign ids.
  if (event.type.startsWith('participant.')) {
    if (!conversation) throw new Error('Missing conversation in silo');
    await foldParticipant(db, event, conversationId, position);
  }
  if (!conversation) return;
  foldActivity(conversation, event, position);
  if (conversation.latest_activity === String(position)) {
    await db.query(`UPDATE conversation_participants SET latest_activity = $3
      WHERE silo = $1 AND conversation_id = $2 AND end_position IS NULL`,
    [event.silo, conversationId, position]);
  }
  const values = [event.silo, conversationId, conversation.closed, position,
    conversation.latest_activity, conversation.closed_event_id, conversation.closed_position,
    conversation.closed_by, conversation.closed_at];
  await db.query(`UPDATE conversations SET closed = $3, position = $4, latest_activity = $5,
      closed_event_id = $6, closed_position = $7, closed_by = $8, closed_at = $9
    WHERE silo = $1 AND conversation_id = $2`, values);
}

type ConversationActivity = {
  closed: boolean;
  latest_activity: string;
  closed_event_id: string | null;
  closed_position: string | null;
  closed_by: string | null;
  closed_at: string | null;
};

function foldActivity(state: ConversationActivity, event: EventEnvelope, position: number): void {
  // Keep the first close and the last visible message even when reports arrive later.
  if (state.closed) return;
  if (event.type === 'message.posted' || event.type === 'agent.message_completed') {
    state.latest_activity = String(position);
  }
  if (event.type !== 'conversation.closed') return;
  if (typeof event.data !== 'object' || event.data === null) {
    throw new Error('Invalid conversation close');
  }
  const closedBy: unknown = Reflect.get(event.data, 'closedBy');
  if (typeof closedBy !== 'string') throw new Error('Invalid closing person');
  state.closed = true;
  state.latest_activity = String(position);
  state.closed_event_id = event.id;
  state.closed_position = String(position);
  state.closed_by = closedBy;
  state.closed_at = event.time;
}

async function startParticipant(db: Query, event: EventEnvelope,
  conversationId: string, participantId: string, position: number) {
  // Start ordinary late joins without activity from before they could read the chat.
  let latestActivity = 0;
  if (event.type === 'conversation.created') latestActivity = position;
  if (typeof event.data === 'object' && event.data !== null && 'contextKind' in event.data) {
    const result = await db.query<{ latest_activity: string }>(
      'SELECT latest_activity FROM conversations WHERE silo = $1 AND conversation_id = $2',
      [event.silo, conversationId]);
    latestActivity = Number(result.rows[0]?.latest_activity ?? position);
  }
  await db.query(`INSERT INTO conversation_participants
    VALUES ($1,$2,$3,$4,$5,NULL,NULL,$6)`,
    [event.silo, conversationId, participantId, position, event.id, latestActivity]);
}

async function foldParticipant(db: Query, event: EventEnvelope,
  conversationId: string, position: number) {
  if (typeof event.data !== 'object' || event.data === null) {
    throw new Error('Invalid participant data');
  }
  const participantId: unknown = Reflect.get(event.data, 'participantId');
  if (typeof participantId !== 'string') throw new Error('Invalid participant id');
  const current = await db.query<{ participant_id: string }>(
    `SELECT participant_id FROM conversation_participants
      WHERE silo = $1 AND conversation_id = $2 AND end_position IS NULL`,
    [event.silo, conversationId]);
  function matchesParticipant(row: { participant_id: string }) {
    return row.participant_id === participantId;
  }
  const active = current.rows.some(matchesParticipant);
  if (event.type === 'participant.added' && !active) {
    if (current.rows.length >= 97) throw new Error('Conversation participant limit');
    await startParticipant(db, event, conversationId, participantId, position);
  }
  if (event.type === 'participant.removed' && active) {
    // End this interval exclusively. A later join must start a separate interval.
    await db.query(`UPDATE conversation_participants SET end_position = $4, end_event_id = $5
      WHERE silo = $1 AND conversation_id = $2 AND participant_id = $3 AND end_position IS NULL`,
    [event.silo, conversationId, participantId, position, event.id]);
  }
}
