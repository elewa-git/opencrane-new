import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { conversationEventId, legacyMemberRole, ownershipSeededSchema,
  ownershipTransferredSchema, ownershipSteppedDownSchema,
  type EventEnvelope } from '@opencrane/events';

function value(event: EventEnvelope, name: string): unknown {
  if (typeof event.data !== 'object' || event.data === null) {
    return undefined;
  }
  return Reflect.get(event.data, name);
}

function sameTarget(previous: EventEnvelope, later: EventEnvelope): boolean {
  if (previous.type.startsWith('grant.')) {
    return value(previous, 'granteeId') === value(later, 'granteeId') &&
      (value(previous, 'granteeKind') === value(later, 'granteeKind') ||
        value(later, 'granteeKind') === undefined);
  }
  if (previous.type === 'ownership.seeded') {
    return later.type.startsWith('ownership.');
  }
  if (previous.type.startsWith('ownership.') || previous.type.startsWith('team.member_')) {
    return value(previous, 'memberId') === value(later, 'memberId');
  }
  return previous.type.startsWith('member.') || previous.type === 'silo.owner_bootstrapped';
}

function relatedOwners(event: EventEnvelope): string[] {
  if (event.type === 'ownership.seeded') {
    return ownershipSeededSchema.parse(event.data).ownerIds;
  }
  if (event.type === 'ownership.transferred' || event.type === 'ownership.stepped_down') {
    const memberId = value(event, 'memberId');
    if (typeof memberId === 'string') {
      return [memberId];
    }
  }
  return [];
}

async function appliedRemoval(store: Pick<EventStore, 'readStream'>, silo: string,
  memberId: string, applied: (eventId: string) => Promise<boolean>): Promise<boolean> {
  let latest: EventEnvelope | undefined;
  for await (const row of store.readStream(`member-${memberId}`)) {
    if (row.event.silo !== silo) {
      throw new Error('Authorisation member history silo mismatch');
    }
    if (['member.joined', 'silo.owner_bootstrapped', 'member.role_changed',
      'member.removed'].includes(row.event.type)) {
      latest = row.event;
    }
  }
  return latest?.type === 'member.removed' && await applied(latest.id);
}

function changesMemberRole(event: EventEnvelope): boolean {
  return ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed'].includes(event.type);
}

async function savedSequence(store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope): Promise<number | undefined> {
  for await (const row of store.readStream(event.subject)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Authorisation history silo mismatch');
    }
    if (row.event.id === event.id) {
      return row.sequence;
    }
  }
  return undefined;
}

/** Wait for earlier role changes on the other stream before changing permissions. */
export async function requireEarlierRoleChanges(store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope, applied: (eventId: string) => Promise<boolean>): Promise<void> {
  const sequence = await savedSequence(store, event);
  if (sequence === undefined) {
    throw new Error('The role or ownership job was not found in the event log');
  }
  const memberId = value(event, 'memberId');
  let subject = `ownership-${event.silo}`;
  if (event.type === 'ownership.transferred') {
    subject = `member-${String(memberId)}`;
  }
  for await (const row of store.readStream(subject)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Authorisation history silo mismatch');
    }
    if (row.sequence >= sequence) {
      break;
    }
    const memberChange = changesMemberRole(row.event) || row.event.type === 'member.removed';
    const ownershipChange = row.event.type === 'ownership.seeded'
      || (row.event.type.startsWith('ownership.') && value(row.event, 'memberId') === memberId);
    if ((memberChange || ownershipChange) && !await applied(row.event.id)) {
      // Keep the job unacknowledged so its retry follows the earlier permission change.
      throw new Error('An earlier role or ownership change has not been applied');
    }
  }
}

async function laterOwnershipApplied(store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope, sequence: number,
  applied: (eventId: string) => Promise<boolean>): Promise<boolean> {
  const memberId = value(event, 'memberId');
  for await (const row of store.readStream(`ownership-${event.silo}`)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Ownership history silo mismatch');
    }
    if (row.sequence <= sequence) {
      continue;
    }
    let affectsMember = value(row.event, 'memberId') === memberId;
    if (row.event.type === 'ownership.seeded' && typeof memberId === 'string') {
      const seed = ownershipSeededSchema.parse(row.event.data);
      affectsMember = seed.ownerIds.includes(memberId);
    }
    if (affectsMember && await applied(row.event.id)) {
      return true;
    }
  }
  return false;
}

