import { conversationCreatedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { Query } from './db.ts';

export const inventoryCategories = [
  'team', 'assistant', 'grant', 'routine', 'connection', 'computer',
];
const computerLifecycleEvents = new Set([
  'computer.claimed',
  'computer.ready',
  'computer.suspended',
  'computer.resumed',
  'computer.lost',
  'computer.retired',
]);

export async function createInventoryInputs(db: Query, table: string) {
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (
    silo TEXT NOT NULL, subject TEXT NOT NULL, category TEXT NOT NULL,
    link_kind TEXT NOT NULL, link_id TEXT NOT NULL, event_type TEXT NOT NULL,
    position BIGINT NOT NULL, event_id TEXT NOT NULL,
    PRIMARY KEY (silo, subject, link_kind, link_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS ${table}_backfill (
    version INTEGER PRIMARY KEY, completed BOOLEAN NOT NULL,
    subject_count BIGINT NOT NULL, participation_position BIGINT NOT NULL)`);
  await db.query(`INSERT INTO ${table}_backfill VALUES (1, false, 0, 0)
    ON CONFLICT DO NOTHING`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_links
    ON ${table} (silo, category, link_kind, link_id, subject)`);
  await db.query(`CREATE INDEX IF NOT EXISTS ${table}_history
    ON ${table} (silo, link_id, subject) WHERE link_kind = 'history'`);
}

function field(data: unknown, name: string) {
  if (typeof data !== 'object' || data === null) {
    throw new Error('Inventory data unavailable');
  }
  const value: unknown = Reflect.get(data, name);
  if (typeof value !== 'string') {
    throw new Error('Inventory link unavailable');
  }
  return value;
}

function links(event: EventEnvelope): [string, string][] {
  const data = event.data;
  if (typeof data !== 'object' || data === null) {
    throw new Error('Inventory data unavailable');
  }
  if (event.type === 'conversation.created') {
    const created = conversationCreatedDataSchema.parse(data);
    let participants = [created.createdBy];
    if (created.mode === 'group') {
      participants = created.participantIds;
    }
    function historyLink(memberId: string): [string, string] {
      return ['history', memberId];
    }
    return participants.map(historyLink);
  }
  if (event.type === 'participant.added' || event.type === 'participant.removed') {
    return [['history', field(data, 'participantId')]];
  }
  if (event.type.startsWith('team.member_')) {
    return [['member', field(data, 'memberId')]];
  }
  if (event.type === 'assistant.created') {
    let kind = 'team';
    if (field(data, 'kind') === 'personal') {
      kind = 'member';
    }
    return [[kind, field(data, 'ownerId')]];
  }
  if (event.type.startsWith('grant.')) {
    const granteeId = field(data, 'granteeId');
    const granteeKind: unknown = Reflect.get(data, 'granteeKind');
    if (typeof granteeKind === 'string') {
      return [[granteeKind, granteeId]];
    }
    // Keep all old revoke targets until their permission receipts have arrived.
    return [['member', granteeId], ['team', granteeId], ['assistant', granteeId]];
  }
  if (computerLifecycleEvents.has(event.type)) {
    return [['assistant', field(data, 'assistantId')]];
  }
  return [];
}

export async function applyInventoryInput(db: Query, table: string,
  event: EventEnvelope, position: number) {
  let category = event.subject.slice(0, event.subject.indexOf('-'));
  if (event.subject.startsWith('chat-state-')) {
    category = 'chat-state';
  }
  // Count each saved subject once. Ordinary messages do not change this count.
  const inserted = await db.query(`INSERT INTO ${table}
    VALUES ($1, $2, $3, 'stream', '', $4, $5, $6)
    ON CONFLICT DO NOTHING RETURNING subject`,
  [event.silo, event.subject, category, event.type, position, event.id]);
  if (inserted.rows.length > 0) {
    await db.query(`UPDATE ${table}_backfill SET subject_count = subject_count + 1
      WHERE version = 1`);
  }
  if (category === 'participation') {
    await db.query(`UPDATE ${table}_backfill SET participation_position = $1 WHERE version = 1`,
      [position]);
  }
  const recordedLinks = links(event);
  if (inventoryCategories.includes(category)) {
    recordedLinks.push(['stream', '']);
  }
  for (const [kind, id] of recordedLinks) {
    await db.query(`INSERT INTO ${table} VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (silo, subject, link_kind, link_id) DO UPDATE
      SET event_type = $6, position = $7, event_id = $8`,
    [event.silo, event.subject, category, kind, id, event.type, position, event.id]);
  }
}

type Reference = { subject: string; position: string };

async function linkedSubjects(db: Query, silo: string, category: string,
  memberId: string, groupIds: string[], assistantIds: string[]) {
  const result = await db.query<{ subject: string }>(`SELECT DISTINCT subject
    FROM inventory_inputs WHERE silo = $1 AND category = $2 AND (
      (link_kind = 'member' AND link_id = $3) OR
      (link_kind = 'team' AND link_id = ANY($4::text[])) OR
      (link_kind = 'assistant' AND link_id = ANY($5::text[])))
    ORDER BY subject LIMIT 101`, [silo, category, memberId, groupIds, assistantIds]);
  function subject(row: { subject: string }) {
    return row.subject;
  }
  return result.rows.map(subject);
}

function entityIds(subjects: string[], prefix: string) {
  function id(subject: string) {
    return subject.slice(prefix.length);
  }
  return subjects.map(id);
}

async function expandedPeopleWithinLimit(db: Query, silo: string, subjects: string[]) {
  const result = await db.query<{ link_id: string }>(`SELECT link_id
    FROM inventory_inputs WHERE silo = $1 AND subject = ANY($2::text[])
      AND link_kind = 'member' AND event_type = 'team.member_added'
    ORDER BY subject, link_id LIMIT 10001`, [silo, subjects]);
  // Keep the index read inside the same record limit as the saved histories.
  if (result.rows.length > 10_000) {
    return false;
  }
  const people = new Set<string>();
  for (const row of result.rows) {
    people.add(row.link_id);
    if (people.size > 500) {
      return false;
    }
  }
  return true;
}

/** Keep removed memberships and revoked grants discoverable when the visible list is empty. */
export async function readInventoryReferences(db: Query, silo: string, memberId: string,
  options: { excludeRoutines?: boolean } = {}) {
  const empty: Reference[] = [];
  const teams = await linkedSubjects(db, silo, 'team', memberId, [], []);
  if (teams.length > 100) {
    return { references: empty, complete: false };
  }
  const peopleWithinLimit = await expandedPeopleWithinLimit(db, silo, teams);
  if (!peopleWithinLimit) {
    return { references: empty, complete: false };
  }
  const groupIds = entityIds(teams, 'team-');
  // Include old ownership that used the member id where a group id was expected.
  const owners = [...groupIds, memberId];
  const assistants = await linkedSubjects(db, silo, 'assistant', memberId, owners, []);
  if (assistants.length > 100) {
    return { references: empty, complete: false };
  }
  const assistantIds = entityIds(assistants, 'assistant-');
  const grants = await linkedSubjects(db, silo, 'grant', memberId, groupIds, assistantIds);
  if (grants.length > 100) {
    return { references: empty, complete: false };
  }
  const computers = await linkedSubjects(db, silo, 'computer', memberId, [], assistantIds);
  if (computers.length > 100) {
    return { references: empty, complete: false };
  }
  const subjects = [...teams, ...assistants, ...grants, ...computers];
  const unsupportedCategories = ['connection'];
  if (!options.excludeRoutines) unsupportedCategories.push('routine');
  const result = await db.query<Reference & { category: string }>(`SELECT subject, position, category
    FROM inventory_inputs WHERE silo = $1 AND link_kind = 'stream'
      AND (subject = ANY($2::text[]) OR category = ANY($3::text[]))
    ORDER BY subject LIMIT 10001`, [silo, subjects, unsupportedCategories]);
  if (result.rows.length > 10_000) {
    return { references: empty, complete: false };
  }
  const totals = new Map<string, number>();
  const references: Reference[] = [];
  for (const row of result.rows) {
    const total = (totals.get(row.category) ?? 0) + 1;
    if (total > 100) {
      return { references, complete: false };
    }
    totals.set(row.category, total);
    const reference = { subject: row.subject, position: row.position };
    references.push(reference);
  }
  return { references, complete: true };
}

export async function inventoryIndexState(db: Query) {
  const result = await db.query<{ generation: string; backfilled: boolean;
    subject_count: string; participation_position: string }>(`SELECT g.generation,
    b.completed AS backfilled, b.subject_count, b.participation_position
    FROM projection_generations g JOIN projection_checkpoints c ON c.name = g.name
    JOIN inventory_inputs_backfill b ON b.version = 1
    WHERE g.name = 'members'`);
  const metadata = result.rows[0];
  if (!metadata) {
    throw new Error('Inventory checkpoint unavailable');
  }
  return { generation: Number(metadata.generation), backfilled: metadata.backfilled,
    subjectCount: Number(metadata.subject_count),
    participationPosition: Number(metadata.participation_position) };
}

export async function inventoryCategoryPositions(db: Query, silo: string,
  options: { excludeRoutines?: boolean } = {}) {
  const metadata = await inventoryIndexState(db);
  function included(category: string) {
    return category !== 'routine' || !options.excludeRoutines;
  }
  const categories = inventoryCategories.filter(included);
  const result = await db.query<{ category: string; position: string }>(`SELECT category,
    max(position) AS position FROM inventory_inputs WHERE silo = $1 AND link_kind = 'stream'
      AND category = ANY($2::text[])
    GROUP BY category ORDER BY category`, [silo, categories]);
  const positions: Record<string, number> = {};
  for (const row of result.rows) {
    positions[`${row.category}-*`] = Number(row.position);
  }
  return { positions, ...metadata };
}

export async function inventoryHistoryInputs(db: Query, silo: string, memberId: string) {
  const result = await db.query<{ event_id: string; position: string }>(`SELECT event_id, position
    FROM inventory_inputs WHERE silo = $1 AND link_kind = 'history' AND link_id = $2
    ORDER BY subject LIMIT 10001`, [silo, memberId]);
  return result.rows;
}
