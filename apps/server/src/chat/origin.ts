import { z } from 'zod';
import { conversationCreatedDataSchema } from '@opencrane/events';
import { readEventAt } from '@opencrane/event-store';
import { chatOriginSchema } from '@opencrane/protocol';
import { ChatRefused, ChatAccessApplying, isChatRefused, conversationParticipation,
  type ChatOptions } from './access.ts';
import { summary } from './list-summary.ts';

const sourceIdentity = z.object({ conversationId: z.string() });

async function creation(options: ChatOptions, conversationId: string, deadline: number) {
  const subject = `conversation-${conversationId}`;
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== options.silo || row.event.type !== 'conversation.created') break;
    const parsed = conversationCreatedDataSchema.safeParse(row.event.data);
    if (!parsed.success || parsed.data.conversationId !== conversationId) break;
    if (!('contextKind' in parsed.data)) break;
    return parsed.data;
  }
  throw new ChatRefused('Conversation refused');
}

async function readOrigin(options: ChatOptions, memberId: string, conversationId: string) {
  // Load saved references before the short access checks. Keep all text encrypted here.
  const deadline = performance.now() + 10_000;
  const child = await creation(options, conversationId, deadline);
  const origin = child.origin;
  const subject = `conversation-${origin.parentConversationId}`;
  const source = await readEventAt(options.store, subject, origin.sourcePosition, deadline);
  await conversationParticipation(options, memberId, conversationId);
  let parent;
  try {
    parent = await conversationParticipation(options, memberId, origin.parentConversationId);
  } catch (error) {
    if (isChatRefused(error) || error instanceof ChatAccessApplying) {
      return { status: 'restricted' as const };
    }
    throw error;
  }
  const identity = sourceIdentity.safeParse(source?.event.data);
  if (!source || source.event.id !== origin.sourceMessageId ||
      source.event.type !== 'message.posted' || source.event.silo !== options.silo ||
      !identity.success || identity.data.conversationId !== origin.parentConversationId ||
      source.sequence < parent.historyPosition) {
    return { status: 'restricted' as const };
  }
  // Decrypt only the visible title after both chats and the exact source have been checked.
  const display = await summary(options, origin.parentConversationId,
    parent.created.mode, parent.historyPosition);
  return { status: 'linked' as const, parentConversationId: origin.parentConversationId,
    parentTitle: display.title, sourceMessageId: origin.sourceMessageId,
    sourcePosition: origin.sourcePosition };
}

export async function childOrigin(options: ChatOptions, memberId: string, conversationId: string) {
  try {
    const result = await readOrigin(options, memberId, conversationId);
    return chatOriginSchema.parse(result);
  } catch (error) {
    if (isChatRefused(error) || error instanceof ChatAccessApplying) throw error;
    // Keep store, database and decryption errors from naming a hidden parent in logs.
    // eslint-disable-next-line preserve-caught-error -- Do not retain hidden parent details.
    throw new Error('Origin unavailable');
  }
}
