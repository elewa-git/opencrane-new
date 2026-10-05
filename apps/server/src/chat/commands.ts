import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { conversationCreatedDataSchema, getEventDefinition } from '@opencrane/events';
import type { conversationKeys } from './keys.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
function isUserConversation(conversationId: string) {
  return !conversationId.startsWith('provider-');
}
// Verification uses this prefix to keep model audit separate from user conversations.
const conversationId = id.refine(isUserConversation, 'Reserved conversation prefix');
export const chatInput = z.union([
  z.object({
    id, conversationId, assistantId: id,
    mode: z.literal('agent_session').default('agent_session'), payingGroupId: id.optional(),
  }).strict(),
  z.object({ id, conversationId, mode: z.literal('direct'), colleagueId: id }).strict(),
  z.object({ id, conversationId, text: z.string().trim().min(1).max(32_000) }).strict(),
  z.object({ id, conversationId, stopTurnId: id }).strict(),
]);
type Input = z.infer<typeof chatInput>;
type Context = { silo: string; memberId: string };
export class ChatConflict extends Error {}

type Store = Pick<EventStore, 'readStream' | 'append'>;

function commandType(input: Input) {
  if ('mode' in input) return 'conversation.created';
  if ('stopTurnId' in input) return 'agent.turn_stop_requested';
  return 'message.posted';
}

function verifyRetry(
  previous: StoredEvent, input: Input, context: Context,
  keys: ReturnType<typeof conversationKeys>,
) {
  if (previous.event.type !== commandType(input) ||
      previous.event.principal?.id !== context.memberId) throw new ChatConflict('Id reused');
  const data = z.record(z.string(), z.unknown()).parse(previous.event.data);
  let matches: boolean;
  if ('assistantId' in input) {
    matches = data['assistantId'] === input.assistantId &&
      (data['mode'] ?? 'agent_session') === input.mode &&
      data['payingGroupId'] === input.payingGroupId;
  } else if ('colleagueId' in input) {
    const created = conversationCreatedDataSchema.parse(data);
    matches = created.mode === 'direct' && created.createdBy === context.memberId &&
      input.colleagueId !== context.memberId && created.participantIds.includes(input.colleagueId);
  } else if ('stopTurnId' in input) {
    matches = data['turnId'] === input.stopTurnId;
  } else {
    matches = keys.decrypt(context.silo, input.conversationId, data) === input.text;
  }
  if (!matches) throw new ChatConflict('Id reused');
}

export async function chatHistory(
  store: Pick<EventStore, 'readStream'>, silo: string, conversation: string,
  deadline = performance.now() + 10_000,
) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`conversation-${conversation}`, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Conversation silo mismatch');
    rows.push(row);
  }
  return rows;
}

/** Append one event after access is checked and a conversation key is available. */
export async function chatCommand(
  store: Store, keys: ReturnType<typeof conversationKeys>, context: Context,
  value: unknown, fresh?: (operation: 'retry' | 'append') => Promise<void>,
) {
  const input = chatInput.parse(value);
  const rows = await chatHistory(store, context.silo, input.conversationId);
  function hasCommandId(row: StoredEvent) {
    return row.event.id === input.id;
  }
  const previous = rows.find(hasCommandId);
  if (previous) {
    verifyRetry(previous, input, context, keys);
    await fresh?.('retry');
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  validateConversation(rows, input, context.memberId);
  const type = commandType(input);
  const data = commandData(input, context, keys);
  getEventDefinition(type)!.dataSchema.parse(data);
  const event = {
    id: input.id, commandId: input.id, type, subject: `conversation-${input.conversationId}`,
    silo: context.silo, source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: context.memberId }, data,
  };
  await fresh?.('append');
  const expectedSequence = rows.at(-1)?.sequence ?? 0;
  const result = await store.append({ expectedSequence, event });
  if (result.status !== 'appended') return result;
  // Verify the saved payload, because the adapter may have found a concurrent retry.
  const committed = await chatHistory(store, context.silo, input.conversationId);
  const saved = committed.find(hasCommandId);
  if (!saved) throw new Error('Append outcome unavailable');
  verifyRetry(saved, input, context, keys);
  return { status: 'appended' as const, sequence: saved.sequence };
}

function commandData(input: Input, context: Context, keys: ReturnType<typeof conversationKeys>) {
  const conversationId = input.conversationId;
  if ('assistantId' in input) {
    const data = {
      conversationId, assistantId: input.assistantId, createdBy: context.memberId, mode: input.mode,
    };
    if (input.payingGroupId) return { ...data, payingGroupId: input.payingGroupId };
    return data;
  }
  if ('colleagueId' in input) {
    return {
      conversationId, createdBy: context.memberId, mode: input.mode,
      participantIds: [context.memberId, input.colleagueId],
    };
  }
  if ('stopTurnId' in input) {
    return { conversationId, turnId: input.stopTurnId, requestedBy: context.memberId };
  }
  const encrypted = keys.encrypt(context.silo, conversationId, input.text);
  return {
    conversationId, authorId: context.memberId, authorKind: 'human', contentType: 'text', ...encrypted,
  };
}

function validateConversation(rows: StoredEvent[], input: Input, memberId: string) {
  if ('mode' in input) {
    if (rows.length) throw new ChatConflict('Conversation state conflict');
    return;
  }
  function isClosed(row: StoredEvent) {
    return row.event.type === 'conversation.closed';
  }
  function isCreated(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  if (!rows.length || rows.some(isClosed)) throw new ChatConflict('Conversation state conflict');
  const created = conversationCreatedDataSchema.parse(rows.find(isCreated)?.event.data);
  if (created.mode === 'direct') {
    if (!created.participantIds.includes(memberId) || 'stopTurnId' in input) {
      throw new ChatConflict('Direct conversation refused');
    }
  }
  if ('stopTurnId' in input) {
    const stopTurnId = input.stopTurnId;
    function isRequestedTurn(row: StoredEvent) {
      return row.event.id === stopTurnId && row.event.type === 'message.posted' &&
        row.event.principal?.id === memberId;
    }
    if (!rows.some(isRequestedTurn)) throw new ChatConflict('Unrequested turn');
  }
}
