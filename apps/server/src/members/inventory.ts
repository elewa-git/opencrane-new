import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assistantCreatedDataSchema, grantGivenDataSchema, grantRevokedDataSchema,
  teamCreatedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memberAuthorisation } from '@opencrane/authz';
import type { MemberAccessRow } from '@opencrane/protocol';
import type { GroupOptions } from './group-routes.ts';

const categories = ['team', 'assistant', 'grant', 'routine', 'connection', 'computer'];
const publicResources = new Set(['model', 'mcp_server', 'mcp_tool', 'shared_desktop']);
const checkpointQuery = `SELECT name, sequence FROM projection_checkpoints
  WHERE name IN ('computers', 'conversations') ORDER BY name`;
type Assistant = ReturnType<typeof assistantCreatedDataSchema.parse>;
type GrantFact = {
  record: StoredEvent;
  grant: { resourceType: string; resourceId: string; granteeId: string; granteeKind: string };
};

async function recordedInputs(options: GroupOptions, deadline: number) {
  const rows: StoredEvent[] = [];
  const positions: Record<string, number> = {};
  for (const category of categories) {
    const subject = `${category}-*`;
    const position = await options.store.head(subject, deadline);
    positions[subject] = position;
    if (category === 'computer') continue;
    for await (const row of options.store.readStream(subject, 1, deadline)) {
      if (row.sequence > position) break;
      if (row.event.silo !== options.silo || rows.length >= 10_000) {
        throw new Error('Inventory cannot be read completely');
      }
      rows.push(row);
    }
  }
  return { rows, positions };
}

function groupFacts(rows: StoredEvent[], memberId: string) {
  const names = new Map<string, string>();
  const memberships = new Map<string, StoredEvent>();
  for (const row of rows) {
    if (row.event.type === 'team.created') {
      const group = teamCreatedDataSchema.parse(row.event.data);
      names.set(group.teamId, group.name);
    } else if (row.event.type.startsWith('team.member_')) {
      const fields = z.object({ teamId: z.string(), memberId: z.string() }).parse(row.event.data);
      if (fields.memberId !== memberId) continue;
      if (row.event.type === 'team.member_added') memberships.set(fields.teamId, row);
      else memberships.delete(fields.teamId);
    }
  }
  return { names, memberships };
}

function latestGrants(rows: StoredEvent[]) {
  const grants = new Map<string, GrantFact>();
  for (const row of rows) {
    if (!row.event.type.startsWith('grant.')) continue;
    let fields;
    if (row.event.type === 'grant.given') fields = grantGivenDataSchema.parse(row.event.data);
    else fields = grantRevokedDataSchema.parse(row.event.data);
    const kinds = fields.granteeKind ? [fields.granteeKind] : ['member', 'team', 'assistant'];
    for (const kind of kinds) {
      const key = JSON.stringify([fields.resourceType, fields.resourceId, kind, fields.granteeId]);
      // Keep removals until their receipts confirm that OpenFGA has applied them.
      const grant = { ...fields, granteeKind: kind };
      const fact = { record: row, grant };
      grants.set(key, fact);
    }
  }
  return grants;
}

async function includeRecordedGrant(options: GroupOptions, fact: GrantFact,
  unavailable: Set<string>) {
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(fact.record.event.id)) unavailable.add('grants');
  if (fact.record.event.type === 'grant.revoked') return false;
  if (!publicResources.has(fact.grant.resourceType)) {
    unavailable.add('unsupported_grants');
    return false;
  }
  return true;
}

async function checkedPermission(options: GroupOptions, row: StoredEvent,
  permission: Promise<{ status: string; allowed: boolean }>):
  Promise<MemberAccessRow['eligibility']['person']> {
  const answer = await permission;
  const applied = await memberAuthorisation(options.binding).applied(row.event.id);
  if (answer.status === 'unavailable' || !applied) return 'unavailable';
  if (answer.allowed) return 'allowed';
  return 'denied';
}

