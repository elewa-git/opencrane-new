import { conversationCreatedDataSchema } from '@opencrane/events';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { conversationAccessFence, currentMembership, PayingGroupRefused }
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
type Fence = Awaited<ReturnType<typeof conversationAccessFence>>;
interface AccessRequest {
  memberId: string;
  conversationId?: string | undefined;
  relation?: 'read' | 'post';
  deadline?: number;
  allowApplying?: boolean;
}

// Check access once. Content reads have their own time limit.
export async function chatAccess(options: ChatOptions, request: AccessRequest) {
  const deadline = request.deadline ?? performance.now() + 2000;
  await activeChatMember(options, request.memberId);
  return conversationAccess(options, request, deadline);
}

async function readChatAccessContext(options: ChatOptions, memberId: string,
  conversationId: string, deadline: number) {
  const row = await conversationCreation(options, conversationId, deadline);
  const created = conversationCreatedDataSchema.parse(row.event.data);
  if (created.mode === 'direct' && !created.participantIds.includes(memberId)) {
    throw new ChatRefused('Conversation refused');
  }
  const subjects = [`member-${memberId}`, `ownership-${options.silo}`];
  let privateSession: Awaited<ReturnType<typeof privateSessionCreation>> | undefined;
  if (created.mode === 'agent_session') {
    privateSession = await privateSessionCreation(options, conversationId, row.event);
    subjects.push(`assistant-${privateSession.created.assistantId}`);
    if (privateSession.assistant.kind === 'team') {
      subjects.push(`team-${privateSession.assistant.ownerId}`);
    }
  }
  return { created, subjects, privateSession };
}

// Keep creation facts for this socket. Later messages cannot change its owner or assistant.
export async function chatSubscriptionAccess(options: ChatOptions, memberId: string,
  conversationId: string, deadline: number) {
  const context = await readChatAccessContext(options, memberId, conversationId, deadline);
  const { created, subjects, privateSession } = context;
  const auth = memberAuthorisation(options.binding);
  let previousHeads: number[] | undefined;
  let conversationHead: number | undefined;
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
    let changed = !previousHeads || heads.some(headMoved);
    let currentConversationHead: number | undefined;
    let participantsApplied = true;
    if (created.mode === 'direct') {
      const subject = `conversation-${conversationId}`;
      currentConversationHead = await readHead(subject);
      if (conversationHead !== undefined && currentConversationHead !== conversationHead) {
        const participantChanges = await chatParticipantChanges(
          options.store, subject, conversationHead, currentConversationHead, checkDeadline);
        changed ||= participantChanges.length > 0;
        // Confirm these events before checking permission, so an old allowance is not saved.
        for (const eventId of participantChanges) {
          if (!await auth.applied(eventId)) participantsApplied = false;
        }
      }
    }
    if (changed) {
      await activeChatMember(options, memberId, undefined, auth);
      const permission = await auth.conversation(memberId, conversationId, 'read');
      if (permission.status === 'unavailable') throw new Error('IAM unavailable');
      if (!permission.allowed) throw new ChatRefused('Conversation refused');
      if (privateSession) await requirePrivateReader(options, memberId, privateSession);
    }
    // Save positions from before the check so a change during it is checked next time.
    previousHeads = heads;
    if (participantsApplied) conversationHead = currentConversationHead;
    return created.mode;
  }
}

async function chatParticipantChanges(store: EventStore, subject: string,
  previousHead: number, currentHead: number, deadline: number) {
  const eventIds: string[] = [];
  // Read only new direct-chat events. Messages and files do not change access.
  for await (const row of store.readStream(subject, previousHead + 1, deadline)) {
    if (row.sequence > currentHead) break;
    if (['participant.added', 'participant.removed'].includes(row.event.type)) {
      eventIds.push(row.event.id);
    }
  }
  return eventIds;
}

// Keep the write check short by opening it after command history has loaded.
export async function writeChatAccess(options: ChatOptions, request: AccessRequest) {
  const subjects = [`member-${request.memberId}`];
  if (request.conversationId) subjects.push(`conversation-${request.conversationId}`);
  const fresh = await conversationAccessFence(
    options.store, performance.now(), subjects, request.deadline);
  await activeChatMember(options, request.memberId, fresh);
  const context = await conversationAccess(options, request, fresh.deadline);
  await fresh();
  return Object.assign(fresh, context);
}

async function conversationAccess(options: ChatOptions, request: AccessRequest, deadline: number) {
  const { memberId, conversationId, relation = 'read', allowApplying = false } = request;
  let mode: 'agent_session' | 'direct' | undefined;
  let colleagueId: string | undefined;
  if (conversationId) {
    const row = await conversationCreation(options, conversationId, deadline);
    const created = conversationCreatedDataSchema.parse(row.event.data);
    mode = created.mode;
    if (created.mode === 'direct' && !created.participantIds.includes(memberId)) {
      throw new ChatRefused('Conversation refused');
    }
    if (created.mode === 'direct') {
      function isOtherParticipant(participantId: string) {
        return participantId !== memberId;
      }
      colleagueId = created.participantIds.find(isOtherParticipant);
    }
    const auth = memberAuthorisation(options.binding);
    // Require the recorded participants even before OpenFGA has applied creation.
    const applying = allowApplying && !await auth.applied(row.event.id);
    if (applying) {
      if (mode === 'agent_session' && created.createdBy !== memberId) {
        throw new ChatRefused('Conversation refused');
      }
    } else {
      const permission = await auth.conversation(memberId, conversationId, relation);
      if (permission.status === 'unavailable') throw new Error('IAM unavailable');
      if (!permission.allowed) throw new ChatRefused('Conversation refused');
    }
    if (mode === 'agent_session') await readPrivateSession(options, memberId, conversationId);
  }
  return { mode, colleagueId };
}

/** Check current membership without waiting for role or owner changes to reach OpenFGA.
 * Read removals from the member stream at once, and confirm joins through OpenFGA.
 */
export async function activeChatMember(options: ChatOptions, memberId: string, fresh?: Fence,
  authorisation?: ReturnType<typeof memberAuthorisation>) {
  const membership = await currentMembership(options.store, options.silo, memberId, fresh);
  if (!membership.role) throw new ChatRefused('Active silo membership required');
  const auth = authorisation ?? memberAuthorisation(options.binding);
  const permission = await auth.check(memberId, 'member');
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new ChatRefused('Membership unavailable');
}

async function conversationCreation(
  options: ChatOptions, conversationId: string, deadline: number,
) {
  for await (const row of options.store.readStream(`conversation-${conversationId}`, 1, deadline)) {
    if (row.event.silo !== options.silo) throw new ChatRefused('Conversation refused');
    if (row.event.type === 'conversation.created') return row;
  }
  throw new ChatRefused('Conversation refused');
}

export function recordedChatMode(access: Awaited<ReturnType<typeof chatAccess>>) {
  if (!access.mode) throw new ChatRefused('Conversation refused');
  return access.mode;
}

export function isChatRefused(error: unknown) {
  return error instanceof ChatRefused || error instanceof GroupRefused ||
    error instanceof PayingGroupRefused;
}
