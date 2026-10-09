import { randomUUID } from 'node:crypto';
import { readActiveIdentity } from './admission.ts';
import { z } from 'zod';
import { authorityFence, currentMembership, isAuthorityChanged } from '@opencrane/models';
import { memberInvitedDataSchema, memberJoinedDataSchema } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { Query } from '@opencrane/projections';

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
      | 'inviter_authority_ended' | 'invalid_request' | 'wrong_origin'
      | 'invalid_history' | 'ownership_stream_required' | 'sign_in_again'
      | 'unsupported_email' | 'access_removed' | 'already_member' }
  | { status: 'unavailable' };

interface JoinContext {
  silo: string;
  issuer: string;
  sub: string;
  authTime: number;
  email?: string | undefined;
  emailVerified?: boolean | undefined;
}

export type JoinStore = Pick<EventStore, 'readStream' | 'append' | 'head'>;
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
  const data = memberJoinedDataSchema.safeParse(previous.event.data);
  if (!bound.success) return { status: 'refused', reason: 'wrong_identity' };
  const identity = bound.data.invitedIdentity ?? (data.success ? data.data.identity : undefined);
  if (identity?.issuer !== context.issuer || identity.sub !== context.sub) {
    return { status: 'refused', reason: 'wrong_identity' };
  }
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
  if (!data.expiresAt) return { status: 'refused', reason: 'unbound_invitation' };
  if (data.invitedIdentity && (data.invitedIdentity.issuer !== context.issuer
    || data.invitedIdentity.sub !== context.sub)) {
    return { status: 'refused', reason: 'wrong_identity' };
  }
  const identityRefusal = checkEmailAndSignIn(context, data.email, now);
  if (identityRefusal) return identityRefusal;
  if (latest !== invitation) return { status: 'refused', reason: 'invitation_not_pending' };
  if (Date.parse(data.expiresAt) <= now.getTime()) return { status: 'refused', reason: 'expired_invitation' };
  const admission = admissionRefusal(events, data);
  if (admission) {
    return admission;
  }
  return data;
}

function isAscii(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) > 127) {
      return false;
    }
  }
  return true;
}

function checkEmailAndSignIn(context: JoinContext, invitedEmail: string,
  now: Date): JoinResult | undefined {
  if (!context.email || context.emailVerified === undefined) {
    return { status: 'refused', reason: 'sign_in_again' };
  }
  const signedInEmail = context.email.trim();
  const invitationEmail = invitedEmail.trim();
  if (!isAscii(signedInEmail) || !isAscii(invitationEmail)) {
    return { status: 'refused', reason: 'unsupported_email' };
  }
  const signedInAddress = signedInEmail.toLowerCase();
  const invitedAddress = invitationEmail.toLowerCase();
  if (context.emailVerified !== true || signedInAddress !== invitedAddress) {
    return { status: 'refused', reason: 'wrong_identity' };
  }
  const signInAge = now.getTime() / 1000 - context.authTime;
  if (signInAge < 0 || signInAge > 3600) {
    return { status: 'refused', reason: 'sign_in_again' };
  }
  return undefined;
}

function isRemoval(row: StoredEvent): boolean {
  return row.event.type === 'member.removed';
}

function validateHistory(events: StoredEvent[], input: JoinInput, context: JoinContext): JoinResult | undefined {
  if (hasDifferentIdentity(events, context)) {
    return { status: 'refused', reason: 'wrong_identity' };
  }
  if (events.some(({ event }) => event.silo !== context.silo)) return { status: 'refused', reason: 'wrong_silo' };
  if (events.some(({ event }) => {
    const data: unknown = event.data;
    return event.subject !== `member-${input.memberId}` || typeof data !== 'object' || data === null
      || !('memberId' in data) || data.memberId !== input.memberId;
  })) return { status: 'refused', reason: 'invalid_history' };
  // Keep a removed admission closed, including repeats of its saved join.
  if (events.some(isRemoval)) {
    return { status: 'refused', reason: 'access_removed' };
  }
  return undefined;
}