async function resourceRow(options: GroupOptions, memberId: string, record: StoredEvent,
  assistants: Assistant[], grants: Map<string, GrantFact>,
  deadline: number): Promise<MemberAccessRow> {
  const grant = grantGivenDataSchema.parse(record.event.data);
  const auth = memberAuthorisation(options.binding);
  const person = await checkedPermission(options, record,
    auth.use('person', memberId, grant.resourceType, grant.resourceId));
  const eligibility: MemberAccessRow['eligibility'] = {
    person, assistants: [], availability: 'unavailable',
  };
  for (const assistant of assistants) {
    let status: MemberAccessRow['eligibility']['person'] = 'denied';
    if (performance.now() >= deadline) throw new Error('Inventory deadline exceeded');
    const key = JSON.stringify([grant.resourceType, grant.resourceId, 'assistant',
      assistant.assistantId]);
    const saved = grants.get(key);
    if (saved) {
      status = await checkedPermission(options, saved.record,
        auth.use('assistant', assistant.assistantId, grant.resourceType, grant.resourceId));
    }
    eligibility.assistants.push({ assistantId: assistant.assistantId, grant: status });
  }
  return { resourceType: grant.resourceType, resourceId: grant.resourceId,
    relation: 'use', sources: [], eligibility };
}

async function accessRows(options: GroupOptions, memberId: string, inputs: StoredEvent[],
  assistants: Assistant[], groups: ReturnType<typeof groupFacts>, unavailable: Set<string>,
  deadline: number) {
  const auth = memberAuthorisation(options.binding);
  const rows = new Map<string, MemberAccessRow>();
  const grants = latestGrants(inputs);
  for (const fact of grants.values()) {
    if (performance.now() >= deadline) throw new Error('Inventory deadline exceeded');
    const record = fact.record;
    const grant = fact.grant;
    const direct = grant.granteeKind === 'member' && grant.granteeId === memberId;
    const membership = groups.memberships.get(grant.granteeId);
    const grouped = grant.granteeKind === 'team' && membership !== undefined;
    function grantsRelevantAssistant(assistant: Assistant) {
      return grant.granteeKind === 'assistant' && grant.granteeId === assistant.assistantId;
    }
    if (!direct && !grouped && !assistants.some(grantsRelevantAssistant)) continue;
    if (!await includeRecordedGrant(options, fact, unavailable)) continue;
    if (grouped && membership) {
      const team = await checkedPermission(options, membership, auth.team(memberId, grant.granteeId));
      if (team !== 'allowed') unavailable.add('group_membership');
    }
    const key = JSON.stringify([grant.resourceType, grant.resourceId]);
    let row = rows.get(key);
    if (!row) {
      row = await resourceRow(options, memberId, record, assistants, grants, deadline);
      rows.set(key, row);
    }
    const source: MemberAccessRow['sources'][number] = {
      kind: 'direct', eventId: record.event.id, sequence: record.sequence,
      granteeKind: grant.granteeKind, granteeId: grant.granteeId,
    };
    if (grouped) {
      source.kind = 'group';
      source.groupId = grant.granteeId;
      source.groupName = groups.names.get(grant.granteeId);
    }
    row.sources.push(source);
  }
  await addSharedAssistants(options, memberId, inputs, groups, rows, deadline);
  return Array.from(rows.values());
}

async function addSharedAssistants(options: GroupOptions, memberId: string, inputs: StoredEvent[],
  groups: ReturnType<typeof groupFacts>, rows: Map<string, MemberAccessRow>, deadline: number) {
  const auth = memberAuthorisation(options.binding);
  for (const record of inputs) {
    if (record.event.type !== 'assistant.created') continue;
    const assistant = assistantCreatedDataSchema.parse(record.event.data);
    const membership = groups.memberships.get(assistant.ownerId);
    if (assistant.kind !== 'team' || !membership) continue;
    if (performance.now() >= deadline) throw new Error('Inventory deadline exceeded');
    const person = await checkedPermission(options, record, auth.actsFor(memberId, assistant.assistantId));
    const source = { kind: 'group' as const, groupId: assistant.ownerId,
      groupName: groups.names.get(assistant.ownerId), eventId: record.event.id,
      sequence: record.sequence };
    const eligibility = { person, assistants: [], availability: 'unavailable' as const };
    rows.set(`assistant/${assistant.assistantId}`, { resourceType: 'assistant',
      resourceId: assistant.assistantId, label: assistant.name, relation: 'acts_for',
      sources: [source], eligibility });
  }
}

