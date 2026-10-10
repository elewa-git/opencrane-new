import { registerHandler } from '@opencrane/handlers';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { legacyMemberRole, ownershipSeededSchema, ownershipTransferredSchema,
  ownershipSteppedDownSchema, ownershipConfirmedSchema } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { data } from './state.ts';

export function ownershipSubject(silo: string) {
  return `ownership-${silo}`;
}
export function ownershipState(rows: StoredEvent[], confirmations: StoredEvent[] = []) {
  const ordered = [...rows, ...confirmations];
  function byPosition(left: StoredEvent, right: StoredEvent) {
    return left.sequence - right.sequence;
  }
  ordered.sort(byPosition);
  const pending = new Map<string, string>();
  const owners = new Set<string>();
  for (const row of ordered) {
    const event = row.event;
    if (event.type === 'member.ownership_confirmed') {
      confirmOwner(event, pending, owners);
      continue;
    }
    if (event.subject !== ownershipSubject(event.silo)) {
      throw new Error('Ownership subject mismatch');
    }
    if (event.type === 'ownership.seeded') {
      if (owners.size || row !== rows[0]) {
        throw new Error('Ownership was already seeded');
      }
      const seed = ownershipSeededSchema.parse(event.data);
      for (const memberId of seed.ownerIds) {
        owners.add(memberId);
      }
      continue;
    }
    if (!owners.size) {
      throw new Error('Ownership is not seeded');
    }
    if (event.type === 'ownership.transferred') {
      const transfer = ownershipTransferredSchema.parse(event.data);
      if (!owners.has(transfer.transferredBy)) {
        throw new Error('Transfer requires an owner');
      }
      recordAppointment(transfer, event.id, owners, pending);
    } else if (event.type === 'ownership.stepped_down') {
      const stepDown = ownershipSteppedDownSchema.parse(event.data);
      if (!owners.has(stepDown.memberId) || owners.size === 1) {
        throw new Error('At least one owner must remain');
      }
      owners.delete(stepDown.memberId);
    } else {
      throw new Error('Invalid ownership history');
    }
  }
  return owners;
}

function recordAppointment(transfer: ReturnType<typeof ownershipTransferredSchema.parse>,
  appointmentId: string, owners: Set<string>, pending: Map<string, string>) {
  if (transfer.awaitingConfirmation) {
    pending.set(appointmentId, transfer.memberId);
  } else {
    owners.add(transfer.memberId);
  }
}

function confirmOwner(event: StoredEvent['event'], pending: Map<string, string>,
  owners: Set<string>) {
  const confirmed = ownershipConfirmedSchema.parse(event.data);
  if (event.subject !== `member-${confirmed.memberId}`
    || pending.get(confirmed.appointmentId) !== confirmed.memberId) {
    throw new Error('Confirmation requires a saved appointment');
  }
  pending.delete(confirmed.appointmentId);
  owners.add(confirmed.memberId);
}

/** Each attempt rescans behind a fresh global fence; unrelated writers may win the first append. */
export async function seedOwnership(store: EventStore, silo: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const deadline = performance.now() + 10_000;
    if (await seedAttempt(store, silo, deadline)) {
      return;
    }
  }
  throw new Error('Ownership migration conflicted after five attempts');
}
async function seedAttempt(store: EventStore, silo: string, deadline: number) {
  const subject = ownershipSubject(silo);
  const head = await store.head(undefined, deadline);
  const existing = await history(store, subject, silo, deadline);
  if (existing.length) {
    return true;
  }
  const roles = new Map<string, string>();
  for await (const row of store.readStream('member-*', 1, deadline)) {
    if (row.sequence > head) {
      break;
    }
    if (row.event.silo !== silo) {
      throw new Error('Migration silo mismatch');
    }
    const fields = data(row.event);
    const memberId = String(fields['memberId']);
    if (row.event.subject !== `member-${memberId}`) {
      throw new Error('Member subject mismatch');
    }
    const role = legacyMemberRole(row.event);
    if (role !== undefined) {
      roles.set(memberId, role);
    }
  }
  const ownerIds: string[] = [];
  for (const [memberId, role] of roles) {
    if (role === 'owner') {
      ownerIds.push(memberId);
    }
  }
  if (!ownerIds.length) {
    return true;
  }
  ownerIds.sort();
  const event = envelope(silo, subject, 'ownership.seeded', { ownerIds },
    `ownership-seed-${silo}`);
  const command = { event, expectedSequence: 0, expectedGlobalSequence: head };
  const result = await store.append(command);
  if (result.status === 'unavailable') {
    throw new Error('Ownership migration unavailable', { cause: result.cause });
  }
  if (result.status === 'rejected') {
    throw new Error('Ownership migration rejected');
  }
  return result.status === 'appended';
}

