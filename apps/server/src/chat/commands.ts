import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { getEventDefinition } from '@opencrane/events';
import type { conversationKeys } from './keys.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
export const chatInput = z.union([
  z.object({ id, conversationId: id, assistantId: id, mode: z.enum(['agent_session', 'direct', 'group']).default('agent_session') }).strict(),
  z.object({ id, conversationId: id, text: z.string().trim().min(1).max(32_000) }).strict(),
  z.object({ id, conversationId: id, stopTurnId: id }).strict(),
]);
type Input = z.infer<typeof chatInput>;
type Context = { silo: string; memberId: string };
function verifyRetry(previous: StoredEvent, input: Input, context: Context, keys: ReturnType<typeof conversationKeys>) {
  const data = z.record(z.string(), z.unknown()).parse(previous.event.data);
  if ('stopTurnId' in input) {
    if (previous.event.type !== 'agent.turn_stop_requested' || data['turnId'] !== input.stopTurnId || previous.event.principal?.id !== context.memberId) throw new Error('Id reused');
    return;
  }
  const create = 'assistantId' in input;
  if (previous.event.type !== (create ? 'conversation.created' : 'message.posted') || previous.event.principal?.id !== context.memberId ||
    (create ? data['assistantId'] !== input.assistantId || data['mode'] !== input.mode : keys.decrypt(context.silo, input.conversationId, data) !== input.text)) throw new Error('Id reused');
}
type Store = Pick<EventStore, 'readStream' | 'append'>;
export async function chatHistory(store: Pick<EventStore, 'readStream'>, silo: string, conversation: string) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`conversation-${conversation}`, 1, performance.now() + 10_000)) {
    if (row.event.silo !== silo) throw new Error('Conversation silo mismatch');
    rows.push(row);
  }
  return rows;
}

/** Authorisation and key provisioning precede this command; its only write is one conditional append. */
export async function chatCommand(store: Store, keys: ReturnType<typeof conversationKeys>, context: { silo: string; memberId: string }, value: z.input<typeof chatInput>) {
  const input = chatInput.parse(value);
  if ('assistantId' in input && input.mode !== 'agent_session') throw new Error('Phase 2 supports only agent_session conversations');
  const rows = await chatHistory(store, context.silo, input.conversationId);
  const create = 'assistantId' in input, type = create ? 'conversation.created' : 'stopTurnId' in input ? 'agent.turn_stop_requested' : 'message.posted';
  const previous = rows.find(r => r.event.id === input.id);
  if (previous) {
    verifyRetry(previous, input, context, keys);
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  if (create ? rows.length : !rows.length || rows.some(r => r.event.type === 'conversation.closed')) throw new Error('Conversation state conflict');
  if ('stopTurnId' in input && !rows.some(r => r.event.id === input.stopTurnId && r.event.type === 'message.posted' && r.event.principal?.id === context.memberId)) throw new Error('Unrequested turn');
  const data = commandData(input, context, keys);
  getEventDefinition(type)!.dataSchema.parse(data);
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
    id: input.id, commandId: input.id, type, subject: `conversation-${input.conversationId}`, silo: context.silo,
    source: 'opencrane-server', time: new Date().toISOString(), principal: { kind: 'human', id: context.memberId }, data,
  } });
  if (result.status !== 'appended') return result;
  // The adapter may have recognised a concurrent retry; verify its committed payload too.
  const saved = (await chatHistory(store, context.silo, input.conversationId)).find(r => r.event.id === input.id);
  if (!saved) throw new Error('Append outcome unavailable');
  verifyRetry(saved, input, context, keys);
  return result;
}

function commandData(input: Input, context: Context, keys: ReturnType<typeof conversationKeys>) {
  return 'assistantId' in input ? { conversationId: input.conversationId, assistantId: input.assistantId, createdBy: context.memberId, mode: input.mode }
    : 'stopTurnId' in input ? { conversationId: input.conversationId, turnId: input.stopTurnId, requestedBy: context.memberId }
    : { conversationId: input.conversationId, authorId: context.memberId, authorKind: 'human', contentType: 'text', ...keys.encrypt(context.silo, input.conversationId, input.text) };
}
