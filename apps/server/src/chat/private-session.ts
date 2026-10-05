import { z } from 'zod';
import {
  authorityFence, AuthorityApplying, groupMembership,
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
  subject: string, type: string, deadline = performance.now() + 10_000) {
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo || row.event.type !== type) {
      throw new Error('Creation history unavailable');
    }
    return row.event;
  }
  throw new Error('Creation history unavailable');
}

// Keep saved conversations readable after the member loses permission to spend.
export async function readPrivateSession(options: SessionAuthorityOptions,
  memberId: string, conversationId: string) {
  const read = privateSessionReader(options, memberId);
  await read(conversationId);
}

export function privateSessionReader(options: SessionAuthorityOptions, memberId: string) {
  const assistants = new Map<string, ReturnType<typeof creationEvent>>();
  const permissions = new Map<string, Promise<void>>();
  async function read(conversationId: string) {
    const event = await creationEvent(options.store, options.silo,
      `conversation-${conversationId}`, 'conversation.created');
    const created = sessionSchema.parse(event.data);
    let assistantRead = assistants.get(created.assistantId);
    if (!assistantRead) {
      assistantRead = creationEvent(options.store, options.silo,
        `assistant-${created.assistantId}`, 'assistant.created');
      assistants.set(created.assistantId, assistantRead);
    }
    const assistantEvent = await assistantRead;
    const assistant = assistantSchema.parse(assistantEvent.data);
    if (assistant.kind !== 'team') return;
    if (created.createdBy !== memberId) {
      throw new GroupRefused('Private session belongs to another requester');
    }
    let permission = permissions.get(created.assistantId);
    if (!permission) {
      permission = sharedAssistantRead(options, memberId, created.assistantId, assistantEvent);
      permissions.set(created.assistantId, permission);
    }
    await permission;
  }
  return read;
}

async function privateSessionCreation(options: SessionAuthorityOptions,
  conversationId: string) {
  const event = await creationEvent(options.store, options.silo,
    `conversation-${conversationId}`, 'conversation.created');
  const created = sessionSchema.parse(event.data);
  const assistantEvent = await creationEvent(options.store, options.silo,
    `assistant-${created.assistantId}`, 'assistant.created');
  const assistant = assistantSchema.parse(assistantEvent.data);
  return { created, assistantEvent, assistant };
}

type PrivateSession = Awaited<ReturnType<typeof privateSessionCreation>>;

async function requirePrivateReader(options: SessionAuthorityOptions,
  memberId: string, session: PrivateSession) {
  if (session.assistant.kind !== 'team') return;
  if (session.created.createdBy !== memberId) {
    throw new GroupRefused('Private session belongs to another requester');
  }
  await sharedAssistantRead(options, memberId, session.created.assistantId, session.assistantEvent);
}

// Recheck only team access before writing. Stopping a turn does not spend money.
export async function writePrivateSession(options: SessionAuthorityOptions,
  memberId: string, conversationId: string, stopping: boolean) {
  const session = await privateSessionCreation(options, conversationId);
  if (session.assistant.kind !== 'team') return;
  if (session.created.createdBy !== memberId) {
    throw new GroupRefused('Private session belongs to another requester');
  }
  const subjects = [`member-${memberId}`, `assistant-${session.created.assistantId}`,
    `team-${session.assistant.ownerId}`];
  const fresh = await authorityFence(options.store, performance.now(), subjects);
  if (stopping) {
    await readActiveMember(options.store, options.binding, memberId);
    await requirePrivateReader(options, memberId, session);
  } else {
    const payer = session.created.payingGroupId;
    if (!payer || payer !== session.assistant.payingGroupId) {
      throw new GroupRefused('Paying group must match the assistant');
    }
    await sharedAssistantAuthority(options, memberId, session.created.assistantId, payer, fresh);
  }
  await fresh();
  return fresh;
}

export async function sharedAssistantRead(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, event?: Awaited<ReturnType<typeof creationEvent>>) {
  const created = event ?? await creationEvent(options.store, options.silo,
    `assistant-${assistantId}`, 'assistant.created');
  const assistant = assistantSchema.parse(created.data);
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
  const memberAuthority = { requiredRole: 'member' as const, fresh };
  await activeMember(options.store, options.binding, memberId, memberAuthority);
  const event = await creationEvent(options.store, options.silo,
    `assistant-${assistantId}`, 'assistant.created', fresh.deadline);
  const assistant = assistantSchema.parse(event.data);
  fresh.include(`team-${assistant.ownerId}`, `team-${payingGroupId}`);
  for (const groupId of new Set([assistant.ownerId, payingGroupId])) {
    await groupMembership(options.store, options.silo, memberId,
      groupId, options.binding, fresh.deadline);
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
