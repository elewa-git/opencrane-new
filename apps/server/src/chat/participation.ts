import { conversationParticipation, conversationHistoryPosition } from '@opencrane/models';
import { conversationEventId } from '@opencrane/events';
import { readStreamSummary, WrongSiloError, type EventStore, type StoredEvent, type SummaryKind }
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
  if (event.type === 'conversation.closed') {
    conversationEventId(event);
    return;
  }
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

// Keep verified old changes separately. New changes belong to the small participation stream.
const legacyReaders = new WeakMap<object, Pick<EventStore, 'readStream'>>();
const legacyKind: SummaryKind<Changes> = {
  ...changesKind, name: 'conversation-legacy-participation',
};

function legacyReader(store: Pick<EventStore, 'readEvent'>, db: Query) {
  let reader = legacyReaders.get(store);
  if (reader) return reader;
  async function* readStream(subject: string, fromSequence = 1, deadline = Infinity) {
    const [silo, conversationId] = z.tuple([z.string(), z.string()]).parse(JSON.parse(subject));
    const result = await db.query<{ position: string; event_id: string }>(
      `SELECT position, event_id FROM conversation_legacy_participation
        WHERE silo = $1 AND conversation_id = $2 AND position >= $3 ORDER BY position`,
      [silo, conversationId, fromSequence]);
    for (const reference of result.rows) {
      const row = await store.readEvent(Number(reference.position), deadline);
      if (row.event.id !== reference.event_id || row.event.silo !== silo ||
          row.event.subject !== `conversation-${conversationId}` ||
          conversationEventId(row.event) !== conversationId) {
        throw new Error('Conversation access history changed');
      }
      yield row;
    }
  }
  reader = { readStream };
  legacyReaders.set(store, reader);
  return reader;
}

// Stop old workers before replay. New commands cannot write to the old subject.
export function legacyParticipation(store: Pick<EventStore, 'readEvent'>,
  db: Query, silo: string, conversationId: string, deadline: number) {
  const reader = legacyReader(store, db);
  const subject = JSON.stringify([silo, conversationId]);
  return readStreamSummary(reader, silo, subject, legacyKind, deadline, copyChanges);
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

function legacyChanges(legacy: StoredEvent[] | Changes, silo: string, conversationId: string) {
  if (legacy instanceof Map) return legacy;
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
  legacy: StoredEvent[] | Changes = [], deadline = performance.now() + 2000) {
  const creation = await participationCreation(store, silo, conversationId, deadline);
  const { created, joins } = conversationParticipation(creation);
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
  return { created, creation, participantIds: [...joins.keys()], joinPosition: join.sequence,
    joinEventId: join.event.id, join, historyPosition: conversationHistoryPosition(creation, join),
    accessPosition, authorityRows };
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

type Closure = { closed: boolean };
function emptyClosure(): Closure {
  return { closed: false };
}
function addClosure(closure: Closure, row: StoredEvent) {
  conversationEventId(row.event);
  if (row.event.type === 'conversation.closed') {
    closure.closed = true;
  }
}
function isClosed(closure: Closure) {
  return closure.closed;
}
const closureKind: SummaryKind<Closure> = {
  name: 'conversation-closure', keep: 256, empty: emptyClosure, add: addClosure,
};
export function participationClosed(store: Pick<EventStore, 'readStream'>,
  silo: string, conversationId: string, deadline = performance.now() + 2000) {
  return readStreamSummary(store, silo, `participation-${conversationId}`,
    closureKind, deadline, isClosed);
}
const closureReaders = new WeakMap<object, Pick<EventStore, 'readStream'>>();

function closureReader(store: Pick<EventStore, 'readStream' | 'readEvent'>, db: Query) {
  let reader = closureReaders.get(store);
  if (reader) return reader;
  async function* readStream(subject: string, fromSequence = 1, deadline = Infinity) {
    const identity = z.tuple([z.string(), z.string()]).parse(JSON.parse(subject));
    const [silo, conversationId] = identity;
    yield* closureRecords(store, db, silo, conversationId, fromSequence, deadline);
  }
  reader = { readStream };
  closureReaders.set(store, reader);
  return reader;
}

export function conversationClosed(store: Pick<EventStore, 'readStream' | 'readEvent'>,
  db: Query, silo: string, conversationId: string, deadline: number) {
  const reader = closureReader(store, db);
  const subject = JSON.stringify([silo, conversationId]);
  return readStreamSummary(reader, silo, subject, closureKind, deadline, isClosed);
}

async function* closureRecords(store: Pick<EventStore, 'readStream' | 'readEvent'>,
  db: Query, silo: string, conversationId: string, checkedFrom: number, deadline: number) {
  // Confirm older closes by their saved position. Upgrade with old writers stopped
  // and the conversation worker caught up before starting this server.
  const result = await db.query<{ position: string; event_id: string }>(
    `SELECT position, event_id FROM conversation_feed
      WHERE silo = $1 AND conversation_id = $2 AND type = 'conversation.closed'
      ORDER BY position DESC LIMIT 1`, [silo, conversationId]);
  const reference = result.rows[0];
  if (reference) {
    const row = await store.readEvent(Number(reference.position), deadline);
    if (row.event.silo !== silo || conversationEventId(row.event) !== conversationId ||
        row.event.id !== reference.event_id || row.event.type !== 'conversation.closed') {
      throw new Error('Conversation history changed');
    }
    yield row;
    return;
  }
  // Read only access changes. Messages and reports cannot use a viewer's check time.
  for await (const row of store.readStream(`participation-${conversationId}`, checkedFrom,
    deadline)) {
    if (row.event.silo !== silo || conversationEventId(row.event) !== conversationId) {
      throw new ParticipationRefused('Conversation refused');
    }
    yield row;
    if (row.event.type === 'conversation.closed') return;
  }
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
export async function chatMembership(store: Pick<EventStore, 'readStream'>, silo: string,
  memberId: string, deadline = performance.now() + 2000) {
  try {
    return await readStreamSummary(store, silo, `member-${memberId}`, membershipKind,
      deadline, membershipActive);
  } catch (error) {
    // Refuse foreign ids without revealing whether another silo has recorded them.
    if (error instanceof WrongSiloError) {
      throw new ParticipationRefused('Active silo membership required', { cause: error });
    }
    throw error;
  }
}

export async function requireLegacyClosesProjected(store: EventStore, db: Query) {
  // Check once at startup. Older closes must be indexed before new writers start.
  const position = await store.head('conversation-*');
  const result = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = 'conversations'");
  const projected = Number(result.rows[0]?.sequence ?? 0);
  if (projected < position) {
    throw new Error('Conversation worker must catch up before server startup');
  }
}
