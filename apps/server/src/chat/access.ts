import { conversationCreatedDataSchema } from '@opencrane/events';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { conversationAccessFence } from '@opencrane/models';
import { z } from 'zod';
import { activeMember, GroupRefused } from '../members/groups.ts';
import { chatHistory } from './commands.ts';
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

type Rows = Awaited<ReturnType<typeof chatHistory>>;
export class ChatRefused extends Error {}

/** Exact authority streams share one two-second deadline, including the final response fence. */
export async function chatAccess(
  options: ChatOptions, memberId: string, conversationId?: string,
  relation: 'read' | 'post' = 'read', callerDeadline = Infinity, allowApplying = false,
) {
  const subjects = [`member-${memberId}`];
  if (conversationId) subjects.push(`conversation-${conversationId}`);
  const fresh = await conversationAccessFence(
    options.store, performance.now(), subjects, callerDeadline);
  await activeMember(options.store, options.binding, memberId, false, fresh);
  let mode: 'agent_session' | 'direct' | undefined;
  if (conversationId) {
    const rows = await conversationHistory(options, conversationId, fresh.deadline);
    const participation = conversationParticipation(rows, memberId);
    mode = participation.mode;
    await projectedAccess(
      options, memberId, conversationId, relation, participation.receipts, allowApplying);
  }
  await fresh();
  const context = { mode };
  return Object.assign(fresh, context);
}

async function conversationHistory(options: ChatOptions, conversationId: string, deadline: number) {
  try {
    return await chatHistory(options.store, options.silo, conversationId, deadline);
  } catch (error) {
    if (error instanceof Error && error.message === 'Conversation silo mismatch') {
      throw new ChatRefused('Conversation refused');
    }
    throw error;
  }
}

function conversationParticipation(rows: Rows, memberId: string) {
  function isCreated(row: Rows[number]) {
    return row.event.type === 'conversation.created';
  }
  const createdRow = rows.find(isCreated);
  if (!createdRow) throw new ChatRefused('Conversation refused');
  const created = conversationCreatedDataSchema.parse(createdRow.event.data);
  let participant = created.createdBy === memberId;
  if (created.mode === 'direct') participant = created.participantIds.includes(memberId);
  const receipts = [createdRow.event.id];
  for (const row of rows) {
    if (!['participant.added', 'participant.removed'].includes(row.event.type)) continue;
    // Direct audiences cannot change after creation, even if malformed events appear.
    if (created.mode === 'direct') throw new ChatRefused('Direct audience changed');
    const data = z.object({ participantId: z.string() }).parse(row.event.data);
    if (data.participantId === memberId) participant = row.event.type === 'participant.added';
    receipts.push(row.event.id);
  }
  if (!participant) throw new ChatRefused('Conversation refused');
  return { receipts, mode: created.mode };
}

export function recordedChatMode(access: Awaited<ReturnType<typeof chatAccess>>) {
  if (!access.mode) throw new ChatRefused('Conversation refused');
  return access.mode;
}

async function projectedAccess(
  options: ChatOptions, memberId: string, conversationId: string,
  relation: 'read' | 'post', receipts: string[], allowApplying: boolean,
) {
  const auth = memberAuthorisation(options.binding);
  let applied = true;
  for (const receipt of receipts) {
    if (!await auth.applied(receipt)) applied = false;
  }
  if (!applied && !allowApplying) throw new ChatRefused('Conversation applying');
  // Status reads work between append and tuple projection. Exact stream participation
  // and current silo membership still gate that read; no content is disclosed here.
  if (!applied) return;
  const permission = await auth.conversation(memberId, conversationId, relation);
  if (permission.status === 'unavailable') throw new Error('IAM unavailable');
  if (!permission.allowed) throw new ChatRefused('Conversation refused');
}

export function isChatRefused(error: unknown) {
  if (error instanceof ChatRefused || error instanceof GroupRefused) return true;
  return error instanceof Error && error.message === 'Authority changed';
}
