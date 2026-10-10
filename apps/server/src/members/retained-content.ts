import { conversationCreatedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import type { GroupOptions } from './group-routes.ts';

type Inputs = { rows: StoredEvent[]; positions: Record<string, number> };
type ContentPositions = {
  computer: string;
  creation: string;
  participation: string;
};
type HistoryPositions = Record<string, number>;

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
    const separator = row.event.subject.indexOf('-');
    const category = row.event.subject.slice(0, separator);
    if (inputs.positions[`${category}-*`] === row.sequence) ids.push(row.event.id);
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

async function historyInputs(options: GroupOptions, memberId: string,
  previousPositions: HistoryPositions, deadline: number) {
  const eventIds: string[] = [];
  const positions: HistoryPositions = {};
  for (const subject of ['conversation-*', 'participation-*']) {
    const position = await options.store.head(subject, deadline);
    positions[subject] = position;
    const previous = previousPositions[subject];
    if (previous === undefined) throw new Error('History position unavailable');
    if (position <= previous) continue;
    for await (const row of options.store.readStream(subject, previous + 1, deadline)) {
      if (row.sequence > position) break;
      if (row.event.silo !== options.silo) throw new Error('History belongs to another silo');
      if (changesHistory(row, memberId)) eventIds.push(row.event.id);
      if (eventIds.length > 10_000) throw new Error('History cannot be checked completely');
    }
  }
  return { eventIds, positions };
}

async function historyApplied(options: GroupOptions, memberId: string, deadline: number) {
  const checkpoint = await options.db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = 'conversations'");
  const sequence = checkpoint.rows[0]?.sequence;
  if (sequence === undefined) return { current: false, positions: undefined };
  // Use the worker's position only to skip events it has already processed.
  // Check pending creation and participation events for this member, ignoring messages.
  const previous = { 'conversation-*': Number(sequence), 'participation-*': Number(sequence) };
  const inputs = await historyInputs(options, memberId, previous, deadline);
  const applied = await options.db.query<{ count: string }>(`SELECT count(*) AS count
    FROM projection_events WHERE projection = 'conversations' AND event_id = ANY($1::text[])`,
  [inputs.eventIds]);
  return { current: Number(applied.rows[0]?.count) === inputs.eventIds.length,
    positions: inputs.positions };
}

export async function retainedContent(options: GroupOptions, memberId: string,
  inputs: Inputs, deadline: number) {
  const before = await contentPositions(options, memberId);
  let historyPositions: HistoryPositions | undefined;
  async function checkCurrent(checkDeadline: number) {
    if (performance.now() >= checkDeadline) throw new Error('Inventory deadline exceeded');
    const after = await contentPositions(options, memberId);
    if (historyPositions) {
      // Read only events saved since the inventory finished, never the full chat history.
      const pending = await historyInputs(options, memberId, historyPositions, checkDeadline);
      if (pending.eventIds.length > 0) return false;
      historyPositions = pending.positions;
    }
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
  const caughtUp = await historyApplied(options, memberId, deadline);
  historyPositions = caughtUp.positions;
  const unchanged = await checkCurrent(deadline);
  if (!caughtUp.current || !unchanged) {
    return { current: false, computers: [], history: null, checkCurrent };
  }
  const total = history.rows[0];
  if (!total) throw new Error('History count unavailable');
  return { current: true, computers: computers.rows, positions: before, checkCurrent,
    history: { count: Number(total.count), firstAt: total.firstAt, lastAt: total.lastAt } };
}