/** Use the route's checked identity and configured silo instead of request-body claims. */
export async function joinMember(
  store: JoinStore, input: JoinInput, context: JoinContext, now: () => Date, db?: Query,
): Promise<Outcome> {
  try {
    const subject = `member-${input.memberId}`;
    const events = await history(store, subject);
    const refused = validateHistory(events, input, context);
    if (refused) return refused;
    const previous = retry(events, input, context);
    if (previous) return previous;
    const confirmed = await confirmInvitation(store, events, input, context, now, db);
    if ('status' in confirmed) return confirmed;
    const invitation = confirmed.invitation;
    const id = randomUUID();
    const condition = joinCondition(events, confirmed);
    const command = {
      ...condition,
      event: {
        id, commandId: input.commandId, type: 'member.joined', source: 'opencrane-server',
        time: now().toISOString(), subject, silo: context.silo,
        principal: { kind: 'human', id: context.sub },
        data: joinData(input, invitation, context),
      },
    };
    const result = await store.append(command);
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

function joinCondition(events: StoredEvent[], confirmed: ConfirmedInvitation) {
  if (confirmed.memberSequence !== undefined) {
    return {
      expectedSequence: confirmed.memberSequence,
      expectedSubject: 'member-*',
      deadline: confirmed.deadline,
    };
  }
  const expectedSequence = events.at(-1)?.sequence ?? 0;
  return { expectedSequence, deadline: confirmed.deadline };
}

function joinData(input: JoinInput, invitation: Invitation, context: JoinContext) {
  const personalAssistant = invitation.personalAssistant ?? 'provision';
  const identity = { issuer: context.issuer, sub: context.sub };
  const binding = invitation.invitedIdentity ? {} : { identity };
  return {
    ...binding,
    memberId: input.memberId,
    invitationId: input.invitationId,
    displayName: input.displayName,
    email: invitation.email,
    role: invitation.role,
    personalAssistant,
  };
}

function isMembershipAdmission(row: StoredEvent) {
  return ['member.joined', 'silo.owner_bootstrapped', 'member.removed'].includes(row.event.type);
}

function admissionRefusal(events: StoredEvent[], invitation: Invitation): JoinResult | undefined {
  // Accepting an invitation adds a member. Choosing an owner is recorded in the
  // ownership event history.
  if (invitation.role === 'owner') {
    return { status: 'refused', reason: 'ownership_stream_required' };
  }
  // Keep old access with the old member id. A return needs a new admission.
  const membership = events.findLast(isMembershipAdmission);
  if (membership) {
    return { status: 'refused', reason: 'invitation_not_pending' };
  }
  return undefined;
}

function hasDifferentIdentity(events: StoredEvent[], context: JoinContext) {
  for (const row of events) {
    const fields = identityHistorySchema.parse(row.event.data);
    const identity = fields.invitedIdentity ?? fields.identity;
    if (identity && (identity.issuer !== context.issuer || identity.sub !== context.sub)) {
      return true;
    }
  }
  return false;
}

const identityHistorySchema = z.object({
  identity: z.object({ issuer: z.string(), sub: z.string() }).optional(),
  invitedIdentity: z.object({ issuer: z.string(), sub: z.string() }).optional(),
});


interface ConfirmedInvitation {
  invitation: Invitation;
  memberSequence: number | undefined;
  deadline: number;
}

async function confirmInvitation(store: JoinStore, events: StoredEvent[], input: JoinInput,
  context: JoinContext, now: () => Date, db?: Query): Promise<ConfirmedInvitation | JoinResult> {
  const invitation = pending(events, input, context, now());
  if ('status' in invitation) return invitation;
  let memberSequence: number | undefined;
  if (!invitation.invitedIdentity) {
    const identity = await confirmEmailIdentity(store, events, input, context, now, db);
    if ('status' in identity) return identity;
    memberSequence = identity.memberSequence;
  }
  const subjects = [
    `member-${input.memberId}`, `member-${invitation.invitedBy}`, `ownership-${context.silo}`,
  ];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const inviter = await currentMembership(store, context.silo, invitation.invitedBy, fresh);
  if (!['owner', 'admin'].includes(inviter.role)) {
    return { status: 'refused', reason: 'inviter_authority_ended' };
  }
  // Recheck access and expiry just before the conditional append.
  try {
    await fresh();
  } catch (error) {
    if (!isAuthorityChanged(error)) {
      throw error;
    }
    // Explain a confirmed inviter removal or demotion as an access refusal.
    // Keep store errors and other concurrent changes unavailable.
    const latestInviter = await currentMembership(
      store, context.silo, invitation.invitedBy, fresh);
    if (!['owner', 'admin'].includes(latestInviter.role)) {
      return { status: 'refused', reason: 'inviter_authority_ended' };
    }
    // Explain a competing join instead of leaving the accepting account unsure.
    if (!invitation.invitedIdentity) {
      const rechecked = await changedEmailInvitation(store, input, context, now());
      if (rechecked) return rechecked;
    }
    throw error;
  }
  if (memberSequence !== undefined) {
    const latest = await store.head('member-*', fresh.deadline);
    if (latest !== memberSequence) {
      const rechecked = await changedEmailInvitation(store, input, context, now());
      return rechecked ?? { status: 'refused', reason: 'concurrent_change' };
    }
  }
  const checked = pending(events, input, context, now());
  if ('status' in checked) return checked;
  // Keep the same member position in the append so another invitation cannot join this account.
  return { invitation: checked, memberSequence, deadline: fresh.deadline };
}

async function confirmEmailIdentity(
  store: JoinStore, events: StoredEvent[], input: JoinInput,
  context: JoinContext, now: () => Date, db?: Query,
): Promise<{ memberSequence: number } | JoinResult> {
  if (!db) return { status: 'unavailable' };
  const identity = await readActiveIdentity(
    store, db, context.silo, context.issuer, context.sub, now());
  if (identity.active) return { status: 'refused', reason: 'already_member' };
  // Keep the invitation unchanged through the account check. Its captured member
  // position protects later changes, but cannot detect an earlier renewal.
  const invitationSequence = events.at(-1)?.sequence ?? 0;
  const latestInvitation = await store.head(`member-${input.memberId}`,
    performance.now() + 10_000);
  if (latestInvitation !== invitationSequence) {
    const rechecked = await changedEmailInvitation(store, input, context, now());
    return rechecked ?? { status: 'refused', reason: 'concurrent_change' };
  }
  return { memberSequence: identity.memberSequence };
}

async function changedEmailInvitation(store: JoinStore, input: JoinInput,
  context: JoinContext, now: Date): Promise<JoinResult | undefined> {
  const events = await history(store, `member-${input.memberId}`);
  const refused = validateHistory(events, input, context);
  if (refused) return refused;
  const previous = retry(events, input, context);
  if (previous) return previous;
  const invitation = pending(events, input, context, now);
  if ('status' in invitation) return invitation;
  return undefined;
}
