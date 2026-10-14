import { createHash } from 'node:crypto';
import { assistantCreatedDataSchema, assistantSettingsChangedDataSchema,
  grantGivenDataSchema, grantRevokedDataSchema, memberRemovedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { registerHandler } from '@opencrane/handlers';
import { inventoryCategoryPositions, inventoryIndexState, readInventoryReferences,
  type Query } from '@opencrane/projections';
import { field } from './lifecycle.ts';

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
    const hash = createHash('sha256');
    hash.update(JSON.stringify([trigger.silo, trigger.id, change.type, subject, change.resource]));
    const id = hash.digest('hex');
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
  }
}

export function departureCleanupHandler(store: EventStore, now = Date.now) {
  async function cleanup(trigger: EventEnvelope, db: Query) {
    const deadline = performance.now() + 10_000;
    const departure = await savedDeparture(store, trigger, deadline);
    if (!departure) return;
    const histories = await cleanupInputs(store, db, trigger, departure.memberId, deadline);
    const assistants = personalAssistants(histories, departure.memberId);
    for (const [subject, rows] of histories) {
      const changes = changesFor(rows, departure.memberId, assistants);
      await appendChanges(store, trigger, departure.position, subject, rows, changes, deadline, now);
    }
  }
  return registerHandler('cleanup-departure', cleanup);
}
