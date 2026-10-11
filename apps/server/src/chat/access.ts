import { legacyParticipation, participation, ParticipationRefused, ParticipationApplying, chatMembership }
  from './participation.ts';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { conversationAccessFence, PayingGroupRefused }
  from '@opencrane/models';
import { readPrivateSession, privateSessionCreation, requirePrivateReader }
  from './private-session.ts';
import { GroupRefused } from '../members/groups.ts';
import type { EventStore } from '@opencrane/event-store';
import type { Query, connectMemberFeed } from '@opencrane/projections';
import type { conversationKeys } from './keys.ts';

export interface ChatOptions {
  silo: string;
  store: EventStore;
  db: Query;
  keys: ReturnType<typeof conversationKeys>;
  binding: Binding;
  feed: Pick<Awaited<ReturnType<typeof connectMemberFeed>>, 'memberId'>;
}

export class ChatRefused extends Error {}
export { ParticipationApplying as ChatAccessApplying };
type Fence = Awaited<ReturnType<typeof conversationAccessFence>>;
interface AccessRequest {
  memberId: string;
  conversationId?: string | undefined;
  relation?: 'read' | 'post';
  deadline?: number;
  allowApplying?: boolean;
}

// Check access once. Content reads have their own time limit.
export async function chatAccess(options: ParticipationOptions, request: AccessRequest) {
  const deadline = request.deadline ?? performance.now() + 2000;
  await activeChatMember(options, request.memberId);
  return conversationAccess(options, request, deadline);
}

async function readChatAccessContext(options: ChatOptions, memberId: string,
  conversationId: string, deadline: number) {
  const legacy = await legacyParticipation(options.store, options.db, options.silo,
    conversationId, deadline);
  const access = await participation(options.store, options.silo, conversationId,
    memberId, legacy, deadline);
  const created = access.created;
  const subjects = [`member-${memberId}`, `participation-${conversationId}`];
  let privateSession: Awaited<ReturnType<typeof privateSessionCreation>> | undefined;
  if (created.mode === 'agent_session') {
    privateSession = await privateSessionCreation(options, conversationId);
    if (privateSession.assistant.kind === 'team') {
      subjects.push(`team-${privateSession.assistant.ownerId}`);
    }
  }
  return { created, subjects, privateSession, access };
}

// Keep creation facts for this socket. Later messages cannot change its owner or assistant.
export async function chatSubscriptionAccess(options: ChatOptions, memberId: string,
  conversationId: string, deadline: number) {
  const context = await readChatAccessContext(options, memberId, conversationId, deadline);
  const { created, subjects, privateSession } = context;
  let previousHeads: number[] | undefined;
  let current = context.access;
  return check;

  async function check(checkDeadline: number) {
    async function readHead(subject: string) {
      return options.store.head(subject, checkDeadline);
    }
    const headReads = subjects.map(readHead);
    const heads = await Promise.all(headReads);
    function headMoved(head: number, index: number) {
      return head !== previousHeads?.[index];
    }
    const changed = !previousHeads || heads.some(headMoved);
    if (changed) {
      const checks = [activeChatMember(options, memberId),
        conversationParticipation(options, memberId, conversationId, checkDeadline)] as const;
      const [, checked] = await Promise.all(checks);
      current = checked;
      if (current.joinPosition !== context.access.joinPosition) {
        throw new ChatRefused('Conversation participation changed');
      }
      if (privateSession) await requirePrivateReader(options, memberId, privateSession);
    }
    // Save positions from before the check so a change during it is checked next time.
    previousHeads = heads;
    return { mode: created.mode, joinPosition: current.joinPosition,
      accessPosition: current.accessPosition };
  }
}

// Keep the write check short by opening it after command history has loaded.
export async function writeChatAccess(options: ChatOptions, request: AccessRequest) {
  const subjects = [`member-${request.memberId}`];
  if (request.conversationId) subjects.push(`participation-${request.conversationId}`);
  const fresh = await conversationAccessFence(
    options.store, performance.now(), subjects, request.deadline);
  await activeChatMember(options, request.memberId, fresh);
  const context = await conversationAccess(options, request, fresh.deadline);
  await fresh();
  return Object.assign(fresh, context);
}

