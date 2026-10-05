import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { getEventDefinition } from '@opencrane/events';
import type { conversationKeys } from './keys.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
function isUserConversation(conversationId: string) {
  return !conversationId.startsWith('provider-');
}
// Keep model audit records separate from user conversations.
const conversationId = id.refine(isUserConversation, 'Reserved conversation prefix');
export const chatInput = z.union([
  z.object({ id, conversationId, assistantId: id,
    mode: z.enum(['agent_session', 'direct', 'group']).default('agent_session'),
    payingGroupId: id.optional() }).strict(),
  z.object({ id, conversationId, text: z.string().trim().min(1).max(32_000) }).strict(),
  z.object({ id, conversationId, stopTurnId: id }).strict(),
]);
type Input = z.infer<typeof chatInput>;
type Context = { silo: string; memberId: string };
type Keys = ReturnType<typeof conversationKeys>;
type Store = Pick<EventStore, 'readStream' | 'append'>;
type Authorise = () => Promise<(() => Promise<void>) | undefined>;

function commandType(input: Input) {
  if ('assistantId' in input) return 'conversation.created';
  if ('stopTurnId' in input) return 'agent.turn_stop_requested';
  return 'message.posted';
}

function verifyRetry(previous: StoredEvent, input: Input, context: Context, keys: Keys) {
  const data = z.record(z.string(), z.unknown()).parse(previous.event.data);
  if (previous.event.type !== commandType(input) ||
      previous.event.principal?.id !== context.memberId) {
    throw new Error('Id reused');
  }
  if ('stopTurnId' in input) {
    if (data['turnId'] !== input.stopTurnId) throw new Error('Id reused');
    return;
  }
  if ('assistantId' in input) {
    if (data['assistantId'] !== input.assistantId || data['mode'] !== input.mode ||
        data['payingGroupId'] !== input.payingGroupId) {
      throw new Error('Id reused');
    }
    return;
  }
  const text = keys.decrypt(context.silo, input.conversationId, data);
  if (text !== input.text) throw new Error('Id reused');
}

export async function chatHistory(store: Pick<EventStore, 'readStream'>,
  silo: string, conversation: string, deadline = performance.now() + 10_000) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`conversation-${conversation}`, 1, deadline)) {
    if (row.event.silo !== silo) throw new Error('Conversation silo mismatch');
    rows.push(row);
  }
  return rows;
}

// Read history before opening the team access check. Append once to one stream.
export async function chatCommand(store: Store, keys: Keys, context: Context,
  value: z.input<typeof chatInput>, authorise?: Authorise) {
  const input = chatInput.parse(value);
  if ('assistantId' in input && input.mode !== 'agent_session') {
    throw new Error('Phase 2 supports only agent_session conversations');
  }
  const rows = await chatHistory(store, context.silo, input.conversationId);
  const fresh = await authorise?.();
  function matchesId(row: StoredEvent) {
    return row.event.id === input.id;
  }
  const previous = rows.find(matchesId);
  if (previous) {
    verifyRetry(previous, input, context, keys);
    await fresh?.();
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
  await fresh?.();
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event });
  if (result.status !== 'appended') return result;
  // Verify the saved payload when the adapter recognises a concurrent retry.
  const committed = await chatHistory(store, context.silo, input.conversationId);
  const saved = committed.find(matchesId);
  if (!saved) throw new Error('Append outcome unavailable');
  verifyRetry(saved, input, context, keys);
  return result;
}

function commandData(input: Input, context: Context, keys: Keys) {
  if ('assistantId' in input) {
    const data: { conversationId: string; assistantId: string; createdBy: string;
      mode: string; payingGroupId?: string } = {
      conversationId: input.conversationId, assistantId: input.assistantId,
      createdBy: context.memberId, mode: input.mode,
    };
    if (input.payingGroupId) data.payingGroupId = input.payingGroupId;
    return data;
  }
  if ('stopTurnId' in input) {
    return { conversationId: input.conversationId, turnId: input.stopTurnId,
      requestedBy: context.memberId };
  }
  const content = keys.encrypt(context.silo, input.conversationId, input.text);
  return { conversationId: input.conversationId, authorId: context.memberId,
    authorKind: 'human', contentType: 'text', ...content };
}

function validateConversation(rows: StoredEvent[], input: Input, memberId: string) {
  function isClosed(row: StoredEvent) {
    return row.event.type === 'conversation.closed';
  }
  if ('assistantId' in input) {
    if (rows.length > 0) throw new Error('Conversation state conflict');
    return;
  }
  if (!rows.length || rows.some(isClosed)) throw new Error('Conversation state conflict');
  if ('stopTurnId' in input) {
    function isRequestedMessage(row: StoredEvent) {
      return 'stopTurnId' in input && row.event.id === input.stopTurnId &&
        row.event.type === 'message.posted' && row.event.principal?.id === memberId;
    }
    if (!rows.some(isRequestedMessage)) throw new Error('Unrequested turn');
  }
}
