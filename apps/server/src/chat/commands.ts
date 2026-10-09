import { z } from 'zod';
import { readStreamSummary, readEventAt, type SummaryKind,
  type EventStore, type StoredEvent } from '@opencrane/event-store';
import { chatIdSchema, groupConversationCommandSchema,
  conversationCreatedDataSchema, getEventDefinition } from '@opencrane/events';
import type { conversationKeys } from './keys.ts';

const id = chatIdSchema;
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
  z.object({ id, conversationId, mode: z.literal('group'),
    participantIds: z.array(id).min(2).max(97), groupId: id.optional(),
    groupSnapshotPosition: z.int().nonnegative().optional() }).strict(),
  z.object({ id, conversationId, text: z.string().trim().min(1).max(32_000),
    executionMode: z.literal('memory_free').optional() }).strict(),
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
  verifyCommandIdentity(previous, input, context);
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
  } else if ('participantIds' in input) {
    matches = sameGroupCreation(data, input, context.memberId);
  } else if ('stopTurnId' in input) {
    matches = data['turnId'] === input.stopTurnId;
  } else {
    matches = keys.decrypt(context.silo, input.conversationId, data) === input.text
      && data['executionMode'] === input.executionMode;
  }
  if (!matches) throw new ChatConflict('Id reused');
}

function verifyCommandIdentity(previous: StoredEvent, input: Input, context: Context) {
  const event = previous.event;
  if (event.id !== input.id || event.type !== commandType(input) ||
      event.silo !== context.silo || event.subject !== `conversation-${input.conversationId}` ||
      event.principal?.kind !== 'human' || event.principal.id !== context.memberId) {
    throw new ChatConflict('Id reused');
  }
}

function sameGroupCreation(data: unknown,
  input: Extract<Input, { participantIds: string[] }>, memberId: string) {
  const created = conversationCreatedDataSchema.parse(data);
  if (created.mode !== 'group') return false;
  const ids = [...input.participantIds].sort();
  const savedIds = [...created.participantIds].sort();
  return created.createdBy === memberId && created.groupId === input.groupId &&
    created.groupSnapshotPosition === input.groupSnapshotPosition &&
    JSON.stringify(savedIds) === JSON.stringify(ids);
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

type Commands = { created?: StoredEvent; closed: boolean; positions: Map<string, number> };
function emptyCommands(): Commands {
  return { closed: false, positions: new Map() };
}
function addCommand(summary: Commands, row: StoredEvent) {
  if (row.event.type === 'conversation.created') summary.created = row;
  if (row.event.type === 'conversation.closed') summary.closed = true;
  if (!summary.positions.has(row.event.id)) summary.positions.set(row.event.id, row.sequence);
}
function commandSize(summary: Commands) {
  return summary.positions.size * 256;
}
const commands: SummaryKind<Commands> = {
  name: 'chat-commands', keep: 64, empty: emptyCommands, add: addCommand,
  budget: { limit: 16 * 1024 * 1024, size: commandSize },
};

/** Load command facts before the short access check, then append one event. */
export async function chatCommand(
  store: Store, keys: ReturnType<typeof conversationKeys>, context: Context,
  value: unknown, fresh?: (operation: 'retry' | 'append') => Promise<number>,
) {
  const input = chatInput.parse(value);
  const subject = `conversation-${input.conversationId}`;
  function take(summary: Commands, sequence: number) {
    return { created: summary.created, closed: summary.closed,
      position: summary.positions.get(input.id), sequence };
  }
  const facts = await readStreamSummary(store, context.silo, subject, commands,
    performance.now() + 10_000, take);
  if (facts.position !== undefined) {
    const previous = await readEventAt(store, subject, facts.position, performance.now() + 10_000);
    if (!previous) throw new Error('Saved command unavailable');
    verifyRetry(previous, input, context, keys);
    await fresh?.('retry');
    return { status: 'appended' as const, sequence: previous.sequence };
  }
  validateConversation(facts, input, context.memberId);
  if ('stopTurnId' in input) {
    const turnFacts = await readStreamSummary(store, context.silo, subject, commands,
      performance.now() + 10_000, takeTurn);
    const turn = await readEventAt(store, subject, turnFacts ?? 0, performance.now() + 10_000);
    if (!turn || turn.event.type !== 'message.posted' ||
        turn.event.principal?.id !== context.memberId) throw new ChatConflict('Unrequested turn');
  }
  function takeTurn(summary: Commands) {
    if ('stopTurnId' in input) return summary.positions.get(input.stopTurnId);
    return undefined;
  }
  const type = commandType(input);
  const data = commandData(input, context, keys);
  getEventDefinition(type)!.dataSchema.parse(data);
  const event = {
    id: input.id, commandId: input.id, type, subject,
    silo: context.silo, source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: context.memberId }, data,
  };
  const deadline = await fresh?.('append');
  const command = { expectedSequence: facts.sequence, historyChecked: true as const,
    event, ...(deadline === undefined ? {} : { deadline }) };
  const result = await store.append(command);
  if (result.status !== 'appended') return result;
  // Verify the saved payload because the adapter may have found a concurrent retry.
  const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
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
  if ('participantIds' in input) {
    const data = { ...input, createdBy: context.memberId };
    const { id: _id, ...created } = data;
    return groupConversationCommandSchema.parse(created);
  }
  if ('stopTurnId' in input) {
    return { conversationId, turnId: input.stopTurnId, requestedBy: context.memberId };
  }
  const encrypted = keys.encrypt(context.silo, conversationId, input.text);
  const data = {
    conversationId, authorId: context.memberId, authorKind: 'human', contentType: 'text', ...encrypted,
  };
  if (input.executionMode) return { ...data, executionMode: input.executionMode };
  return data;
}

function validateConversation(facts: { created: StoredEvent | undefined; closed: boolean;
  position: number | undefined; sequence: number }, input: Input, memberId: string) {
  if ('mode' in input) {
    if (facts.sequence) throw new ChatConflict('Conversation state conflict');
    return;
  }
  if (!facts.created || facts.closed) throw new ChatConflict('Conversation state conflict');
  const created = conversationCreatedDataSchema.parse(facts.created.event.data);
  if (created.mode !== 'agent_session') {
    if ('stopTurnId' in input || input.executionMode !== undefined) {
      throw new ChatConflict('Human conversation refused');
    }
    if (created.mode === 'direct' && !created.participantIds.includes(memberId)) {
      throw new ChatConflict('Direct conversation refused');
    }
  }
}
