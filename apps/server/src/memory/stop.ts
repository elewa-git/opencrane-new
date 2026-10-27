import type { EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { WebSocket } from 'ws';
import { readChatFacts, type ChatFacts } from '../chat/chat-summary.ts';

const identityFields = ['conversationId', 'turnId', 'requesterId', 'assistantId',
  'computerId', 'generation', 'threadId', 'inputGeneration'] as const;
type Binding = Pick<MemoryContextRecord, typeof identityFields[number]>;
type ActiveTurn = {
  silo: string;
  binding: Binding;
  socket: Pick<WebSocket, 'send' | 'readyState'>;
};
type Options = {
  silo: string;
  store: EventStore;
  // Read the current connection after history, without opening or resuming a process.
  current(binding: Binding): ActiveTurn | undefined;
  refresh?(): Promise<void>;
};

function matches(active: ActiveTurn, silo: string, saved: Binding) {
  if (active.silo !== silo || active.socket.readyState !== WebSocket.OPEN) return false;
  for (const field of identityFields) {
    if (active.binding[field] !== saved[field]) return false;
  }
  return true;
}

function confirmedBinding(chat: ChatFacts,
  candidate: ReturnType<typeof memoryContextRecordedEventSchema.parse>) {
  const context = chat.memoryContext;
  const encoded = context?.events.get(candidate.id);
  if (encoded !== JSON.stringify(candidate) || context?.status !== 'invalidated' ||
      chat.turnEnded || chat.conversationClosed) {
    return undefined;
  }
  const decoded: unknown = JSON.parse(encoded);
  const saved = memoryContextRecordedEventSchema.parse(decoded).data;
  if (chat.created?.['mode'] !== 'agent_session' ||
      chat.created['contextKind'] === 'shared_child' ||
      chat.created['createdBy'] !== saved.requesterId ||
      chat.created['assistantId'] !== saved.assistantId) {
    return undefined;
  }
  return saved;
}

// Consume saved withdrawal only. Detection and subscriptions belong to the caller.
export async function stopInvalidatedMemory(options: Options, input: unknown)
  : Promise<'sent' | 'ignored' | 'unavailable'> {
  const parsed = memoryContextRecordedEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.silo !== options.silo ||
      parsed.data.data.action !== 'invalidated') {
    return 'ignored';
  }
  const candidate = parsed.data;
  try {
    // Require the exact saved event; a copied id or changed binding is not evidence.
    // Withdrawal needs no permission from the person whose authority has ended.
    const chat = await readChatFacts(options.store, options.silo,
      candidate.data.conversationId, candidate.data.turnId);
    const saved = confirmedBinding(chat, candidate);
    if (!saved) return 'ignored';
    await options.refresh?.();
    const active = options.current(saved);
    if (!active || !matches(active, options.silo, saved)) return 'ignored';
    // Send without yielding after checking the live binding. Saved invalidation
    // already refuses dispatch and renewal while the computer clears its buffers.
    // Allow resending after uncertain delivery; the computer shares work for duplicate Stops.
    const frame = { type: 'stop', conversationId: saved.conversationId,
      turnId: saved.turnId, threadId: saved.threadId };
    active.socket.send(JSON.stringify(frame));
    return 'sent';
  } catch {
    // Keep history and transport errors out of the result. Retrying grants nothing.
    return 'unavailable';
  }
}
