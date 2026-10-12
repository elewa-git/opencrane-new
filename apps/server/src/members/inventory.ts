import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assistantCreatedDataSchema, grantGivenDataSchema, grantRevokedDataSchema,
  teamCreatedDataSchema } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { readInventoryReferences, inventoryCategoryPositions,
  inventoryIndexState, inventoryCategories } from '@opencrane/projections';
import { memberAuthorisation } from '@opencrane/authz';
import type { MemberAccessRow } from '@opencrane/protocol';
import type { GroupOptions } from './group-routes.ts';
import { retainedContent } from './retained-content.ts';

const publicResources = new Set(['model', 'mcp_server', 'mcp_tool', 'shared_desktop']);
type Assistant = ReturnType<typeof assistantCreatedDataSchema.parse>;
type Grant = ReturnType<typeof grantGivenDataSchema.parse>;
type GrantFact = {
  record: StoredEvent;
  grant: Pick<Grant, 'resourceType' | 'resourceId' | 'granteeId' | 'granteeKind'>;
};

async function recordedInputs(options: GroupOptions, memberId: string, deadline: number) {
  const indexedPositions = await inventoryCategoryPositions(options.db, options.silo);
  const categoryPositions: Record<string, number> = {};
  let current = indexedPositions.backfilled;
  for (const category of inventoryCategories) {
    const subject = `${category}-*`;
    const position = await options.store.head(subject, deadline);
    categoryPositions[subject] = position;
    if (position !== (indexedPositions.positions[subject] ?? 0)) {
      current = false;
    }
  }
  const indexed = await readInventoryReferences(options.db, options.silo, memberId);
  const rows: StoredEvent[] = [];
  const positions: Record<string, number> = {};
  for (const reference of indexed.references) {
    const subject = reference.subject;
    const position = await options.store.head(subject, deadline);
    positions[subject] = position;
    let fromSequence = 1;
    if (!subject.startsWith('team-') && !subject.startsWith('grant-') &&
        !subject.startsWith('assistant-')) {
      fromSequence = position;
    }
    for await (const row of options.store.readStream(subject, fromSequence, deadline)) {
      if (row.sequence > position) break;
      if (row.event.silo !== options.silo || rows.length >= 10_000) {
        throw new Error('Inventory cannot be read completely');
      }
      rows.push(row);
    }
  }
  function eventOrder(first: StoredEvent, second: StoredEvent) {
    return first.sequence - second.sequence;
  }
  rows.sort(eventOrder);
  return { rows, positions, categoryPositions, current, withinLimits: indexed.complete,
    generation: indexedPositions.generation };
}

function groupFacts(rows: StoredEvent[], memberId: string) {
  const names = new Map<string, string>();
  const memberships = new Map<string, StoredEvent>();
  const removals = new Map<string, StoredEvent>();
  for (const row of rows) {
    if (row.event.type === 'team.created') {
      const group = teamCreatedDataSchema.parse(row.event.data);
      names.set(group.teamId, group.name);
    } else if (row.event.type.startsWith('team.member_')) {
      const fields = z.object({ teamId: z.string(), memberId: z.string() }).parse(row.event.data);
      if (fields.memberId !== memberId) continue;
      if (row.event.type === 'team.member_added') {
        memberships.set(fields.teamId, row);
        removals.delete(fields.teamId);
      } else {
        memberships.delete(fields.teamId);
        // Keep the removal so an empty group list still checks its IAM receipt.
        removals.set(fields.teamId, row);
      }
    }
  }
  return { names, memberships, removals };
}

async function checkGroupRemovals(options: GroupOptions, groups: ReturnType<typeof groupFacts>,
  unavailable: Set<string>, deadline: number) {
  const auth = memberAuthorisation(options.binding);
  for (const removal of groups.removals.values()) {
    if (performance.now() >= deadline) throw new Error('Inventory deadline exceeded');
    if (!await auth.applied(removal.event.id)) unavailable.add('group_membership');
  }
}

function latestGrants(rows: StoredEvent[]) {
  const grants = new Map<string, GrantFact>();
  for (const row of rows) {
    if (!row.event.type.startsWith('grant.')) continue;
    let fields;
    if (row.event.type === 'grant.given') fields = grantGivenDataSchema.parse(row.event.data);
    else fields = grantRevokedDataSchema.parse(row.event.data);
    let kinds: Grant['granteeKind'][] = ['member', 'team', 'assistant'];
    if (fields.granteeKind) kinds = [fields.granteeKind];
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
      recordedAt: record.event.time,
      granteeKind: grant.granteeKind, granteeId: grant.granteeId,
    };
    if (grant.granteeKind === 'assistant') {
      source.kind = 'assistant';
    }
    if (grouped) {
      source.kind = 'group';
      source.groupId = grant.granteeId;
      source.groupName = groups.names.get(grant.granteeId);
    }
    row.sources.push(source);
  }
  await addSharedAssistants(options, memberId, inputs, groups, rows, unavailable, deadline);
  return Array.from(rows.values());
}

