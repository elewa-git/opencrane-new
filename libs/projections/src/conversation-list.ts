import { conversationCreatedDataSchema } from '@opencrane/events';
import type { Query } from './db.ts';

type RevisionRow = { generation: string; activity: string | null; joined: string | null;
  removed: string | null; archived: string | null };

export async function conversationListRevision(db: Query, silo: string) {
  const result = await db.query<RevisionRow>(`SELECT generation,
    (SELECT max(latest_activity) FROM conversations WHERE silo=$1) AS activity,
    (SELECT max(join_position) FROM conversation_participants WHERE silo=$1) AS joined,
    (SELECT max(end_position) FROM conversation_participants WHERE silo=$1) AS removed,
    (SELECT max((state->>'archivePosition')::bigint) FROM conversation_list_state
      WHERE silo=$1) AS archived
    FROM projection_generations WHERE name='conversations'`, [silo]);
  const revision = result.rows[0];
  if (!revision) throw new Error('Conversation list unavailable');
  // Keep the first read marker from changing an otherwise empty archive revision.
  const archivePosition = String(revision['archived'] ?? 0);
  const current = { ...revision, archived: archivePosition };
  return JSON.stringify(current);
}

export async function conversationListCandidates(db: Query, silo: string,
  memberId: string, before: [number, number]) {
  const result = await db.query<{ conversation_id: string; data: unknown; time: string;
    kind: 'personal' | 'team' | null; join_event_id: string; state: unknown;
    latest_activity: string; join_position: string }>(
    `SELECT p.conversation_id, f.data, f.time, c.kind, p.join_event_id, s.state,
        p.latest_activity, p.join_position
      FROM conversation_participants p
      JOIN conversation_feed f ON f.silo=p.silo AND f.conversation_id=p.conversation_id
        AND f.type='conversation.created'
      LEFT JOIN computers c ON c.silo=f.silo AND c.assistant_id=f.data->>'assistantId'
      LEFT JOIN conversation_list_state s ON s.silo=p.silo AND s.member_id=p.participant_id
        AND s.conversation_id=p.conversation_id AND s.join_event_id=p.join_event_id
      WHERE p.silo=$1 AND p.participant_id=$2 AND p.end_position IS NULL
        AND (p.latest_activity, p.join_position) < ($3, $4)
      ORDER BY p.latest_activity DESC, p.join_position DESC LIMIT 100`,
    [silo, memberId, ...before]);
  function candidate(row: (typeof result.rows)[number]) {
    const data = conversationCreatedDataSchema.parse(row.data);
    const conversation = { ...data, conversationId: row.conversation_id, createdAt: row.time,
      assistantKind: row.kind ?? undefined };
    const scanPosition: [number, number] = [Number(row.latest_activity), Number(row.join_position)];
    return { conversation, joinEventId: row.join_event_id, state: row.state, scanPosition };
  }
  return result.rows.map(candidate);
}
