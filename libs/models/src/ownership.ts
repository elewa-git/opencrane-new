import { registerHandler } from '@opencrane/handlers';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { ownershipSeededSchema, ownershipTransferredSchema,
  ownershipSteppedDownSchema } from '@opencrane/events';
import { envelope, history } from './actor.ts';
import { data } from './state.ts';
import type { authorityFence } from './authority.ts';

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

/** Installation migration only: a global append fence protects both the snapshot and seed races. */
export async function seedOwnership(store: EventStore, silo: string) {
  const deadline = performance.now() + 2000;
  const existing = await history(store, ownershipSubject(silo), silo, deadline);
  if (existing.length) {
    ownershipState(existing);
    return;
  }
  const head = await store.head(undefined, deadline);
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
    if (['member.joined', 'silo.owner_bootstrapped'].includes(row.event.type)) {
      roles.set(memberId, String(fields['role']));
    }
    if (row.event.type === 'member.role_changed') {
      roles.set(memberId, String(fields['newRole']));
    }
    if (row.event.type === 'member.removed') {
      roles.delete(memberId);
    }
  }
  const ownerIds: string[] = [];
  for (const [memberId, role] of roles) {
    if (role === 'owner') {
      ownerIds.push(memberId);
    }
  }
  if (!ownerIds.length) {
    return;
  }
  ownerIds.sort();
  const event = envelope(silo, ownershipSubject(silo), 'ownership.seeded', { ownerIds },
    `ownership-seed-${silo}`);
  const result = await store.append({ event, expectedSequence: 0, expectedGlobalSequence: head });
  if (result.status !== 'appended') {
    throw new Error('Ownership migration conflicted; retry migration');
  }
}

function isMemberState(row: StoredEvent) {
  return ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed',
    'member.removed'].includes(row.event.type);
}
function memberRole(state: StoredEvent | undefined) {
  if (!state || state.event.type === 'member.removed') {
    return '';
  }
  const fields = data(state.event);
  return String(fields['newRole'] ?? fields['role']);
}
/** The ownership stream supplies owner transitions; member streams retain identity and other roles. */
export async function currentMembership(store: EventStore, silo: string, memberId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  const subject = ownershipSubject(silo);
  fresh.include(`member-${memberId}`, subject);
  const membership = await history(store, `member-${memberId}`, silo, fresh.deadline);
  const ownership = await history(store, subject, silo, fresh.deadline);
  const owners = ownershipState(ownership);
  const facts = membership.filter(isMemberState);
  const state = facts.at(-1);
  let role = memberRole(state);
  for (const row of ownership) {
    const fields = data(row.event);
    if (row.event.type === 'ownership.seeded' || fields['memberId'] === memberId) {
      facts.push(row);
    }
    if (row.event.type === 'ownership.stepped_down' && fields['memberId'] === memberId) {
      if (!state || row.sequence > state.sequence) {
        role = 'admin';
      }
    }
  }
  if (ownership.length && role === 'owner' && !owners.has(memberId)) {
    role = 'admin';
  }
  if (owners.has(memberId)) {
    if (!role) {
      throw new Error('Owner membership was changed outside the ownership stream');
    }
    role = 'owner';
  }
  return { role, facts, owners, ownership };
}

/** Fresh installation claim seeds ownership through a durable, independently retried reaction. */
export function ownershipSeedHandler(store: EventStore) {
  async function seed(event: Parameters<ReturnType<typeof registerHandler>['handle']>[0]) {
    await seedOwnership(store, event.silo);
  }
  return registerHandler('seed-ownership', seed);
}