async function addSharedAssistants(options: GroupOptions, memberId: string, inputs: StoredEvent[],
  groups: ReturnType<typeof groupFacts>, rows: Map<string, MemberAccessRow>,
  unavailable: Set<string>, deadline: number) {
  const auth = memberAuthorisation(options.binding);
  for (const record of inputs) {
    if (record.event.type !== 'assistant.created') continue;
    const assistant = assistantCreatedDataSchema.parse(record.event.data);
    const membership = groups.memberships.get(assistant.ownerId);
    if (assistant.kind !== 'team' || !membership) continue;
    if (performance.now() >= deadline) throw new Error('Inventory deadline exceeded');
    const team = await checkedPermission(options, membership,
      auth.team(memberId, assistant.ownerId));
    let person: MemberAccessRow['eligibility']['person'] = 'unavailable';
    if (team === 'allowed') {
      person = await checkedPermission(options, record,
        auth.actsFor(memberId, assistant.assistantId));
    } else {
      unavailable.add('group_membership');
    }
    const source = { kind: 'group' as const, groupId: assistant.ownerId,
      groupName: groups.names.get(assistant.ownerId), eventId: record.event.id,
      sequence: record.sequence, recordedAt: record.event.time };
    const eligibility = { person, assistants: [], availability: 'unavailable' as const };
    rows.set(`assistant/${assistant.assistantId}`, { resourceType: 'assistant',
      resourceId: assistant.assistantId, label: assistant.name, relation: 'acts_for',
      sources: [source], eligibility });
  }
}

function unavailableIndexSections(inputs: { current: boolean; withinLimits: boolean }) {
  const unavailable = new Set<string>();
  if (!inputs.current) {
    unavailable.add('inventory_index');
  }
  if (!inputs.withinLimits) {
    unavailable.add('inventory_limits');
  }
  return unavailable;
}

export async function memberInventory(options: GroupOptions, memberId: string, deadline: number) {
  const inputs = await recordedInputs(options, memberId, deadline);
  const unavailable = unavailableIndexSections(inputs);
  const groups = groupFacts(inputs.rows, memberId);
  await checkGroupRemovals(options, groups, unavailable, deadline);
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
  const content = await retainedContent(options, memberId, inputs, deadline);
  if (!content.current) unavailable.add('retained_content');
  async function checkCurrent(checkDeadline: number, allowPendingRead = true) {
    const indexed = await inventoryIndexState(options.db);
    if (!indexed.backfilled || indexed.generation !== inputs.generation) {
      return false;
    }
    for (const [subject, position] of Object.entries(inputs.categoryPositions)) {
      const currentPosition = await options.store.head(subject, checkDeadline);
      if (currentPosition !== position) {
        return false;
      }
    }
    return content.checkCurrent(checkDeadline, allowPendingRead);
  }
  const unchanged = await checkCurrent(deadline);
  if (!unchanged) {
    unavailable.add('changed_inventory');
  }
  const absenceChecked = inputs.current && inputs.withinLimits && unchanged;
  const personalConnections = versionAbsence(inputs.rows, 'connection', unavailable, absenceChecked);
  const routines = versionAbsence(inputs.rows, 'routine', unavailable, absenceChecked);
  const hash = createHash('sha256');
  const reviewedInputs = [2, inputs.positions, inputs.categoryPositions, inputs.generation, content];
  hash.update(JSON.stringify(reviewedInputs));
  function assistantId(assistant: Assistant) {
    return assistant.assistantId;
  }
  const assistantIds = assistants.map(assistantId);
  return { rows, assistantIds, complete: unavailable.size === 0,
    unavailableSections: Array.from(unavailable),
    reviewRevision: hash.digest('hex'), checkCurrent, ownedSharedWork: [],
    personalConnections, routines,
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

function versionAbsence(rows: StoredEvent[], category: string, unavailable: Set<string>,
  absenceChecked: boolean) {
  for (const row of rows) {
    if (!row.event.type.startsWith(`${category}.`)) continue;
    unavailable.add(category);
    return { status: 'unsupported_history' as const, message: 'Not available yet' };
  }
  if (!absenceChecked) {
    unavailable.add(category);
    return { status: 'unavailable' as const, message: 'History could not be checked completely' };
  }
  let message = 'None possible on this version';
  if (category === 'routine') message = 'Routines are not available on this version';
  return { status: 'absent_on_version' as const, message };
}

export function reviewedRevision(inventoryRevision: string, memberSequence: number,
  ownershipSequence: number) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([inventoryRevision, memberSequence, ownershipSequence]));
  return hash.digest('hex');
}
