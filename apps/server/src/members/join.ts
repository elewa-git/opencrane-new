import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberInvitedDataSchema, memberJoinedDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';

export const joinInputSchema = z.object({
  memberId: z.string().min(1).max(200).regex(/^[^.*>\s]+$/u),
  invitationId: z.string().min(1).max(200),
  commandId: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(200),
}).strict();

type JoinInput = z.infer<typeof joinInputSchema>;
export type JoinResult =
  | { status: 'joined' | 'already_joined'; memberId: string; sequence: number }
  | { status: 'refused'; reason: 'no_session' | 'wrong_silo' | 'wrong_identity'
      | 'unknown_invitation' | 'expired_invitation' | 'unbound_invitation'
      | 'invitation_not_pending' | 'command_id_reused' | 'concurrent_change'
      | 'invalid_request' | 'wrong_origin' | 'invalid_history' | 'ownership_stream_required' }
  | { status: 'unavailable' };

interface JoinContext {
  silo: string;
  issuer: string;
  sub: string;
}

export type JoinStore = Pick<EventStore, 'readStream' | 'append'>;
type Outcome = JoinResult | { status: 'unavailable'; cause: unknown };
type Invitation = z.infer<typeof memberInvitedDataSchema>;

async function history(store: JoinStore, subject: string): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  // Bound the history read as well as the adapter's bounded append retries.
  for await (const stored of store.readStream(subject, 1, performance.now() + 10_000)) {
    events.push(stored);
  }
  return events;
}

function retry(events: StoredEvent[], input: JoinInput, context: JoinContext): JoinResult | undefined {
  const previous = events.find(({ event }) => event.commandId === input.commandId
    && event.principal?.kind === 'human' && event.principal.id === context.sub);
  if (!previous) return undefined;
  const invitation = events.slice(0, events.indexOf(previous)).findLast(({ event }) => event.type === 'member.invited');
  const bound = memberInvitedDataSchema.safeParse(invitation?.event.data);
  if (!bound.success || bound.data.invitedIdentity?.issuer !== context.issuer
    || bound.data.invitedIdentity.sub !== context.sub) return { status: 'refused', reason: 'wrong_identity' };
  const data = memberJoinedDataSchema.safeParse(previous.event.data);
  if (previous.event.type !== 'member.joined' || !data.success
    || data.data.invitationId !== input.invitationId || data.data.displayName !== input.displayName) {
    return { status: 'refused', reason: 'command_id_reused' };
  }
  return { status: 'already_joined', memberId: input.memberId, sequence: previous.sequence };
}

function pending(events: StoredEvent[], input: JoinInput, context: JoinContext, now: Date): Invitation | JoinResult {
  const latest = events.at(-1);
  const invitation = events.findLast(({ event }) => event.type === 'member.invited');
  if (!invitation) return { status: 'refused', reason: 'unknown_invitation' };
  const data = memberInvitedDataSchema.parse(invitation.event.data);
  if (data.invitationId !== input.invitationId) return { status: 'refused', reason: 'unknown_invitation' };
  if (!data.invitedIdentity || !data.expiresAt) return { status: 'refused', reason: 'unbound_invitation' };
  if (data.invitedIdentity.issuer !== context.issuer || data.invitedIdentity.sub !== context.sub) {
    return { status: 'refused', reason: 'wrong_identity' };
  }
  if (latest !== invitation) return { status: 'refused', reason: 'invitation_not_pending' };
  if (Date.parse(data.expiresAt) <= now.getTime()) return { status: 'refused', reason: 'expired_invitation' };
  const admission = admissionRefusal(events, data);
  if (admission) {
    return admission;
  }
  return data;
}

function validateHistory(events: StoredEvent[], input: JoinInput, context: JoinContext): JoinResult | undefined {
  if (events.some(({ event }) => event.silo !== context.silo)) return { status: 'refused', reason: 'wrong_silo' };
  if (events.some(({ event }) => {
    const data: unknown = event.data;
    return event.subject !== `member-${input.memberId}` || typeof data !== 'object' || data === null
      || !('memberId' in data) || data.memberId !== input.memberId;
  })) return { status: 'refused', reason: 'invalid_history' };
  return undefined;
}

/** The route supplies an authenticated identity and deployment-owned silo, never body claims. */
export async function joinMember(
  store: JoinStore, input: JoinInput, context: JoinContext, now: () => Date,
): Promise<Outcome> {
  try {
    const subject = `member-${input.memberId}`;
    const events = await history(store, subject);
    const refused = validateHistory(events, input, context);
    if (refused) return refused;
    const previous = retry(events, input, context);
    if (previous) return previous;
    const invitation = pending(events, input, context, now());
    if ('status' in invitation) return invitation;
    const id = randomUUID();
    const result = await store.append({
      expectedSequence: events.at(-1)?.sequence ?? 0,
      event: {
        id, commandId: input.commandId, type: 'member.joined', source: 'opencrane-server',
        time: now().toISOString(), subject, silo: context.silo,
        principal: { kind: 'human', id: context.sub },
        data: { memberId: input.memberId, invitationId: input.invitationId,
          displayName: input.displayName, email: invitation.email, role: invitation.role },
      },
    });
    if (result.status === 'unavailable') return result;
    if (result.status === 'rejected') throw new Error(`Join append rejected: ${result.reason}`);
    // The adapter can recognise a concurrent retry itself. Read the durable id
    // to distinguish our append from that earlier success, without another write.
    const after = await history(store, subject);
    const invalid = validateHistory(after, input, context);
    if (invalid) return invalid;
    const completed = retry(after, input, context);
    if (completed?.status === 'already_joined') {
      const ours = after.some((stored) => stored.sequence === completed.sequence && stored.event.id === id);
      return { ...completed, status: ours ? 'joined' : 'already_joined' };
    }
    if (completed) return completed;
    if (result.status === 'conflict') return { status: 'refused', reason: 'concurrent_change' };
    throw new Error('Join append was not found in its stream');
  } catch (cause) {
    return { status: 'unavailable', cause };
  }
}

function isMembershipAdmission(row: StoredEvent) {
  return ['member.joined', 'silo.owner_bootstrapped', 'member.removed'].includes(row.event.type);
}

function admissionRefusal(events: StoredEvent[], invitation: Invitation): JoinResult | undefined {
  // Invitation acceptance grants membership; appointment belongs to the ownership stream.
  if (invitation.role === 'owner') {
    return { status: 'refused', reason: 'ownership_stream_required' };
  }
  // A new invitation cannot rewrite an active member's role or identity.
  const membership = events.findLast(isMembershipAdmission);
  if (membership && membership.event.type !== 'member.removed') {
    return { status: 'refused', reason: 'invitation_not_pending' };
  }
  return undefined;
}