export const memberStateTypes = [
  'member.joined', 'silo.owner_bootstrapped', 'member.role_changed', 'member.removed',
  'member.ownership_confirmed',
];

function isMemberState(row: StoredEvent) {
  return memberStateTypes.includes(row.event.type);
}
function relevantOwnership(row: StoredEvent, memberId: string) {
  if (row.event.type === 'ownership.seeded') {
    return true;
  }
  return data(row.event)['memberId'] === memberId;
}
function roleWithOwnership(state: StoredEvent | undefined, changes: StoredEvent[],
  owners: Set<string>, memberId: string) {
  const memberRole = state ? legacyMemberRole(state.event) : undefined;
  if (owners.has(memberId)) {
    if (!memberRole) {
      throw new Error('Confirmed owner must remain an active member');
    }
    return 'owner';
  }
  const lastChange = changes.at(-1);
  if (lastChange?.event.type === 'ownership.stepped_down' &&
      (!state || lastChange.sequence > state.sequence)) {
    return 'admin';
  }
  if (changes.length && memberRole === 'owner') {
    return 'admin';
  }
  return memberRole ?? '';
}
/** Read ownership requests and member confirmations to check the current role. */
export async function currentMembership(store: Pick<EventStore, 'readStream'>,
  silo: string, memberId: string,
  fresh?: { include: (...subjects: string[]) => void; deadline: number },
  deadline = fresh?.deadline) {
  const subject = ownershipSubject(silo);
  fresh?.include(`member-${memberId}`, subject);
  const membership = await history(store, `member-${memberId}`, silo, deadline);
  const ownership = await history(store, subject, silo, deadline);
  const confirmations: StoredEvent[] = [];
  const positions = new Map<string, number>();
  positions.set(`member-${memberId}`, membership.at(-1)?.sequence ?? 0);
  positions.set(subject, ownership.at(-1)?.sequence ?? 0);
  async function readConfirmations() {
    for (const row of ownership) {
      if (row.event.type !== 'ownership.transferred') continue;
      const transfer = ownershipTransferredSchema.parse(row.event.data);
      if (!transfer.awaitingConfirmation) continue;
      const memberSubject = `member-${transfer.memberId}`;
      fresh?.include(memberSubject);
      const rows = memberSubject === `member-${memberId}`
        ? membership : await history(store, memberSubject, silo, deadline);
      positions.set(memberSubject, rows.at(-1)?.sequence ?? 0);
      for (const candidate of rows) {
        if (candidate.event.type !== 'member.ownership_confirmed') continue;
        const confirmed = ownershipConfirmedSchema.parse(candidate.event.data);
        if (confirmed.appointmentId === row.event.id) confirmations.push(candidate);
      }
    }
  }
  await readConfirmations();
  const owners = ownershipState(ownership, confirmations);
  const memberFacts = membership.filter(isMemberState);
  function concernsMember(row: StoredEvent) {
    return relevantOwnership(row, memberId);
  }
  function grantsOwnership(row: StoredEvent) {
    if (row.event.type !== 'ownership.transferred') return concernsMember(row);
    const transfer = ownershipTransferredSchema.parse(row.event.data);
    return !transfer.awaitingConfirmation && concernsMember(row);
  }
  const ownershipFacts = ownership.filter(grantsOwnership);
  const role = roleWithOwnership(memberFacts.at(-1), ownershipFacts, owners, memberId);
  const facts = [...memberFacts, ...ownershipFacts];
  return { role, facts, owners, ownership, confirmations, positions };
}

/** Fresh installation claim seeds ownership through a durable, independently retried reaction. */
export function ownershipSeedHandler(store: EventStore) {
  async function seed(event: Parameters<ReturnType<typeof registerHandler>['handle']>[0]) {
    await seedOwnership(store, event.silo);
  }
  return registerHandler('seed-ownership', seed);
}
