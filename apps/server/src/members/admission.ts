import { createHash } from 'node:crypto';
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

function admission(rows: StoredEvent[], issuer: string, subject: string, now: Date) {
  let bound = false;
  let conflicting = false;
  let role: string | undefined;
  let pending = false;
  for (const row of rows) {
    const data = fields.parse(row.event.data);
    const identity = data.invitedIdentity ?? data.identity;
    if (identity) {
      if (identity.issuer === issuer && identity.sub === subject) {
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

export async function deriveAdmission(store: EventStore, silo: string, issuer: string,
  subject: string, now: Date, deadline: number) {
  const streams = await memberStreams(store, silo, deadline);
  const existing = [];
  for (const [stream, rows] of streams) {
    const state = admission(rows, issuer, subject, now);
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
    const hash = createHash('sha256');
    hash.update(JSON.stringify([silo, issuer, subject, number]));
    const memberId = `admission-${hash.digest('hex')}`;
    const rows = await history(store, `member-${memberId}`, silo, deadline);
    const state = admission(rows, issuer, subject, now);
    if (state.membership === 'removed') continue;
    if (state.conflicting) return { status: 'identity_mismatch' as const };
    return { memberId, memberSequence: memberSequence(rows), membership: state.membership };
  }
  return { status: 'admission_limit' as const };
}

interface IdentityCandidate extends Record<string, unknown> {
  sequence: string | number;
  member_id: string | null;
}

type IdentityStore = Pick<EventStore, 'readStream' | 'head'>;

async function projectedIdentity(db: Query, silo: string, issuer: string, subject: string) {
  // Read the ids and checkpoint together so a rebuild cannot mix two versions of the table.
  const result = await db.query<IdentityCandidate>(
    `SELECT checkpoint.sequence, candidate.member_id
      FROM projection_checkpoints AS checkpoint
      LEFT JOIN (
        SELECT members.member_id FROM members
        JOIN member_identities AS identity USING (silo, member_id)
        WHERE members.silo = $1 AND identity.issuer = $2 AND identity.sub = $3
      ) AS candidate ON true
      WHERE checkpoint.name = 'members' LIMIT 101`, [silo, issuer, subject]);
  const sequence = Number(result.rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || result.rows.length > 100) {
    throw new Error('Identity projection unavailable');
  }
  const candidates = new Set<string>();
  for (const row of result.rows) {
    if (row.member_id !== null) {
      candidates.add(`member-${row.member_id}`);
    }
  }
  return { sequence, candidates };
}

async function includeUnprojectedIdentities(store: IdentityStore, silo: string, issuer: string,
  subject: string, sequence: number, memberHead: number, candidates: Set<string>,
  deadline: number) {
  if (sequence >= memberHead) return;
  let read = 0;
  let lastSequence = sequence;
  // Read only the unapplied events. A delayed projection must not hide a recent join.
  for await (const row of store.readStream('member-*', sequence + 1, deadline)) {
    if (row.sequence > memberHead) break;
    read += 1;
    if (row.event.silo !== silo || read > 10_000) {
      throw new Error('Identity history unavailable');
    }
    lastSequence = row.sequence;
    const data = fields.parse(row.event.data);
    const identity = data.invitedIdentity ?? data.identity;
    if (identity?.issuer === issuer && identity.sub === subject) {
      candidates.add(row.event.subject);
    }
    if (candidates.size > 100) {
      throw new Error('Too many matching members');
    }
  }
  if (lastSequence !== memberHead) {
    throw new Error('Identity history incomplete');
  }
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

export async function readActiveIdentity(store: IdentityStore, db: Query, silo: string,
  issuer: string, subject: string, now: Date) {
  const deadline = performance.now() + 10_000;
  const memberHead = await store.head('member-*', deadline);
  const projected = await projectedIdentity(db, silo, issuer, subject);
  await includeUnprojectedIdentities(store, silo, issuer, subject, projected.sequence,
    memberHead, projected.candidates, deadline);
  for (const candidate of projected.candidates) {
    const rows = await identityHistory(store, candidate, silo, memberHead, deadline);
    const state = admission(rows, issuer, subject, now);
    if (state.conflicting && state.bound) {
      throw new Error('Identity history mismatch');
    }
    if (state.bound && state.membership === 'joined') {
      return { active: true, memberSequence: memberHead };
    }
  }
  return { active: false, memberSequence: memberHead };
}
