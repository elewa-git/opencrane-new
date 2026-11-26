import { sha256HexOfJson } from '@opencrane/events/digest';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { legacyMemberRole } from '@opencrane/events';
import { history } from '@opencrane/models';
import type { Query } from '@opencrane/projections';

const identityFields = z.object({ issuer: z.string(), sub: z.string() });
const fields = z.object({
  identity: identityFields.optional(),
  invitedIdentity: identityFields.optional(),
  expiresAt: z.string().optional(),
});

export type MemberAccount = z.infer<typeof identityFields>;

function sameAccount(identity: MemberAccount, account: MemberAccount) {
  return identity.issuer === account.issuer && identity.sub === account.sub;
}

function admission(rows: StoredEvent[], account: MemberAccount, now: Date) {
  let bound = false;
  let conflicting = false;
  let role: string | undefined;
  let pending = false;
  for (const row of rows) {
    const data = fields.parse(row.event.data);
    const identity = data.invitedIdentity ?? data.identity;
    if (identity) {
      if (sameAccount(identity, account)) {
        bound = true;
      } else {
        conflicting = true;
      }
    }
    const nextRole = legacyMemberRole(row.event);
    if (nextRole !== undefined) {
      role = nextRole;
      pending = false;
    }
    if (row.event.type === 'member.invited' && role === undefined) {
      pending = Boolean(data.expiresAt && Date.parse(data.expiresAt) > now.getTime());
    }
  }
  let membership: 'none' | 'joined' | 'pending' | 'removed' = 'none';
  if (role === '') {
    membership = 'removed';
  } else if (role) {
    membership = 'joined';
  } else if (pending) {
    membership = 'pending';
  }
  return { membership, bound, conflicting };
}

function memberSequence(rows: StoredEvent[]) {
  return rows.at(-1)?.sequence ?? 0;
}

async function memberStreams(store: Pick<EventStore, 'readStream'>, silo: string, deadline: number) {
  const streams = new Map<string, StoredEvent[]>();
  let read = 0;
  // Refuse an incomplete search rather than miss an older active identity binding.
  for await (const row of store.readStream('member-*', 1, deadline)) {
    read++;
    if (row.event.silo !== silo || read > 10_000) {
      throw new Error('Identity history unavailable');
    }
    const rows = streams.get(row.event.subject) ?? [];
    rows.push(row);
    streams.set(row.event.subject, rows);
  }
  return streams;
}

export async function deriveAdmission(store: EventStore, silo: string, account: MemberAccount,
  now: Date, deadline: number) {
  const streams = await memberStreams(store, silo, deadline);
  const existing = [];
  for (const [stream, rows] of streams) {
    const state = admission(rows, account, now);
    if (state.bound && ['joined', 'pending'].includes(state.membership)) {
      if (state.conflicting) return { status: 'identity_mismatch' as const };
      const candidate = {
        memberId: stream.slice(7),
        memberSequence: memberSequence(rows),
        membership: state.membership,
      };
      existing.push(candidate);
    }
  }
  if (existing.length > 1) return { status: 'ambiguous' as const };
  if (existing[0]) return existing[0];
  for (let number = 0; number < 20; number++) {
    const memberId = `admission-${sha256HexOfJson([silo, account.issuer, account.sub, number])}`;
    const rows = await history(store, `member-${memberId}`, silo, deadline);
    const state = admission(rows, account, now);
    if (state.membership === 'removed') continue;
    if (state.conflicting) return { status: 'identity_mismatch' as const };
    return { memberId, memberSequence: memberSequence(rows), membership: state.membership };
  }
  return { status: 'admission_limit' as const };
}

interface IdentityCandidate extends Record<string, unknown> {
  sequence: string | number;
  member_id: string | null;
  status: string | null;
}

type IdentityStore = Pick<EventStore, 'readStream' | 'head'>;

