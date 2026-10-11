import { conversationCreatedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { inventoryHistoryInputs, inventoryIndexState } from '@opencrane/projections';
import type { GroupOptions } from './group-routes.ts';

type Inputs = { rows: StoredEvent[]; positions: Record<string, number> };
type ContentPositions = {
  computer: string;
  creation: string;
  participation: string;
};

async function contentPositions(options: GroupOptions, memberId: string) {
  const result = await options.db.query<ContentPositions>(`SELECT
    (SELECT COALESCE(max(position), 0) FROM computers
      WHERE silo = $1 AND owner_id = $2 AND kind = 'personal') AS computer,
    (SELECT COALESCE(max(f.position), 0) FROM conversation_feed f
      WHERE f.silo = $1 AND f.type = 'conversation.created'
        AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.silo = f.silo
          AND p.conversation_id = f.conversation_id AND p.participant_id = $2)) AS creation,
    (SELECT COALESCE(max(GREATEST(join_position, end_position)), 0)
      FROM conversation_participants WHERE silo = $1 AND participant_id = $2) AS participation`,
  [options.silo, memberId]);
  const positions = result.rows[0];
  if (!positions) throw new Error('Retained content positions unavailable');
  return positions;
}

function samePositions(before: ContentPositions, after: ContentPositions) {
  return before.computer === after.computer && before.creation === after.creation &&
    before.participation === after.participation;
}

function inputEventIds(inputs: Inputs) {
  const ids: string[] = [];
  for (const row of inputs.rows) {
    if (inputs.positions[row.event.subject] === row.sequence) ids.push(row.event.id);
  }
  return ids;
}

async function appliedInputs(options: GroupOptions, inputs: Inputs) {
  const eventIds = inputEventIds(inputs);
  const result = await options.db.query<{ count: string }>(`SELECT count(*) AS count
    FROM projection_events WHERE projection IN ('computers', 'conversations')
      AND event_id = ANY($1::text[])`, [eventIds]);
  // Require both workers to have processed every reviewed category position.
  return Number(result.rows[0]?.count) === eventIds.length * 2;
}

function changesHistory(row: StoredEvent, memberId: string) {
  if (row.event.type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(row.event.data);
    if (created.mode === 'agent_session') return created.createdBy === memberId;
    return created.participantIds.includes(memberId);
  }
  if (row.event.type === 'participant.added' || row.event.type === 'participant.removed') {
    const data = row.event.data;
    return typeof data === 'object' && data !== null &&
      Reflect.get(data, 'participantId') === memberId;
  }
  return false;
}

async function historyApplied(options: GroupOptions, memberId: string) {
  const references = await inventoryHistoryInputs(options.db, options.silo, memberId);
  if (references.length > 10_000) {
    return false;
  }
  function eventId(reference: typeof references[number]) {
    return reference.event_id;
  }
  const eventIds = references.map(eventId);
  const applied = await options.db.query<{ count: string }>(`SELECT count(*) AS count
    FROM projection_events WHERE projection = 'conversations' AND event_id = ANY($1::text[])`,
  [eventIds]);
  return Number(applied.rows[0]?.count) === eventIds.length;
}

async function firstEvent(options: GroupOptions, subject: string, from: number, deadline: number) {
  for await (const row of options.store.readStream(subject, from, deadline)) {
    return row;
  }
  return undefined;
}

async function unrelatedNewConversation(options: GroupOptions, memberId: string,
  deadline: number) {
  const position = await options.store.head('conversation-*', deadline);
  if (position === 0) {
    return false;
  }
  const latest = await firstEvent(options, 'conversation-*', position, deadline);
  if (!latest || latest.event.silo !== options.silo) {
    return false;
  }
  const subject = latest.event.subject;
  const indexed = await options.db.query(`SELECT subject FROM inventory_inputs
    WHERE silo = $1 AND subject = $2 AND link_kind = 'stream' AND link_id = ''`,
  [options.silo, subject]);
  if (indexed.rows.length > 0) {
    return false;
  }
  // Read just the first event. Creation can only append to an empty conversation stream.
  const created = await firstEvent(options, subject, 1, deadline);
  return created?.event.type === 'conversation.created' &&
    created.event.silo === options.silo && !changesHistory(created, memberId);
}

export async function retainedContent(options: GroupOptions, memberId: string,
  inputs: Inputs, deadline: number) {
  const indexed = await inventoryIndexState(options.db);
  const before = await contentPositions(options, memberId);
  let subjectCount = indexed.subjectCount;
  let participationPosition = indexed.participationPosition;
  async function checkCurrent(checkDeadline: number, allowPendingRead = true) {
    if (performance.now() >= checkDeadline) throw new Error('Inventory deadline exceeded');
    const metadata = await inventoryIndexState(options.db);
    if (!metadata.backfilled || metadata.generation !== indexed.generation) {
      return false;
    }
    const liveSubjects = await options.store.subjectCount(checkDeadline);
    const liveParticipation = await options.store.head('participation-*', checkDeadline);
    const indexCaughtUp = metadata.subjectCount === liveSubjects &&
      metadata.participationPosition === liveParticipation;
    if (indexCaughtUp) {
      subjectCount = liveSubjects;
      participationPosition = liveParticipation;
    } else if (liveSubjects !== subjectCount || liveParticipation !== participationPosition) {
      // Resolve at most one new conversation outside the short write access check.
      // More new subjects or pending participation make the review explicitly incomplete.
      if (!allowPendingRead || liveSubjects !== subjectCount + 1 ||
          liveParticipation !== participationPosition) {
        return false;
      }
      const unrelated = await unrelatedNewConversation(options, memberId, checkDeadline);
      if (!unrelated || await options.store.subjectCount(checkDeadline) !== liveSubjects) {
        return false;
      }
      subjectCount = liveSubjects;
    }
    if (!await historyApplied(options, memberId)) {
      return false;
    }
    const after = await contentPositions(options, memberId);
    return samePositions(before, after);
  }
  if (!await appliedInputs(options, inputs)) {
    return { current: false, computers: [], history: null, checkCurrent };
  }
  const computers = await options.db.query<{ assistantId: string; computerId: string | null;
    status: string }>(`SELECT assistant_id AS "assistantId", computer_id AS "computerId", status
    FROM computers WHERE silo = $1 AND owner_id = $2 AND kind = 'personal'`,
  [options.silo, memberId]);
  // Return totals only. Keep titles, messages and files out of the departure review.
  const history = await options.db.query<{ count: string; firstAt: string | null;
    lastAt: string | null }>(
    `SELECT count(*) AS count, min(f.time) AS "firstAt", max(f.time) AS "lastAt"
    FROM conversation_feed f WHERE f.silo = $1 AND f.type = 'conversation.created'
      AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.silo = f.silo
        AND p.conversation_id = f.conversation_id AND p.participant_id = $2)`,
    [options.silo, memberId]);
  const unchanged = await checkCurrent(deadline);
  if (!unchanged) {
    return { current: false, computers: [], history: null, checkCurrent };
  }
  const total = history.rows[0];
  if (!total) throw new Error('History count unavailable');
  return { current: true, computers: computers.rows, positions: before, checkCurrent,
    history: { count: Number(total.count), firstAt: total.firstAt, lastAt: total.lastAt } };
}
