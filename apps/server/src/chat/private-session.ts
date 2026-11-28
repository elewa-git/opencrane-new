import { sessionAssistantSchema, sessionConfiguration } from '@opencrane/events';
import { z } from 'zod';
import {
  authorityFence, AuthorityApplying, groupMembership,
} from '@opencrane/models';
import { readFirstEvent, type EventStore } from '@opencrane/event-store';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { readActiveMember, GroupRefused } from '../members/groups.ts';

type SessionAuthorityOptions = { silo: string; store: EventStore; binding: Binding };
const sessionSchema = z.object({
  assistantId: z.string(), createdBy: z.string(), payingGroupId: z.string().optional(),
});
// Read only the creation event. Later messages cannot change the session's owner or payer.
export async function creationEvent(store: Pick<EventStore, 'readStream'>, silo: string,
  subject: string, type: string, deadline = performance.now() + 10_000) {
  const request = { silo, subject, type, deadline };
  const row = await readFirstEvent(store, request);
  return row.event;
}

// Keep saved conversations readable after the member loses permission to spend.
export async function readPrivateSession(options: SessionAuthorityOptions,
  memberId: string, conversationId: string, creation: Awaited<ReturnType<typeof creationEvent>>,
  deadline: number) {
  const session = await privateSessionCreation(options, conversationId, creation, deadline);
  await requirePrivateReader(options, memberId, session, deadline);
}

export function privateSessionReader(options: SessionAuthorityOptions, memberId: string) {
  const assistants = new Map<string, ReturnType<typeof creationEvent>>();
  const permissions = new Map<string, Promise<void>>();
  async function read(conversationId: string,
    creation?: Awaited<ReturnType<typeof creationEvent>>) {
    const event = creation ?? await creationEvent(options.store, options.silo,
      `conversation-${conversationId}`, 'conversation.created');
    const created = sessionSchema.parse(event.data);
    let assistantRead = assistants.get(created.assistantId);
    if (!assistantRead) {
      assistantRead = creationEvent(options.store, options.silo,
        `assistant-${created.assistantId}`, 'assistant.created');
      assistants.set(created.assistantId, assistantRead);
    }
    const assistantEvent = await assistantRead;
    const assistant = sessionAssistantSchema.parse(assistantEvent.data);
    if (assistant.kind !== 'team') {
      return;
    }
    requirePrivateRequester(memberId, created.createdBy);
    let permission = permissions.get(created.assistantId);
    if (!permission) {
      permission = sharedAssistantRead(options, memberId, created.assistantId, assistantEvent);
      permissions.set(created.assistantId, permission);
    }
    await permission;
  }
  return read;
}

export async function privateSessionCreation(options: SessionAuthorityOptions,
  conversationId: string, creation?: Awaited<ReturnType<typeof creationEvent>>, deadline?: number) {
  const event = creation ?? await creationEvent(options.store, options.silo,
    `conversation-${conversationId}`, 'conversation.created', deadline);
  const created = sessionSchema.parse(event.data);
  const assistantEvent = await creationEvent(options.store, options.silo,
    `assistant-${created.assistantId}`, 'assistant.created', deadline);
  const assistant = sessionAssistantSchema.parse(assistantEvent.data);
  return { created, assistantEvent, assistant };
}

type PrivateSession = Awaited<ReturnType<typeof privateSessionCreation>>;

function requirePrivateRequester(memberId: string, requesterId: string) {
  if (requesterId !== memberId) {
    throw new GroupRefused('Private session belongs to another requester');
  }
}

export async function requirePrivateReader(options: SessionAuthorityOptions,
  memberId: string, session: PrivateSession, deadline?: number) {
  if (session.assistant.kind !== 'team') {
    return;
  }
  requirePrivateRequester(memberId, session.created.createdBy);
  await sharedAssistantRead(options, memberId, session.created.assistantId, session.assistantEvent,
    deadline);
}

// Recheck only team access before writing. Stopping a turn does not spend money.
export async function writePrivateSession(options: SessionAuthorityOptions,
  memberId: string, conversationId: string, stopping: boolean) {
  const session = await privateSessionCreation(options, conversationId);
  if (session.assistant.kind !== 'team') {
    return;
  }
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
    const sessionInput = { conversation: session.created,
      assistantKind: session.assistant.kind,
      assistantPayingGroupId: session.assistant.payingGroupId, memoryEnabled: false };
    const configuration = sessionConfiguration(sessionInput);
    if (!payer || !configuration.payerMatchesAssistant) {
      throw new GroupRefused('Paying group must match the assistant');
    }
    await sharedAssistantAuthority(options, memberId, session.created.assistantId, payer, fresh);
  }
  await fresh();
  return fresh;
}

export async function sharedAssistantRead(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, event?: Awaited<ReturnType<typeof creationEvent>>, deadline?: number) {
  const { store, silo, binding } = options;
  const created = event ?? await creationEvent(store, silo,
    `assistant-${assistantId}`, 'assistant.created', deadline);
  const assistant = sessionAssistantSchema.parse(created.data);
  const auth = memberAuthorisation(binding);
  const teamSubject = `team-${assistant.ownerId}`;
  const position = await store.head(teamSubject, deadline);
  const membership = groupMembership(store, silo, memberId, assistant.ownerId, binding, deadline);
  const receiptCheck = auth.checkApplied(created.id);
  const permissionCheck = auth.actsFor(memberId, assistantId);
  const checks = [membership, receiptCheck, permissionCheck] as const;
  const [, receipt, permission] = await Promise.all(checks);
  if (receipt.status === 'unavailable') {
    throw receipt.error;
  }
  if (permission.status === 'unavailable') {
    throw permission.error;
  }
  if (!receipt.allowed) {
    throw new AuthorityApplying('Assistant is still being applied');
  }
  if (!permission.allowed) {
    throw new GroupRefused('Assistant authority unavailable');
  }
  // Check the saved membership again if it changed while OpenFGA was replying.
  if (await store.head(teamSubject, deadline) !== position) {
    await groupMembership(store, silo, memberId, assistant.ownerId, binding, deadline);
  }
}

export async function sharedAssistantAuthority(options: SessionAuthorityOptions, memberId: string,
  assistantId: string, payingGroupId: string,
  fresh: Awaited<ReturnType<typeof authorityFence>>) {
  fresh.include(`member-${memberId}`, `assistant-${assistantId}`);
  const event = await creationEvent(options.store, options.silo,
    `assistant-${assistantId}`, 'assistant.created', fresh.deadline);
  const assistant = sessionAssistantSchema.parse(event.data);
  fresh.include(`team-${assistant.ownerId}`, `team-${payingGroupId}`);
  // Check active membership and its receipts with each group; ownership is not required.
  for (const groupId of new Set([assistant.ownerId, payingGroupId])) {
    await groupMembership(options.store, options.silo, memberId,
      groupId, options.binding, fresh.deadline);
  }
  const auth = memberAuthorisation(options.binding);
  if (!await auth.applied(event.id)) {
    throw new AuthorityApplying('Assistant is still being applied');
  }
  const permission = await auth.actsFor(memberId, assistantId);
  if (permission.status === 'unavailable') {
    throw permission.error;
  }
  if (!permission.allowed) {
    throw new GroupRefused('Assistant authority unavailable');
  }
  await fresh();
}
