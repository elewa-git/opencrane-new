import { conversationCreatedDataSchema, conversationEventId } from '@opencrane/events';
import { readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';
import { z } from 'zod';

export class ParticipationRefused extends Error {}
export class ParticipationApplying extends Error {}
const participant = z.object({ participantId: z.string() });
// Keep the first join of each period and remember removals that replace an older period.
type Change = { row: StoredEvent; hasRemoval: boolean; position: number };
type Changes = Map<string, Change>;

function emptyChanges(): Changes {
  return new Map();
}
function addChange(changes: Changes, row: StoredEvent) {
  const event = row.event;
  if (!['participant.added', 'participant.removed'].includes(event.type)) {
    throw new Error('Invalid participation event');
  }
  conversationEventId(event);
  const memberId = participant.parse(event.data).participantId;
  const previous = changes.get(memberId);
  let start = row;
  let hasRemoval = previous?.hasRemoval ?? false;
  if (event.type === 'participant.removed') hasRemoval = true;
  else if (previous?.row.event.type === 'participant.added') start = previous.row;
  changes.set(memberId, { row: start, hasRemoval, position: row.sequence });
}
function changeCount(changes: Changes) {
  return changes.size;
}
function copyChanges(changes: Changes) {
  return new Map(changes);
}
const changesKind: SummaryKind<Changes> = {
  name: 'conversation-participation', keep: 256, empty: emptyChanges, add: addChange,
  budget: { limit: 8192, size: changeCount },
};

// Use the rebuilt table to locate old access events, then check the saved records.
// Old workers must be stopped before replay; new commands cannot use the old subject.
export async function legacyParticipation(store: Pick<EventStore, 'readEvent'>,
  db: Query, silo: string, conversationId: string, deadline: number) {
  const result = await db.query<{ position: string; event_id: string }>(
    `SELECT position, event_id FROM conversation_feed WHERE silo = $1
      AND conversation_id = $2 AND type IN ('participant.added', 'participant.removed')
      ORDER BY position`, [silo, conversationId]);
  const rows: StoredEvent[] = [];
  for (const reference of result.rows) {
    const position = Number(reference.position);
    const row = await store.readEvent(position, deadline);
    if (row.event.id !== reference.event_id || row.event.silo !== silo ||
        conversationEventId(row.event) !== conversationId) {
      throw new Error('Conversation access history changed');
    }
    if (row.event.subject === `conversation-${conversationId}`) rows.push(row);
  }
  return rows;
}

async function participationCreation(store: Pick<EventStore, 'readStream'>,
  silo: string, conversationId: string, deadline: number): Promise<StoredEvent> {
  let creation: StoredEvent | undefined;
  for await (const row of store.readStream(`conversation-${conversationId}`, 1, deadline)) {
    if (row.event.silo !== silo) throw new ParticipationRefused('Conversation refused');
    if (row.event.type !== 'conversation.created') {
      throw new ParticipationRefused('Conversation refused');
    }
    creation = row;
    break;
  }
  if (!creation) throw new ParticipationRefused('Conversation refused');
  if (conversationEventId(creation.event) !== conversationId) {
    throw new ParticipationRefused('Conversation refused');
  }
  return creation;
}

function legacyChanges(legacy: StoredEvent[], silo: string, conversationId: string) {
  const changes: Changes = new Map();
  for (const row of legacy) {
    if (!row.event.type.startsWith('participant.')) continue;
    if (row.event.silo !== silo || conversationEventId(row.event) !== conversationId) {
      throw new ParticipationRefused('Conversation refused');
    }
    addChange(changes, row);
  }
  return changes;
}

export async function participation(store: Pick<EventStore, 'readStream'>,
  silo: string, conversationId: string, memberId: string,
  legacy: StoredEvent[] = [], deadline = performance.now() + 2000) {
  const creation = await participationCreation(store, silo, conversationId, deadline);
  const created = conversationCreatedDataSchema.parse(creation.event.data);
  const joins = new Map<string, StoredEvent>();
  let initial = [created.createdBy];
  if (created.mode !== 'agent_session') initial = created.participantIds;
  for (const participantId of initial) joins.set(participantId, creation);
  const changes = legacyChanges(legacy, silo, conversationId);
  const current = await participationChanges(store, silo, conversationId, deadline);
  const legacyPosition = applyChanges(joins, changes, conversationId);
  const currentPosition = applyChanges(joins, current, conversationId);
  const accessPosition = Math.max(creation.sequence, legacyPosition, currentPosition);
  const join = joins.get(memberId);
  if (!join) throw new ParticipationRefused('Conversation refused');
  const authorityRows = [creation];
  for (const currentJoin of joins.values()) {
    if (currentJoin.event.id !== creation.event.id) authorityRows.push(currentJoin);
  }
  return { created, participantIds: [...joins.keys()], joinPosition: join.sequence,
    joinEventId: join.event.id, accessPosition, authorityRows };
}

function applyChanges(joins: Map<string, StoredEvent>, changes: Changes,
  conversationId: string) {
  let position = 0;
  for (const [participantId, change] of changes) {
    const row = change.row;
    if (conversationEventId(row.event) !== conversationId) {
      throw new ParticipationRefused('Conversation refused');
    }
    position = Math.max(position, change.position);
    if (change.hasRemoval) joins.delete(participantId);
    if (row.event.type === 'participant.added' && !joins.has(participantId)) {
      joins.set(participantId, row);
    }
  }
  return position;
}

export function participationChanges(store: Pick<EventStore, 'readStream'>,
  silo: string, conversationId: string, deadline = performance.now() + 2000) {
  return readStreamSummary(store, silo, `participation-${conversationId}`,
    changesKind, deadline, copyChanges);
}

export async function conversationClosed(store: Pick<EventStore, 'head' | 'readEvent'>,
  db: Query, silo: string, conversationId: string, joinPosition: number, deadline: number) {
  const result = await db.query<{ position: string; event_id: string }>(
    `SELECT position, event_id FROM conversation_feed WHERE silo = $1 AND conversation_id = $2
      AND type = 'conversation.closed' ORDER BY position DESC LIMIT 1`, [silo, conversationId]);
  const reference = result.rows[0];
  let position: number;
  if (reference) position = Number(reference.position);
  else position = await store.head(`conversation-${conversationId}`, deadline);
  if (!position || (!reference && position < joinPosition)) return false;
  const row = await store.readEvent(position, deadline);
  if (row.event.silo !== silo || conversationEventId(row.event) !== conversationId) {
    throw new ParticipationRefused('Conversation refused');
  }
  if (reference && (row.event.id !== reference.event_id ||
      row.event.type !== 'conversation.closed')) throw new Error('Conversation history changed');
  return row.event.type === 'conversation.closed';
}

type Membership = { active: boolean };
function emptyMembership(): Membership {
  return { active: false };
}
function addMembership(membership: Membership, row: StoredEvent) {
  const memberId = z.object({ memberId: z.string() }).parse(row.event.data).memberId;
  if (row.event.subject !== `member-${memberId}`) throw new Error('Membership history changed');
  if (row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped') {
    membership.active = true;
  }
  if (row.event.type === 'member.removed') membership.active = false;
}
function membershipActive(membership: Membership) {
  return membership.active;
}
const membershipKind: SummaryKind<Membership> = {
  name: 'chat-membership', keep: 256, empty: emptyMembership, add: addMembership,
};
export function chatMembership(store: Pick<EventStore, 'readStream'>, silo: string,
  memberId: string, deadline = performance.now() + 2000) {
  return readStreamSummary(store, silo, `member-${memberId}`, membershipKind,
    deadline, membershipActive);
}
