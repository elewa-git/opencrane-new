import { createHash } from 'node:crypto';
import type { memberAuthorisation } from '@opencrane/authz';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  grantGivenDataSchema, grantRevokedDataSchema, memberRemovedDataSchema,
  departureCleanupCompletedSchema,
  type EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { registerHandler } from '@opencrane/handlers';
import { inventoryCategoryPositions, inventoryIndexState, readInventoryReferences,
  type Query } from '@opencrane/projections';
import { field, suspendComputer } from './lifecycle.ts';

const categories = ['team', 'assistant', 'grant'];
const actor = 'opencrane-worker';
type Change = { type: string; resource: string; data: Record<string, unknown> };

async function readHistory(store: EventStore, subject: string, silo: string, deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo || row.event.subject !== subject || rows.length >= 10_000) {
      throw new Error('Departure history unavailable');
    }
    rows.push(row);
  }
  return rows;
}

async function savedDeparture(store: EventStore, trigger: EventEnvelope, deadline: number) {
  const data = memberRemovedDataSchema.parse(trigger.data);
  // Leave historical removals alone: they did not bind cleanup to a reviewed departure.
  if (!data.reviewRevision) return;
  if (trigger.type !== 'member.removed' || trigger.subject !== `member-${data.memberId}`) {
    throw new Error('Departure removal mismatch');
  }
  const rows = await readHistory(store, trigger.subject, trigger.silo, deadline);
  let found = false;
  for (const row of rows) {
    if (row.event.id === trigger.id) {
      found = JSON.stringify(row.event.data) === JSON.stringify(data);
    } else if (found && ['member.joined', 'member.removed', 'silo.owner_bootstrapped']
      .includes(row.event.type)) {
      throw new Error('Departure membership changed');
    }
  }
  if (!found) throw new Error('Departure removal was not saved');
  return { memberId: data.memberId, position: rows.at(-1)!.sequence };
}

async function cleanupInputs(store: EventStore, db: Query, trigger: EventEnvelope,
  memberId: string, deadline: number) {
  const indexed = await inventoryCategoryPositions(db, trigger.silo);
  if (!indexed.backfilled) throw new Error('Departure inventory unavailable');
  for (const category of categories) {
    const subject = `${category}-*`;
    const position = await store.head(subject, deadline);
    if (position !== (indexed.positions[subject] ?? 0)) {
      throw new Error('Departure inventory is behind');
    }
  }
  const inputs = await readInventoryReferences(db, trigger.silo, memberId);
  if (!inputs.complete) throw new Error('Departure inventory exceeds limits');
  const histories = new Map<string, StoredEvent[]>();
  let count = 0;
  for (const reference of inputs.references) {
    const category = reference.subject.split('-')[0]!;
    if (!categories.includes(category)) continue;
    const rows = await readHistory(store, reference.subject, trigger.silo, deadline);
    count += rows.length;
    if (count > 10_000) throw new Error('Departure inventory exceeds limits');
    histories.set(reference.subject, rows);
  }
  const current = await inventoryIndexState(db);
  if (!current.backfilled || current.generation !== indexed.generation) {
    throw new Error('Departure inventory changed');
  }
  for (const category of categories) {
    const subject = `${category}-*`;
    if (await store.head(subject, deadline) !== (indexed.positions[subject] ?? 0)) {
      throw new Error('Departure inventory changed');
    }
  }
  return histories;
}

function personalAssistants(histories: Map<string, StoredEvent[]>, memberId: string) {
  const assistants = new Set<string>();
  for (const rows of histories.values()) {
    for (const { event } of rows) {
      if (event.type !== 'assistant.created') continue;
      const data = assistantCreatedDataSchema.parse(event.data);
      if (data.kind === 'personal' && data.ownerId === memberId) {
        assistants.add(data.assistantId);
      }
    }
  }
  return assistants;
}

function groupChanges(rows: StoredEvent[], memberId: string): Change[] {
  let membership: EventEnvelope | undefined;
  for (const { event } of rows) {
    if (event.type.startsWith('team.member_') && field(event.data, 'memberId') === memberId) {
      membership = event;
    }
  }
  if (membership?.type !== 'team.member_added') return [];
  const teamId = field(membership.data, 'teamId');
  const data = { teamId, memberId, removedBy: actor };
  return [{ type: 'team.member_removed', resource: teamId, data }];
}

