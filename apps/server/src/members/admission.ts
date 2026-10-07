import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { legacyMemberRole } from '@opencrane/events';
import { history } from '@opencrane/models';

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

async function memberStreams(store: EventStore, silo: string, deadline: number) {
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
