import { z } from 'zod';
import {
  authorityFence, AuthorityApplying, groupMembership, payingGroupAuthority,
} from '@opencrane/models';
import type { EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { activeMember, readActiveMember, GroupRefused } from '../members/groups.ts';

type SessionAuthorityOptions = { silo: string; store: EventStore; binding: Binding };
const sessionSchema = z.object({
  assistantId: z.string(), createdBy: z.string(), payingGroupId: z.string().optional(),
});
const assistantSchema = z.object({
  kind: z.enum(['personal', 'team']), ownerId: z.string(),
  payingGroupId: z.string().optional(),
});

// Read only the creation event. Later messages cannot change the session's owner or payer.
export async function creationEvent(store: Pick<EventStore, 'readStream'>, silo: string,
  subject: string, type: string, deadline = Infinity) {
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo || row.event.type !== type) {
      throw new Error('Creation history unavailable');
    }
    return row.event;
  }
  throw new Error('Creation history unavailable');
}

export async function privateSessionAuthority(options: SessionAuthorityOptions,
  memberId: string, conversationId: string,
  fresh?: Awaited<ReturnType<typeof authorityFence>>) {
  const event = await creationEvent(options.store, options.silo,
    `conversation-${conversationId}`, 'conversation.created', fresh?.deadline);
  const created = sessionSchema.parse(event.data);
  const assistantEvent = await creationEvent(options.store, options.silo,
    `assistant-${created.assistantId}`, 'assistant.created', fresh?.deadline);
  const assistant = assistantSchema.parse(assistantEvent.data);
  if (assistant.kind === 'team') {
    if (created.createdBy !== memberId) {
      throw new GroupRefused('Private session belongs to another requester');
    }
    if (fresh) {
      if (!created.payingGroupId) throw new GroupRefused('Paying group required');
      await sharedAssistantAuthority(options, memberId, created.assistantId,
        created.payingGroupId, fresh);
    } else {
      await sharedAssistantRead(options, memberId, created.assistantId, assistantEvent);
    }
  }
  await fresh?.();
}

export async function sharedAssistantRead(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, event?: Awaited<ReturnType<typeof creationEvent>>) {
  const created = event ?? await creationEvent(options.store, options.silo,
    `assistant-${assistantId}`, 'assistant.created');
  const assistant = assistantSchema.parse(created.data);
  await readActiveMember(options.store, options.binding, memberId);
  await groupMembership(options.store, options.silo, memberId, assistant.ownerId, options.binding);
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(created.id)) {
    throw new AuthorityApplying('Assistant is still being applied');
  }
  if (!(await auth.actsFor(memberId, assistantId)).allowed) {
    throw new GroupRefused('Assistant authority unavailable');
  }
}

export async function sharedAssistantAuthority(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, payingGroupId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  fresh.include(`member-${memberId}`, `assistant-${assistantId}`);
  await activeMember(options.store, options.binding, memberId, false, fresh);
  const event = await creationEvent(options.store, options.silo,
    `assistant-${assistantId}`, 'assistant.created', fresh.deadline);
  const assistant = assistantSchema.parse(event.data);
  fresh.include(`team-${assistant.ownerId}`, `team-${payingGroupId}`);
  for (const groupId of new Set([assistant.ownerId, payingGroupId])) {
    const group = await payingGroupAuthority(options.store, options.silo, memberId,
      groupId, options.binding, fresh.deadline);
    await group();
  }
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(event.id)) {
    throw new AuthorityApplying('Assistant is still being applied');
  }
  if (!(await auth.actsFor(memberId, assistantId)).allowed) {
    throw new GroupRefused('Assistant authority unavailable');
  }
  await fresh();
}