function assistantChanges(rows: StoredEvent[], assistants: Set<string>): Change[] {
  let assistantId: string | undefined;
  let active = true;
  for (const { event } of rows) {
    if (event.type === 'assistant.created') assistantId = field(event.data, 'assistantId');
    if (event.type === 'assistant.settings_changed') {
      const settings = assistantSettingsChangedDataSchema.parse(event.data);
      if (settings.active !== undefined) active = settings.active;
    }
  }
  if (!assistantId || !assistants.has(assistantId) || !active) return [];
  const data = { assistantId, active: false, changedFields: ['active'], changedBy: actor };
  return [{ type: 'assistant.settings_changed', resource: assistantId, data }];
}

function grantChanges(rows: StoredEvent[], memberId: string, assistants: Set<string>) {
  const changes = new Map<string, Change>();
  for (const { event } of rows) {
    if (!event.type.startsWith('grant.')) continue;
    let grant;
    if (event.type === 'grant.given') grant = grantGivenDataSchema.parse(event.data);
    else grant = grantRevokedDataSchema.parse(event.data);
    const kinds = grant.granteeKind ? [grant.granteeKind] : ['member', 'assistant'];
    for (const kind of kinds) {
      const personal = kind === 'assistant' && assistants.has(grant.granteeId);
      const direct = kind === 'member' && grant.granteeId === memberId;
      if (!personal && !direct) continue;
      const resource = JSON.stringify([grant.resourceType, grant.resourceId, kind, grant.granteeId]);
      if (event.type === 'grant.revoked') {
        changes.delete(resource);
      } else {
        const data = { resourceType: grant.resourceType, resourceId: grant.resourceId,
          granteeKind: kind, granteeId: grant.granteeId, revokedBy: actor };
        changes.set(resource, { type: 'grant.revoked', resource, data });
      }
    }
  }
  return [...changes.values()];
}

function changesFor(rows: StoredEvent[], memberId: string, assistants: Set<string>) {
  return [...groupChanges(rows, memberId), ...assistantChanges(rows, assistants),
    ...grantChanges(rows, memberId, assistants)];
}

async function appendChanges(store: EventStore, trigger: EventEnvelope, position: number,
  subject: string, rows: StoredEvent[], changes: Change[], deadline: number, now: () => number) {
  let expectedSequence = rows.at(-1)?.sequence ?? 0;
  for (const change of changes) {
    const id = cleanupId(trigger, change.type, subject, change.resource);
    function alreadySaved(row: StoredEvent) {
      return row.event.id === id;
    }
    if (rows.some(alreadySaved)) continue;
    if (await store.head(trigger.subject, deadline) !== position) {
      throw new Error('Departure membership changed');
    }
    const event: EventEnvelope = { id, commandId: id, type: change.type, subject,
      silo: trigger.silo, source: actor, principal: { kind: 'system', id: actor },
      time: new Date(now()).toISOString(), correlation: {}, data: change.data };
    const command = { event, expectedSequence, historyChecked: true as const, deadline };
    const result = await store.append(command);
    if (result.status !== 'appended') throw new Error('Departure change was not saved');
    expectedSequence = result.sequence;
    rows.push({ event, sequence: result.sequence });
  }
}

export function departureCleanupHandler(store: EventStore,
  authorisation: Pick<ReturnType<typeof memberAuthorisation>, 'applied'>, now = Date.now) {
  async function cleanup(trigger: EventEnvelope, db: Query) {
    const deadline = performance.now() + 10_000;
    const departure = await savedDeparture(store, trigger, deadline);
    if (!departure) return;
    const auditSubject = `memberaudit-${departure.memberId}`;
    const audit = await readHistory(store, auditSubject, trigger.silo, deadline);
    const completionType = 'member.departure_cleanup_completed';
    const completionId = cleanupId(trigger, completionType, auditSubject, departure.memberId);
    function completed(row: StoredEvent) {
      return row.event.id === completionId;
    }
    if (audit.some(completed)) {
      return;
    }
    const histories = await cleanupInputs(store, db, trigger, departure.memberId, deadline);
    const assistants = personalAssistants(histories, departure.memberId);
    for (const [subject, rows] of histories) {
      const changes = changesFor(rows, departure.memberId, assistants);
      await appendChanges(store, trigger, departure.position, subject, rows, changes, deadline, now);
    }
    const computer = await suspendPersonalComputers(store, trigger, departure.position,
      assistants, deadline, now);
    const sections = await confirmedResults(histories, trigger, authorisation);
    sections.computer = computer;
    const completion = { memberId: departure.memberId, removalId: trigger.id, sections };
    const data = departureCleanupCompletedSchema.parse(completion);
    const change = { type: completionType, resource: departure.memberId, data };
    await appendChanges(store, trigger, departure.position, auditSubject, audit,
      [change], deadline, now);
  }
  return registerHandler('cleanup-departure', cleanup);
}

