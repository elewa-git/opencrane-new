import { conversationCreatedDataSchema } from '@opencrane/events';
import { z } from 'zod';
import type { Query } from './db.ts';

type Candidate = Awaited<ReturnType<typeof conversationListCandidates>>[number];

// Include only candidates that the server has authorised for this person.
export async function conversationListRevision(db: Query, candidates: Candidate[]) {
  const result = await db.query<{ generation: string }>(
    "SELECT generation FROM projection_generations WHERE name='conversations'");
  const generation = result.rows[0]?.generation;
  if (generation === undefined) throw new Error('Conversation list unavailable');
  function visibleRevision(candidate: Candidate) {
    const state = listStateSchema.parse(candidate.state);
    return [candidate.conversation.conversationId, candidate.scanPosition,
      candidate.joinEventId, candidate.participationPosition, state?.archivePosition ?? 0];
  }
  const visible = candidates.map(visibleRevision);
  return JSON.stringify([generation, visible]);
}

const listStateSchema = z.object({ archived: z.boolean(),
  archivePosition: z.int().nonnegative() }).nullable();

export async function conversationListCandidates(db: Query, silo: string,
  memberId: string) {
  const result = await db.query<{ conversation_id: string; data: unknown; time: string;
    kind: 'personal' | 'team' | null; join_event_id: string; state: unknown;
    latest_activity: string; join_position: string; joined_at: string;
    participation_position: string }>(
    `SELECT p.conversation_id, f.data, f.time, c.kind, p.join_event_id, s.state,
        p.latest_activity, p.join_position, joined.time AS joined_at,
        COALESCE(changed.position, f.position) AS participation_position
      FROM conversation_participants p
      JOIN conversation_feed f ON f.silo=p.silo AND f.conversation_id=p.conversation_id
        AND f.type='conversation.created'
      JOIN conversation_feed joined ON joined.silo=p.silo
        AND joined.conversation_id=p.conversation_id AND joined.position=p.join_position
      LEFT JOIN LATERAL (SELECT position FROM conversation_feed
        WHERE silo=p.silo AND conversation_id=p.conversation_id
          AND type IN ('participant.added', 'participant.removed')
        ORDER BY position DESC LIMIT 1) changed ON true
      LEFT JOIN computers c ON c.silo=f.silo AND c.assistant_id=f.data->>'assistantId'
      LEFT JOIN conversation_list_state s ON s.silo=p.silo AND s.member_id=p.participant_id
        AND s.conversation_id=p.conversation_id AND s.join_event_id=p.join_event_id
      WHERE p.silo=$1 AND p.participant_id=$2 AND p.end_position IS NULL
      ORDER BY p.latest_activity DESC, p.join_position DESC LIMIT 100`,
    [silo, memberId]);
  function candidate(row: (typeof result.rows)[number]) {
    const data = conversationCreatedDataSchema.parse(row.data);
    const conversation = { ...data, conversationId: row.conversation_id, createdAt: row.time,
      assistantKind: row.kind ?? undefined };
    const scanPosition: [number, number] = [Number(row.latest_activity), Number(row.join_position)];
    return { conversation, joinEventId: row.join_event_id, state: row.state, scanPosition,
      joinedAt: row.joined_at, participationPosition: Number(row.participation_position) };
  }
  return result.rows.map(candidate);
}
