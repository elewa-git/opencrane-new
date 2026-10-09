import { createHash } from 'node:crypto';
import { z } from 'zod';
import { legacyMemberRole, memberInvitedDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Binding } from '@opencrane/authz';
import { activeMember, authorityFence, history, readActiveMember } from '@opencrane/models';
import { invitationCommandSchema } from '@opencrane/protocol';

type Input = z.infer<typeof invitationCommandSchema>;
export class InvitationConflict extends Error {}

function digest(parts: string[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(parts));
  return hash.digest('hex');
}

function receipt(row: StoredEvent) {
  const data = memberInvitedDataSchema.parse(row.event.data);
  return { status: 'appended' as const, memberId: data.memberId,
    invitationId: data.invitationId, sequence: row.sequence,
    createdAt: row.event.time, expiresAt: data.expiresAt };
}

function previous(rows: StoredEvent[], input: Input, actor: string) {
  function matches(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const index = rows.findIndex(matches);
  const row = rows[index];
  if (!row) return undefined;
  const data = memberInvitedDataSchema.parse(row.event.data);
  if (row.event.type !== 'member.invited' || row.event.principal?.kind !== 'human'
    || row.event.principal.id !== actor || data.email !== input.email
    || data.role !== input.role || data.personalAssistant !== input.personalAssistant
    || (rows[index - 1]?.sequence ?? 0) !== input.expectedSequence) {
    throw new InvitationConflict('command_id_reused');
  }
  return receipt(row);
}

async function checkTargets(store: EventStore, silo: string, email: string, deadline: number) {
  const states = new Map<string, { email: string; role: string }>();
  let count = 0;
  for await (const row of store.readStream('member-*', 1, deadline)) {
    if (++count > 10_000 || row.event.silo !== silo) {
      throw new Error('Member history unavailable');
    }
    const state = states.get(row.event.subject) ?? { email: '', role: '' };
    const data = z.object({ email: z.string().optional() }).parse(row.event.data);
    if (data.email) state.email = data.email.trim().toLowerCase();
    const role = legacyMemberRole(row.event);
    if (role !== undefined) state.role = role;
    states.set(row.event.subject, state);
  }
  const subjects: string[] = [];
  for (const [subject, state] of states) {
    if (state.email !== email) continue;
    if (state.role) throw new InvitationConflict('already_member');
    subjects.push(subject);
  }
  return subjects;
}

function checkHistory(rows: StoredEvent[], input: Input) {
  for (const row of rows) {
    if (row.event.type === 'member.removed') throw new InvitationConflict('access_removed');
    if (legacyMemberRole(row.event)) throw new InvitationConflict('already_member');
    const data = memberInvitedDataSchema.parse(row.event.data);
    if (row.event.type !== 'member.invited' || data.memberId !== input.memberId
      || data.email !== input.email || data.invitedIdentity) {
      throw new InvitationConflict('identity_mismatch');
    }
  }
}

export async function invitationCommand(store: EventStore, binding: Binding,
  actor: string, input: Input) {
  // Check current access before returning a receipt or loading longer target history.
  await readActiveMember(store, binding, actor, 'admin');
  const derivedId = `invitation-${digest([binding.silo, input.email])}`;
  if (input.memberId !== derivedId) throw new InvitationConflict('identity_mismatch');
  const subject = `member-${input.memberId}`;
  const deadline = performance.now() + 10_000;
  const rows = await history(store, subject, binding.silo, deadline);
  checkHistory(rows, input);
  const saved = previous(rows, input, actor);
  if (saved) return saved;
  const targets = await checkTargets(store, binding.silo, input.email, deadline);
  // Finish longer reads before starting the two-second write access check.
  const subjects = [`member-${actor}`, `ownership-${binding.silo}`, subject, ...targets];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const authority = { requiredRole: 'admin' as const, fresh };
  await activeMember(store, binding, actor, authority);
  const time = new Date();
  const expiresAt = new Date(time.getTime() + 7 * 86_400_000).toISOString();
  const invitationId = digest([binding.silo, actor, input.memberId, input.commandId]);
  const data = { memberId: input.memberId, email: input.email, role: input.role,
    personalAssistant: input.personalAssistant, invitedBy: actor, invitationId, expiresAt };
  const event = { id: invitationId, commandId: input.commandId, subject,
    silo: binding.silo, type: 'member.invited', source: 'opencrane-server',
    principal: { kind: 'human' as const, id: actor }, time: time.toISOString(), data };
  await fresh();
  const command = { event, expectedSequence: input.expectedSequence, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status === 'unavailable' || result.status === 'rejected') {
    throw new Error('Invitation append unavailable');
  }
  const updated = await history(store, subject, binding.silo, performance.now() + 10_000);
  const completed = previous(updated, input, actor);
  if (completed) return completed;
  throw new InvitationConflict('concurrent_change');
}

export async function invitationStatus(store: EventStore, binding: Binding,
  actor: string, memberId: string, commandId: string) {
  await readActiveMember(store, binding, actor, 'admin');
  const rows = await history(store, `member-${memberId}`, binding.silo, performance.now() + 10_000);
  function matches(row: StoredEvent) {
    return row.event.type === 'member.invited' && row.event.commandId === commandId;
  }
  const row = rows.find(matches);
  if (!row) return { status: 'not_found' as const };
  return receipt(row);
}