async function projectedIdentity(db: Query, silo: string, account: MemberAccount) {
  // Read the ids and checkpoint together so a rebuild cannot mix two versions of the table.
  const result = await db.query<IdentityCandidate>(
    `SELECT checkpoint.sequence, candidate.member_id, candidate.status
      FROM projection_checkpoints AS checkpoint
      LEFT JOIN (
        SELECT members.member_id, members.status FROM members
        JOIN member_identities AS identity USING (silo, member_id)
        WHERE members.silo = $1 AND identity.issuer = $2 AND identity.sub = $3
      ) AS candidate ON true
      WHERE checkpoint.name = 'members' LIMIT 101`, [silo, account.issuer, account.sub]);
  const sequence = Number(result.rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || result.rows.length > 100) {
    throw new Error('Identity projection unavailable');
  }
  const candidates = new Map<string, boolean>();
  for (const row of result.rows) {
    if (row.member_id !== null) {
      candidates.set(`member-${row.member_id}`, row.status === 'joined');
    }
  }
  return { sequence, candidates };
}

type IdentityProjection = Awaited<ReturnType<typeof projectedIdentity>>;
type IdentityRead = { silo: string; memberSequence: number; deadline: number };

async function includeUnprojectedIdentities(store: IdentityStore, account: MemberAccount,
  projected: IdentityProjection, read: IdentityRead) {
  const { sequence, candidates } = projected;
  const { memberSequence, silo, deadline } = read;
  if (sequence >= memberSequence) {
    return true;
  }
  let count = 0;
  let lastSequence = sequence;
  // Read only what the table has yet to apply so it cannot hide a newer admission.
  for await (const row of store.readStream('member-*', sequence + 1, deadline)) {
    if (row.sequence > memberSequence) {
      break;
    }
    if (row.event.silo !== silo) {
      throw new Error('Identity history unavailable');
    }
    count += 1;
    if (count > 10_000) {
      return false;
    }
    lastSequence = row.sequence;
    const data = fields.parse(row.event.data);
    const identity = data.invitedIdentity ?? data.identity;
    if (identity && sameAccount(identity, account) && !candidates.has(row.event.subject)) {
      candidates.set(row.event.subject, false);
    }
    if (candidates.size > 100) {
      throw new Error('Too many matching members');
    }
  }
  if (lastSequence !== memberSequence) {
    throw new Error('Identity history incomplete');
  }
  return true;
}

async function identityHistory(store: IdentityStore, memberSubject: string, silo: string,
  memberHead: number, deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(memberSubject, 1, deadline)) {
    if (row.sequence > memberHead) break;
    if (row.event.silo !== silo || row.event.subject !== memberSubject || rows.length >= 10_000) {
      throw new Error('Identity history unavailable');
    }
    rows.push(row);
  }
  return rows;
}

type ActiveIdentity = {
  status: 'active';
  memberId: string;
  memberSequence: number;
  projectedSequence: number;
  projectedJoined: boolean;
};

type IdentityResult = ActiveIdentity | {
  status: 'none' | 'ambiguous' | 'backlog';
  memberSequence: number;
};

export async function readActiveIdentity(store: IdentityStore, db: Query, silo: string,
  account: MemberAccount, now: Date): Promise<IdentityResult> {
  const deadline = performance.now() + 10_000;
  const projected = await projectedIdentity(db, silo, account);
  const memberSequence = await store.head('member-*', deadline);
  const read = { silo, memberSequence, deadline };
  const complete = await includeUnprojectedIdentities(store, account, projected, read);
  if (!complete) {
    return { status: 'backlog', memberSequence };
  }
  let active: ActiveIdentity | undefined;
  for (const [candidate, projectedJoined] of projected.candidates) {
    const rows = await identityHistory(store, candidate, silo, memberSequence, deadline);
    const state = admission(rows, account, now);
    if (state.conflicting && state.bound) {
      throw new Error('Identity history mismatch');
    }
    if (!state.bound || state.membership !== 'joined') {
      continue;
    }
    // Refuse a known conflict even if a later table lookup would return one member.
    if (active) {
      return { status: 'ambiguous', memberSequence };
    }
    active = { status: 'active', memberId: candidate.slice('member-'.length), memberSequence,
      projectedSequence: projected.sequence, projectedJoined };
  }
  return active ?? { status: 'none', memberSequence };
}