function cleanupId(trigger: EventEnvelope, type: string, subject: string, resource: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([trigger.silo, trigger.id, type, subject, resource]));
  return hash.digest('hex');
}

async function suspendPersonalComputers(store: EventStore, trigger: EventEnvelope,
  position: number, assistants: Set<string>, deadline: number, now: () => number) {
  const results: string[] = [];
  let count = 0;
  function lifecycle(row: StoredEvent) {
    return ['computer.claimed', 'computer.ready', 'computer.suspended', 'computer.resumed',
      'computer.lost', 'computer.retired'].includes(row.event.type);
  }
  // Read exact personal streams so other computers cannot delay this departure.
  for (const assistantId of assistants) {
    const rows = await readHistory(store, `computer-${assistantId}`, trigger.silo, deadline);
    count += rows.length;
    if (count > 10_000) {
      throw new Error('Departure computer history exceeds limits');
    }
    let latest = rows.findLast(lifecycle)?.event;
    if (!latest) {
      continue;
    }
    if (latest.type === 'computer.lost') {
      // Advance the stream before completion so a claim based on the old loss cannot land later.
      const subject = `computer-${assistantId}`;
      const data = { assistantId, computerId: field(latest.data, 'computerId') };
      const change = { type: 'computer.lost', resource: assistantId, data };
      await appendChanges(store, trigger, position, subject, rows, [change], deadline, now);
      results.push(cleanupId(trigger, change.type, subject, assistantId));
      continue;
    }
    if (latest.type === 'computer.ready') {
      if (await store.head(trigger.subject, deadline) !== position) {
        throw new Error('Departure membership changed');
      }
      const state = { assistantId, computerId: field(latest.data, 'computerId'), latest };
      latest = await suspendComputer(store, state);
    }
    if (latest.type === 'computer.suspended') {
      results.push(latest.id);
    } else if (latest.type !== 'computer.retired') {
      throw new Error('Departure computer busy');
    }
  }
  return results;
}

function resultReference(event: EventEnvelope) {
  if (event.type === 'team.member_removed') {
    return { section: 'groups' as const, resource: field(event.data, 'teamId') };
  }
  if (event.type === 'assistant.settings_changed') {
    return { section: 'assistant' as const, resource: field(event.data, 'assistantId') };
  }
  if (event.type === 'grant.revoked') {
    const grant = grantRevokedDataSchema.parse(event.data);
    const resource = JSON.stringify([grant.resourceType, grant.resourceId,
      grant.granteeKind, grant.granteeId]);
    return { section: 'grants' as const, resource };
  }
  return undefined;
}

function requiresPermissionReceipt(event: EventEnvelope, memberId: string, assistants: Set<string>) {
  if (event.type === 'team.member_removed') {
    return field(event.data, 'memberId') === memberId;
  }
  if (event.type !== 'grant.revoked') {
    return false;
  }
  const grant = grantRevokedDataSchema.parse(event.data);
  const kinds = grant.granteeKind ? [grant.granteeKind] : ['member', 'assistant'];
  const personal = kinds.includes('assistant') && assistants.has(grant.granteeId);
  const direct = kinds.includes('member') && grant.granteeId === memberId;
  return personal || direct;
}

async function confirmedResults(histories: Map<string, StoredEvent[]>, trigger: EventEnvelope,
  authorisation: Pick<ReturnType<typeof memberAuthorisation>, 'applied'>) {
  const memberId = field(trigger.data, 'memberId');
  const assistants = personalAssistants(histories, memberId);
  const sections = { groups: [] as string[], grants: [] as string[],
    assistant: [] as string[], computer: [] as string[] };
  // Include earlier attempts because a saved change can outlive a lost reply.
  for (const [subject, rows] of histories) {
    for (const { event } of rows) {
      if (requiresPermissionReceipt(event, memberId, assistants) && !await authorisation.applied(event.id)) {
        throw new Error('Departure permissions pending');
      }
      const result = resultReference(event);
      if (!result || event.id !== cleanupId(trigger, event.type, subject, result.resource)) {
        continue;
      }
      sections[result.section].push(event.id);
    }
  }
  return sections;
}