export async function memberInventory(options: GroupOptions, memberId: string, deadline: number) {
  let head = await options.store.head(undefined, deadline);
  const inputs = await recordedInputs(options, deadline);
  for (const position of Object.values(inputs.positions)) head = Math.max(head, position);
  const unavailable = new Set<string>();
  const groups = groupFacts(inputs.rows, memberId);
  for (const groupId of groups.memberships.keys()) {
    if (!groups.names.has(groupId)) unavailable.add('unsupported_ownership');
  }
  const assistants: Assistant[] = [];
  for (const row of inputs.rows) {
    if (row.event.type !== 'assistant.created') continue;
    const assistant = assistantCreatedDataSchema.parse(row.event.data);
    if (assistant.kind === 'team' && !groups.names.has(assistant.ownerId)) {
      unavailable.add('unsupported_ownership');
    }
    if (assistant.kind === 'personal' && assistant.ownerId === memberId ||
        assistant.kind === 'team' && groups.memberships.has(assistant.ownerId)) {
      assistants.push(assistant);
    }
  }
  const rows = await accessRows(options, memberId, inputs.rows, assistants, groups, unavailable, deadline);
  recordUnavailablePermissions(rows, unavailable);
  const personalConnections = versionAbsence(inputs.rows, 'connection', unavailable);
  const routines = versionAbsence(inputs.rows, 'routine', unavailable);
  const content = await retainedContent(options, memberId, head);
  if (!content.current) unavailable.add('retained_content');
  for (const [subject, position] of Object.entries(inputs.positions)) {
    if (await options.store.head(subject, deadline) !== position) unavailable.add('changed_inventory');
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify([1, inputs.positions, content]));
  return { rows, complete: unavailable.size === 0, unavailableSections: Array.from(unavailable),
    reviewRevision: hash.digest('hex'), ownedSharedWork: [], personalConnections, routines,
    personalComputer: content.computers, retainedHistory: content.history };
}

function recordUnavailablePermissions(rows: MemberAccessRow[], unavailable: Set<string>) {
  for (const row of rows) {
    if (row.eligibility.person === 'unavailable') unavailable.add('permissions');
    for (const assistant of row.eligibility.assistants) {
      if (assistant.grant === 'unavailable') unavailable.add('permissions');
    }
  }
}

function versionAbsence(rows: StoredEvent[], category: string, unavailable: Set<string>) {
  for (const row of rows) {
    if (!row.event.type.startsWith(`${category}.`)) continue;
    unavailable.add(category);
    return { status: 'unsupported_history' as const, message: 'Not available yet' };
  }
  let message = 'None possible on this version';
  if (category === 'routine') message = 'Routine ownership: Not available yet';
  return { status: 'absent_on_version' as const, message };
}

async function retainedContent(options: GroupOptions, memberId: string, head: number) {
  const checkpoints = await options.db.query<{ name: string; sequence: string }>(
    checkpointQuery);
  const positions = new Map<string, number>();
  for (const row of checkpoints.rows) positions.set(row.name, Number(row.sequence));
  const current = (positions.get('computers') ?? -1) >= head &&
    (positions.get('conversations') ?? -1) >= head;
  if (!current) return { current, computers: [], history: null };
  const computers = await options.db.query<{ assistantId: string; computerId: string | null;
    status: string }>(`SELECT assistant_id AS "assistantId", computer_id AS "computerId", status
    FROM computers WHERE silo = $1 AND owner_id = $2 AND kind = 'personal'`,
  [options.silo, memberId]);
  // Return totals only. Never fetch titles, messages, files or private conversation streams.
  const history = await options.db.query<{ count: string; firstAt: string | null; lastAt: string | null }>(
    `SELECT count(*) AS count, min(f.time) AS "firstAt", max(f.time) AS "lastAt"
    FROM conversation_feed f WHERE f.silo = $1 AND f.type = 'conversation.created'
      AND EXISTS (SELECT 1 FROM conversation_participants p WHERE p.silo = f.silo
        AND p.conversation_id = f.conversation_id AND p.participant_id = $2)`,
    [options.silo, memberId]);
  const after = await options.db.query<{ name: string; sequence: string }>(
    checkpointQuery);
  if (after.rows.length !== positions.size) return { current: false, computers: [], history: null };
  for (const row of after.rows) {
    if (positions.get(row.name) !== Number(row.sequence)) {
      return { current: false, computers: [], history: null };
    }
  }
  const total = history.rows[0];
  if (!total) throw new Error('History count unavailable');
  return { current, positions: Array.from(positions.entries()), computers: computers.rows,
    history: { count: Number(total.count), firstAt: total.firstAt, lastAt: total.lastAt } };
}