async function conversationAccess(options: ParticipationOptions,
  request: AccessRequest, deadline: number) {
  const { memberId, conversationId, relation = 'read', allowApplying = false } = request;
  let mode: 'agent_session' | 'direct' | 'group' | undefined;
  let colleagueId: string | undefined;
  let createdBy: string | undefined;
  let joinPosition = 0;
  let participantIds: string[] = [];
  let accessPosition = 0;
  if (conversationId) {
    const access = await conversationParticipation(options, memberId, conversationId,
      deadline, relation, allowApplying);
    const created = access.created;
    createdBy = created.createdBy;
    mode = created.mode;
    joinPosition = access.joinPosition;
    participantIds = access.participantIds;
    accessPosition = access.accessPosition;
    if (created.mode === 'direct') {
      function isOtherParticipant(participantId: string) {
        return participantId !== memberId;
      }
      colleagueId = participantIds.find(isOtherParticipant);
    }
    if (mode === 'agent_session') await readPrivateSession(options, memberId, conversationId);
  }
  return { mode, colleagueId, joinPosition, participantIds, accessPosition, createdBy };
}

type ParticipationOptions = Pick<ChatOptions, 'store' | 'db' | 'silo' | 'binding'>;

export function conversationParticipation(options: ParticipationOptions,
  memberId: string, conversationId: string, deadline = performance.now() + 2000,
  relation: 'read' | 'post' = 'read', allowApplying = false) {
  const read = conversationParticipationReader(options, memberId);
  return read(conversationId, deadline, relation, allowApplying);
}

// Reuse membership facts within one request, then check their position after OpenFGA replies.
function currentChatMemberReader(options: ParticipationOptions, memberId: string) {
  let checkedPosition: number | undefined;
  let membershipRead: Promise<boolean> | undefined;
  async function requireMember(deadline: number) {
    const position = await options.store.head(`member-${memberId}`, deadline);
    if (position !== checkedPosition || !membershipRead) {
      membershipRead = chatMembership(options.store, options.silo, memberId, deadline);
      checkedPosition = position;
    }
    const active = await membershipRead;
    if (!active) throw new ChatRefused('Active silo membership required');
  }
  return requireMember;
}

export function conversationParticipationReader(options: ParticipationOptions, memberId: string) {
  const requireMember = currentChatMemberReader(options, memberId);
  const auth = memberAuthorisation(options.binding);
  async function read(conversationId: string, deadline = performance.now() + 2000,
    relation: 'read' | 'post' = 'read', allowApplying = false) {
    const subject = `participation-${conversationId}`;
    const position = await options.store.head(subject, deadline);
    const legacy = await legacyParticipation(options.store, options.db, options.silo,
      conversationId, deadline);
    let current = await participation(options.store, options.silo, conversationId,
      memberId, legacy, deadline);
    await requireMember(deadline);
    const permission = await auth.conversation(memberId, conversationId, relation);
    if (permission.status === 'unavailable') throw new Error('IAM unavailable');
    await requireMember(deadline);
    // Check saved changes after OpenFGA replies so an old permission cannot hide a removal.
    const latestPosition = await options.store.head(subject, deadline);
    if (latestPosition !== position) {
      current = await participation(options.store, options.silo, conversationId,
        memberId, legacy, deadline);
    }
    if (!await auth.applied(current.joinEventId)) {
      if (allowApplying) return current;
      throw new ParticipationApplying('Conversation access still applying');
    }
    if (!permission.allowed) throw new ChatRefused('Conversation refused');
    return current;
  }
  return read;
}

/** Check current membership without waiting for role or owner changes to reach OpenFGA.
 * Read removals from the member stream at once, and confirm joins through OpenFGA.
 */
export async function activeChatMember(options: ParticipationOptions, memberId: string,
  fresh?: Fence) {
  fresh?.include(`member-${memberId}`);
  const membership = await chatMembership(options.store, options.silo, memberId, fresh?.deadline);
  if (!membership) throw new ChatRefused('Active silo membership required');
  const auth = memberAuthorisation(options.binding);
  const permission = await auth.check(memberId, 'member');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new ChatRefused('Membership unavailable');
}

export function recordedChatMode(access: Awaited<ReturnType<typeof chatAccess>>) {
  if (!access.mode) throw new ChatRefused('Conversation refused');
  return access.mode;
}

export function isChatRefused(error: unknown) {
  return error instanceof ChatRefused || error instanceof ParticipationRefused ||
    error instanceof GroupRefused ||
    error instanceof PayingGroupRefused;
}