/** Allow saved legacy role changes only when they came before ownership was seeded. */
export async function memberEventBeforeOwnershipSeed(store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope): Promise<boolean> {
  let sequence: number | undefined;
  for await (const row of store.readStream(event.subject)) {
    if (row.event.id !== event.id) {
      continue;
    }
    if (row.event.silo !== event.silo || row.event.type !== event.type ||
        legacyMemberRole(row.event) !== legacyMemberRole(event)) {
      throw new Error('The member job does not match the saved role change');
    }
    sequence = row.sequence;
  }
  if (sequence === undefined) {
    return false;
  }
  for await (const row of store.readStream(`ownership-${event.silo}`)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Ownership history silo mismatch');
    }
    if (row.sequence > sequence && row.event.type === 'ownership.seeded') {
      return true;
    }
  }
  return false;
}

/** Read saved order before allowing an older event to change external permissions. */
export async function supersededEvent(
  store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope,
  applied: (eventId: string) => Promise<boolean>,
): Promise<boolean> {
  if (event.type.startsWith('participant.')) {
    const participantId = value(event, 'participantId');
    if (typeof participantId !== 'string') {
      throw new Error('Invalid participant identity');
    }
    const later = await laterParticipantChange(store, event, participantId, applied);
    return later !== undefined;
  }
  let found = false;
  let sequence: number | undefined;
  for await (const row of store.readStream(event.subject)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Authorisation history silo mismatch');
    }
    if (row.event.id === event.id) {
      found = true;
      sequence = row.sequence;
      continue;
    }
    if (found && sameTarget(event, row.event) && await applied(row.event.id)) {
      return true;
    }
  }
  if (sequence !== undefined && changesMemberRole(event) &&
      await laterOwnershipApplied(store, event, sequence, applied)) {
    return true;
  }
  // Keep recorded grants, groups, participants and assistant links independent of membership.
  // Removing silo membership leaves these tuples in place during a clean rebuild too.
  for (const memberId of relatedOwners(event)) {
    if (await appliedRemoval(store, event.silo, memberId, applied)) {
      return true;
    }
  }
  return false;
}

async function laterParticipantChange(
  store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope,
  participantId: string,
  applied: (eventId: string) => Promise<boolean>,
): Promise<StoredEvent | undefined> {
  const conversationId = conversationEventId(event);
  let sequence: number | undefined;
  for await (const row of store.readStream(event.subject)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Authorisation history silo mismatch');
    }
    if (row.event.id === event.id) {
      sequence = row.sequence;
      break;
    }
  }
  if (sequence === undefined) {
    return undefined;
  }
  // Compare global positions because older participant changes used the conversation stream.
  const subjects = [`conversation-${conversationId}`, `participation-${conversationId}`];
  let latest: StoredEvent | undefined;
  for (const subject of subjects) {
    for await (const row of store.readStream(subject, sequence + 1)) {
      if (row.event.silo !== event.silo) {
        throw new Error('Authorisation history silo mismatch');
      }
      if (!['participant.added', 'participant.removed'].includes(row.event.type)) {
        continue;
      }
      if (conversationEventId(row.event) !== conversationId) {
        throw new Error('Conversation history identity mismatch');
      }
      if (value(row.event, 'participantId') !== participantId ||
          (latest !== undefined && row.sequence <= latest.sequence)) {
        continue;
      }
      if (await applied(row.event.id)) {
        latest = row;
      }
    }
  }
  return latest;
}

export async function removedParticipant(
  store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope,
  participantId: string,
  applied: (eventId: string) => Promise<boolean>,
): Promise<boolean> {
  const later = await laterParticipantChange(store, event, participantId, applied);
  return later?.event.type === 'participant.removed';
}

/** Check authority at the saved transfer, before later step-downs or removals. */
export async function ownerAtTransfer(store: Pick<EventStore, 'readStream'>,
  event: EventEnvelope): Promise<boolean> {
  const transfer = ownershipTransferredSchema.parse(event.data);
  const owners = new Set<string>();
  for await (const row of store.readStream(event.subject)) {
    if (row.event.silo !== event.silo) {
      throw new Error('Ownership history silo mismatch');
    }
    if (row.event.id === event.id) {
      const recorded = ownershipTransferredSchema.parse(row.event.data);
      if (recorded.memberId !== transfer.memberId ||
          recorded.transferredBy !== transfer.transferredBy) {
        throw new Error('The ownership job does not match the saved transfer');
      }
      return owners.has(transfer.transferredBy);
    }
    if (row.event.type === 'ownership.seeded') {
      const seed = ownershipSeededSchema.parse(row.event.data);
      owners.clear();
      for (const memberId of seed.ownerIds) {
        owners.add(memberId);
      }
    } else if (row.event.type === 'ownership.transferred') {
      const previous = ownershipTransferredSchema.parse(row.event.data);
      owners.add(previous.memberId);
    } else if (row.event.type === 'ownership.stepped_down') {
      const previous = ownershipSteppedDownSchema.parse(row.event.data);
      owners.delete(previous.memberId);
    }
  }
  throw new Error('The ownership transfer was not found in the event log');
}
