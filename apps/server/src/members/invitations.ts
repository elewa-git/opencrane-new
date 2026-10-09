import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getEventDefinition, legacyMemberRole, memberInvitedDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { activeMember, authorityFence, isAuthorityChanged, readActiveMember } from '@opencrane/models';
import { invitationCommandSchema } from '@opencrane/protocol';
import type { Query } from '@opencrane/projections';

type Input = z.infer<typeof invitationCommandSchema>;
const newInvitationId = z.uuid({ version: 'v4' });
const memberFields = z.object({ memberId: z.string(), email: z.string().optional() });
export class InvitationConflict extends Error {}

function digest(parts: string[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex');
}

function receipt(row: StoredEvent) {
  const data = memberInvitedDataSchema.parse(row.event.data);
  return {
    status: 'appended' as const,
    memberId: data.memberId,
    invitationId: data.invitationId,
    sequence: row.sequence,
    createdAt: row.event.time,
    expiresAt: data.expiresAt,
  };
}

function previous(rows: StoredEvent[], input: Input, actor: string) {
  function matches(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const index = rows.findIndex(matches);
  const row = rows[index];
  if (!row) {
    return undefined;
  }
  const data = memberInvitedDataSchema.parse(row.event.data);
  if (row.event.type !== 'member.invited' || row.event.principal?.kind !== 'human'
    || row.event.principal.id !== actor || data.email !== input.email
    || data.role !== input.role || data.personalAssistant !== input.personalAssistant
    || (rows[index - 1]?.sequence ?? 0) !== input.expectedSequence) {
    throw new InvitationConflict('command_id_reused');
  }
  return receipt(row);
}

async function invitationHistory(store: EventStore, subject: string, silo: string,
  deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (rows.length >= 10_000 || row.event.silo !== silo || row.event.subject !== subject) {
      throw new Error('Member history unavailable');
    }
    const definition = getEventDefinition(row.event.type);
    if (!definition) {
      throw new Error('Unknown member event');
    }
    definition.dataSchema.parse(row.event.data);
    const data = memberFields.parse(row.event.data);
    if (`member-${data.memberId}` !== subject) {
      throw new Error('Member subject mismatch');
    }
    rows.push(row);
  }
  return rows;
}

async function checkTargets(store: EventStore, db: Query, silo: string,
  input: Input, deadline: number) {
  const candidates = await db.query<{ member_id: string }>(
    `SELECT member_id FROM members WHERE silo = $1 AND lower(btrim(email)) = $2
      ORDER BY member_id LIMIT 101`, [silo, input.email]);
  if (candidates.rows.length > 100) {
    throw new Error('Too many matching members');
  }
  const subjects: string[] = [];
  for (const candidate of candidates.rows) {
    const subject = `member-${candidate.member_id}`;
    const rows = await invitationHistory(store, subject, silo, deadline);
    let email = '';
    let role = '';
    let removed = false;
    for (const row of rows) {
      const data = memberFields.parse(row.event.data);
      if (data.email) {
        email = data.email.trim().toLowerCase();
      }
      const nextRole = legacyMemberRole(row.event);
      if (nextRole !== undefined) {
        role = nextRole;
      }
      if (row.event.type === 'member.removed') {
        removed = true;
      }
    }
    if (email !== input.email) {
      continue;
    }
    if (role) {
      throw new InvitationConflict('already_member');
    }
    if (!removed && rows.length > 0 && candidate.member_id !== input.memberId) {
      throw new InvitationConflict('identity_mismatch');
    }
    subjects.push(subject);
  }
  return subjects;
}

function checkHistory(rows: StoredEvent[], input: Input) {
  for (const row of rows) {
    if (row.event.type === 'member.removed') {
      throw new InvitationConflict('access_removed');
    }
    if (legacyMemberRole(row.event)) {
      throw new InvitationConflict('already_member');
    }
    const data = memberInvitedDataSchema.parse(row.event.data);
    if (row.event.type !== 'member.invited' || data.memberId !== input.memberId
      || data.email !== input.email || data.invitedIdentity) {
      throw new InvitationConflict('identity_mismatch');
    }
  }
}

function invitationEvent(silo: string, actor: string, input: Input, time: Date) {
  const subject = `member-${input.memberId}`;
  const expiresAt = new Date(time.getTime() + 7 * 86_400_000).toISOString();
  const invitationId = digest([silo, actor, input.memberId, input.commandId]);
  const data = {
    memberId: input.memberId,
    email: input.email,
    role: input.role,
    personalAssistant: input.personalAssistant,
    invitedBy: actor,
    invitationId,
    expiresAt,
  };
  const event = {
    id: invitationId,
    commandId: input.commandId,
    subject,
    silo: silo,
    type: 'member.invited',
    source: 'opencrane-server',
    principal: { kind: 'human' as const, id: actor },
    time: time.toISOString(),
    data,
  };
  return event;
}

export async function invitationCommand(store: EventStore, binding: Binding,
  actor: string, input: Input, db: Query, now: () => Date) {
  // Check current access before returning a receipt or loading longer target history.
  await readActiveMember(store, binding, actor, 'admin');
  const subject = `member-${input.memberId}`;
  const deadline = performance.now() + 10_000;
  const rows = await invitationHistory(store, subject, binding.silo, deadline);
  checkHistory(rows, input);
  const saved = previous(rows, input, actor);
  if (saved) {
    return saved;
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
    throw new InvitationConflict('concurrent_change');
  }
  if (rows.length === 0 && !newInvitationId.safeParse(input.memberId).success) {
    throw new InvitationConflict('identity_mismatch');
  }
  const targets = await checkTargets(store, db, binding.silo, input, deadline);
  // Finish longer reads before starting the two-second write access check.
  const subjects = [`member-${actor}`, `ownership-${binding.silo}`, subject, ...targets];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const authority = { requiredRole: 'admin' as const, fresh };
  try {
    await activeMember(store, binding, actor, authority);
    await fresh();
  } catch (error) {
    if (!isAuthorityChanged(error)) {
      throw error;
    }
    // Check current access before exposing a saved result after a watched stream moved.
    await readActiveMember(store, binding, actor, 'admin');
    const updated = await invitationHistory(store, subject, binding.silo, deadline);
    const completed = previous(updated, input, actor);
    if (completed) {
      return completed;
    }
    throw new InvitationConflict('concurrent_change');
  }
  const event = invitationEvent(binding.silo, actor, input, now());
  const command = { event, expectedSequence: input.expectedSequence, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'unavailable' || result.status === 'rejected') {
    throw new Error('Invitation append unavailable');
  }
  const updated = await invitationHistory(store, subject, binding.silo, performance.now() + 10_000);
  const completed = previous(updated, input, actor);
  if (completed) {
    return completed;
  }
  throw new InvitationConflict('concurrent_change');
}

export async function invitationStatus(store: EventStore, binding: Binding,
  actor: string, memberId: string, commandId: string) {
  await readActiveMember(store, binding, actor, 'admin');
  const deadline = performance.now() + 10_000;
  const rows = await invitationHistory(store, `member-${memberId}`, binding.silo, deadline);
  function matches(row: StoredEvent) {
    return row.event.type === 'member.invited' && row.event.commandId === commandId;
  }
  const row = rows.find(matches);
  if (!row) {
    return { status: 'not_found' as const };
  }
  return receipt(row);
}
