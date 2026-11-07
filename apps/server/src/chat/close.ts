import { z } from 'zod';
import { memberAuthorisation } from '@opencrane/authz';
import { readEventAt } from '@opencrane/event-store';
import { getEventDefinition } from '@opencrane/events';
import { ChatRefused, writeChatAccess, type ChatOptions } from './access.ts';
import { ChatConflict } from './commands.ts';
import { readChatCommandFacts } from './chat-summary.ts';
import { chatChange } from './reads.ts';
import { privateSessionCreation, requirePrivateReader } from './private-session.ts';

const closeInput = z.object({ id: z.string().min(1) }).strict();
const closeData = z.object({ conversationId: z.string(), closedBy: z.string() }).strict();

function savedCloseMatches(row: NonNullable<Awaited<ReturnType<typeof readEventAt>>>,
  commandId: string, options: ChatOptions, memberId: string, conversationId: string) {
  const event = row.event;
  const data = closeData.safeParse(event.data);
  return event.id === commandId && event.commandId === commandId &&
    event.type === 'conversation.closed' && event.silo === options.silo &&
    event.subject === `conversation-${conversationId}` &&
    event.principal?.kind === 'human' && event.principal.id === memberId &&
    data.success && data.data.conversationId === conversationId &&
    data.data.closedBy === memberId;
}

async function closeAccess(options: ChatOptions, memberId: string, conversationId: string) {
  const fresh = await writeChatAccess(options, { memberId, conversationId });
  if (fresh.mode === 'group' || fresh.contextKind === 'shared_child') {
    if (fresh.createdBy !== memberId) throw new ChatRefused('Creator required');
    const auth = memberAuthorisation(options.binding);
    const permission = await auth.conversation(memberId, conversationId, 'manage_participants');
    if (permission.status === 'unavailable') throw new Error('IAM unavailable');
    if (!permission.allowed) throw new ChatRefused('Creator required');
  } else if (fresh.mode === 'agent_session') {
    if (fresh.createdBy !== memberId) throw new ChatRefused('Requester required');
    const session = await privateSessionCreation(options, conversationId);
    fresh.include(`assistant-${session.created.assistantId}`);
    if (session.assistant.kind === 'team') {
      fresh.include(`team-${session.assistant.ownerId}`);
      await requirePrivateReader(options, memberId, session);
    }
  } else if (fresh.mode === 'direct') {
    if (!fresh.participantIds.includes(memberId)) throw new ChatRefused('Participant required');
  } else {
    throw new ChatRefused('Conversation refused');
  }
  await fresh();
  return fresh.deadline;
}

export async function closeCommand(options: ChatOptions, memberId: string,
  conversationId: string, value: unknown) {
  const input = closeInput.parse(value);
  const subject = `conversation-${conversationId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Load content before the short check of streams that grant access.
    const facts = await readChatCommandFacts(options.store, options.silo, conversationId, input.id);
    let saved;
    if (facts.position !== undefined) {
      saved = await readEventAt(options.store, subject, facts.position,
        performance.now() + 10_000);
      if (!saved || !savedCloseMatches(saved, input.id, options, memberId, conversationId)) {
        throw new ChatConflict('Close id reused');
      }
    }
    const deadline = await closeAccess(options, memberId, conversationId);
    if (saved) return { status: 'appended' as const, sequence: saved.sequence };
    if (facts.firstClose) {
      return { status: 'appended' as const, sequence: facts.firstClose.sequence };
    }
    if (facts.closed) throw new ChatConflict('Conversation already closed');
    if (!facts.created) throw new ChatRefused('Conversation refused');
    const data = { conversationId, closedBy: memberId };
    getEventDefinition('conversation.closed')!.dataSchema.parse(data);
    const event = { id: input.id, commandId: input.id, type: 'conversation.closed',
      subject, silo: options.silo, source: 'opencrane-server',
      time: new Date().toISOString(), principal: { kind: 'human' as const, id: memberId },
      data };
    const command = { expectedSequence: facts.sequence, historyChecked: true as const,
      deadline, event };
    const result = await options.store.append(command);
    if (result.status === 'conflict') continue;
    if (result.status !== 'appended') return result;
    const previous = await readEventAt(options.store, subject, result.sequence,
      performance.now() + 10_000);
    if (!previous || !savedCloseMatches(previous, input.id, options, memberId, conversationId)) {
      throw new ChatConflict('Close id reused');
    }
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  throw new ChatConflict('Conversation changed; retry close');
}

export async function closeChange(options: ChatOptions, memberId: string,
  conversationId: string, commandId: string, historyPosition: number) {
  const facts = await readChatCommandFacts(options.store, options.silo, conversationId, commandId);
  if (facts.position === undefined || facts.position < historyPosition) return undefined;
  const row = await readEventAt(options.store, `conversation-${conversationId}`,
    facts.position, performance.now() + 10_000);
  if (!row || !savedCloseMatches(row, commandId, options, memberId, conversationId)) {
    return undefined;
  }
  let content: 'current' | 'applying' = 'applying';
  try {
    const projected = await chatChange(options, conversationId, commandId, historyPosition);
    if (projected.status === 'appended' && projected.type === 'conversation.closed' &&
        projected.sequence === row.sequence) {
      content = 'current';
    }
  } catch {
    // Keep the saved receipt available while the read table is unavailable.
  }
  return { status: 'appended' as const, conversationId, commandId,
    type: 'conversation.closed', sequence: row.sequence,
    projection: { content, iam: 'current' as const } };
}
