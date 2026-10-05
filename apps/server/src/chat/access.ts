import { conversationCreatedDataSchema } from '@opencrane/events';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { conversationAccessFence, currentMembership } from '@opencrane/models';
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
  fresh?: Fence;
}

/** Read participants from creation; messages do not decide who has access. */
export async function chatAccess(options: ChatOptions, request: AccessRequest) {
  const { memberId, conversationId, relation = 'read', allowApplying = false } = request;
  const subjects = [`member-${memberId}`];
  if (conversationId) subjects.push(`conversation-${conversationId}`);
  const fresh = request.fresh ?? await conversationAccessFence(
    options.store, performance.now(), subjects, request.deadline);
  await activeChatMember(options, memberId, fresh);
  let mode: 'agent_session' | 'direct' | undefined;
  let colleagueId: string | undefined;
  if (conversationId) {
    const row = await conversationCreation(options, conversationId, fresh.deadline);
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
  }
  await fresh();
  const context = { mode, colleagueId };
  return Object.assign(fresh, context);
}

/** Check current membership without waiting for role or owner changes to reach OpenFGA.
 * Read removals from the member stream at once, and confirm joins through OpenFGA.
 */
export async function activeChatMember(options: ChatOptions, memberId: string, fresh: Fence) {
  const membership = await currentMembership(options.store, options.silo, memberId, fresh);
  if (!membership.role) throw new ChatRefused('Active silo membership required');
  const auth = memberAuthorisation(options.binding);
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
  return error instanceof ChatRefused || error instanceof GroupRefused;
}
