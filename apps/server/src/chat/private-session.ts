import { z } from 'zod';
import { authorityFence, history, payingGroupAuthority } from '@opencrane/models';
import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { activeMember, GroupRefused } from '../members/groups.ts';

type SessionAuthorityOptions = { silo: string; store: EventStore; binding: Binding };

/** Private execution is requester-owned even if a participant tuple was added by mistake. */
export async function privateSessionAuthority(options: SessionAuthorityOptions,
  memberId: string, conversationId: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>) {
  const subjects = [`member-${memberId}`, `conversation-${conversationId}`];
  fresh ??= await authorityFence(options.store, performance.now(), subjects);
  fresh.include(...subjects);
  const rows = await history(options.store, `conversation-${conversationId}`,
    options.silo, fresh.deadline);
  function isCreated(row: typeof rows[number]) {
    return row.event.type === 'conversation.created';
  }
  const schema = z.object({ assistantId: z.string(), createdBy: z.string(),
    payingGroupId: z.string().optional() });
  const created = schema.parse(rows.find(isCreated)?.event.data);
  const assistantSubject = `assistant-${created.assistantId}`;
  fresh.include(assistantSubject);
  const assistants = await history(options.store, assistantSubject, options.silo, fresh.deadline);
  const assistant = z.object({ kind: z.string(), ownerId: z.string() }).parse(
    assistants[0]?.event.data);
  if (assistant.kind === 'team') {
    if (created.createdBy !== memberId || !created.payingGroupId) {
      throw new GroupRefused('Private session belongs to another requester');
    }
    await sharedAssistantAuthority(options, memberId, created.assistantId,
      created.payingGroupId, fresh);
  }
  await fresh();
  return fresh;
}

export async function sharedAssistantAuthority(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, payingGroupId: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>) {
  const subjects = [`member-${memberId}`, `assistant-${assistantId}`];
  fresh ??= await authorityFence(options.store, performance.now(), subjects);
  fresh.include(...subjects);
  await activeMember(options.store, options.binding, memberId, false, fresh);
  const rows = await history(options.store, `assistant-${assistantId}`,
    options.silo, fresh.deadline);
  const assistant = z.object({ ownerId: z.string() }).parse(rows[0]?.event.data);
  fresh.include(`team-${assistant.ownerId}`, `team-${payingGroupId}`);
  for (const groupId of new Set([assistant.ownerId, payingGroupId])) {
    const group = await payingGroupAuthority(options.store, options.silo, memberId,
      groupId, options.binding, fresh.deadline);
    await group();
  }
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(rows[0]!.event.id) ||
      !(await auth.actsFor(memberId, assistantId)).allowed) {
    throw new GroupRefused('Assistant authority unavailable');
  }
  await fresh();
  return fresh;
}
