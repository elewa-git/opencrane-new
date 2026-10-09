import { registerHandler } from '@opencrane/handlers';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { legacyMemberRole, ownershipSeededSchema, ownershipTransferredSchema,
  ownershipSteppedDownSchema } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { data } from './state.ts';

export function ownershipSubject(silo: string) {
  return `ownership-${silo}`;
}
export function ownershipState(rows: StoredEvent[]) {
  const owners = new Set<string>();
  for (const row of rows) {
    const event = row.event;
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
      owners.add(transfer.memberId);
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
    ownershipState(existing);
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
      throw new Error('Owner membership was changed outside the ownership stream');
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
/** Ownership supplies owner transitions; member streams retain identity and other roles. */
export async function currentMembership(store: Pick<EventStore, 'readStream'>,
  silo: string, memberId: string,
  fresh?: { include: (...subjects: string[]) => void; deadline: number }) {
  const subject = ownershipSubject(silo);
  fresh?.include(`member-${memberId}`, subject);
  const membership = await history(store, `member-${memberId}`, silo, fresh?.deadline);
  const ownership = await history(store, subject, silo, fresh?.deadline);
  const owners = ownershipState(ownership);
  const memberFacts = membership.filter(isMemberState);
  function concernsMember(row: StoredEvent) {
    return relevantOwnership(row, memberId);
  }
  const ownershipFacts = ownership.filter(concernsMember);
  const role = roleWithOwnership(memberFacts.at(-1), ownershipFacts, owners, memberId);
  const facts = [...memberFacts, ...ownershipFacts];
  return { role, facts, owners, ownership };
}

/** Fresh installation claim seeds ownership through a durable, independently retried reaction. */
export function ownershipSeedHandler(store: EventStore) {
  async function seed(event: Parameters<ReturnType<typeof registerHandler>['handle']>[0]) {
    await seedOwnership(store, event.silo);
  }
  return registerHandler('seed-ownership', seed);
}
