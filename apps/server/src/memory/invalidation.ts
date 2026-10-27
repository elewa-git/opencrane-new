import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema, memoryCorrectedEventSchema,
  memoryForgottenEventSchema, type MemoryContextRecord } from '@opencrane/events';
import { foldMemoryContext, history, memoryReferences, type MemoryContextState } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { readChatFacts, type ChatFacts } from '../chat/chat-summary.ts';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const requestSchema = z.strictObject({ conversationId: identifier, turnId: identifier,
  threadId: identifier, inputGeneration: identifier, causeId: identifier });
type Request = z.infer<typeof requestSchema>;
type Options = { silo: string; store: EventStore };
type Receipt = { status: 'invalidated'; eventId: string; inputGeneration: string } |
  { status: 'unchanged' | 'refused' | 'reload_required' | 'unavailable' };

function savedBinding(chat: ChatFacts, request: Request) {
  const first = chat.memoryContext?.events.values().next().value;
  if (!first) throw new Error('Memory evidence unavailable');
  const decoded: unknown = JSON.parse(first);
  const saved = memoryContextRecordedEventSchema.parse(decoded).data;
  if (saved.conversationId !== request.conversationId || saved.turnId !== request.turnId ||
      saved.threadId !== request.threadId || saved.inputGeneration !== request.inputGeneration ||
      chat.created?.['mode'] !== 'agent_session' || chat.created['contextKind'] === 'shared_child' ||
      chat.created['createdBy'] !== saved.requesterId ||
      chat.created['assistantId'] !== saved.assistantId) {
    throw new Error('Memory binding unavailable');
  }
  return saved;
}

function checkedCause(rows: StoredEvent[], request: Request, saved: MemoryContextRecord) {
  function matches(row: StoredEvent) {
    return row.event.id === request.causeId;
  }
  const index = rows.findIndex(matches);
  const row = rows[index];
  if (!row) throw new Error('Memory change unavailable');
  const schema = row.event.type === 'memory.corrected'
    ? memoryCorrectedEventSchema : memoryForgottenEventSchema;
  const event = schema.parse(row.event);
  const data = event.data;
  if (!('schemaVersion' in data) || data.scopeKind !== 'person' ||
      data.ownerId !== saved.requesterId) {
    throw new Error('Memory change unavailable');
  }
  return { index, row, data };
}

function affected(options: Options, rows: StoredEvent[], request: Request,
  saved: MemoryContextRecord, chat: ChatFacts, scopeId: string) {
  const cause = checkedCause(rows, request, saved);
  const beforeRows = rows.slice(0, cause.index);
  const afterRows = rows.slice(0, cause.index + 1);
  // Compare at the saved cause's time so delayed processing cannot change its effect.
  // Use the same time on both sides so expiry cannot impersonate a saved correction.
  const checkedAt = Date.parse(cause.row.event.time);
  const before = memoryReferences(beforeRows, options.silo, scopeId, 'event-only', checkedAt);
  const after = memoryReferences(afterRows, options.silo, scopeId, 'event-only', checkedAt);
  const target = { scopeId, memoryId: cause.data.memoryId, revision: cause.data.expectedRevision };
  if (before.current(target) !== 'current') throw new Error('Memory change unavailable');
  let changed = false;
  for (const reference of chat.memoryContext!.references) {
    if (reference.scopeId !== scopeId || before.current(reference) !== 'current') {
      throw new Error('Memory evidence unavailable');
    }
    changed ||= after.current(reference) !== 'current';
  }
  return { changed, position: cause.row.sequence };
}

function invalidationId(binding: string, causeId: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([binding, causeId]));
  return `memory-invalidation-${hash.digest('hex')}`;
}

async function recordInvalidation(options: Options, request: Request): Promise<Receipt> {
  // Read saved history without requiring the former reader to retain access.
  // This internal command can only withdraw use of an already recorded generation.
  const chat = await readChatFacts(options.store, options.silo,
    request.conversationId, request.turnId);
  const saved = savedBinding(chat, request);
  const state = chat.memoryContext!;
  const id = invalidationId(state.binding, request.causeId);
  const receipt: Receipt = { status: 'invalidated', eventId: id,
    inputGeneration: saved.inputGeneration };
  const recorded = state.events.get(id);
  if (recorded !== undefined) {
    const decoded: unknown = JSON.parse(recorded);
    const recovered = memoryContextRecordedEventSchema.parse(decoded);
    if (recovered.data.action !== 'invalidated' ||
        recovered.data.reason !== 'content_changed' || recovered.commandId !== id) {
      return { status: 'refused' };
    }
    return receipt;
  }
  if (state.status !== 'loaded' || chat.turnEnded || chat.conversationClosed) {
    return { status: 'refused' };
  }
  const scopeId = memoryScopeId(options.silo, 'person', saved.requesterId);
  const rows = await history(options.store, `scope-${scopeId}`, options.silo,
    performance.now() + 10_000);
  const cause = affected(options, rows, request, saved, chat, scopeId);
  if (!cause.changed) return { status: 'unchanged' };

  const current = await readChatFacts(options.store, options.silo,
    request.conversationId, request.turnId);
  if (current.turnEnded || current.conversationClosed ||
      JSON.stringify(current.memoryContext) !== JSON.stringify(state) ||
      JSON.stringify(Array.from(current.memoryContext?.events ?? [])) !==
      JSON.stringify(Array.from(state.events))) {
    return { status: 'reload_required' };
  }
  const event = invalidationEvent(options.silo, saved, state, scopeId, cause.position, id);
  foldMemoryContext(state, event);
  return appendInvalidation(options, event, current.sequence, receipt);
}

function invalidationEvent(silo: string, saved: MemoryContextRecord, state: MemoryContextState,
  scopeId: string, causePosition: number, id: string) {
  const positions = new Map<string, number>();
  for (const position of state.scopePositions) {
    positions.set(position.scopeId, position.position);
  }
  positions.set(scopeId, Math.max(positions.get(scopeId) ?? 0, causePosition));
  const scopePositions = [];
  for (const [savedScope, position] of positions) {
    scopePositions.push({ scopeId: savedScope, position });
  }
  const data: MemoryContextRecord = { ...saved, action: 'invalidated',
    reason: 'content_changed', scopePositions };
  const input = { id, commandId: id,
    silo, subject: `conversation-${saved.conversationId}`,
    type: 'agent.memory_context_recorded', source: 'opencrane-server',
    principal: { kind: 'system', id: 'server' }, time: new Date().toISOString(),
    correlation: { conversation: saved.conversationId, turn: saved.turnId }, data };
  return memoryContextRecordedEventSchema.parse(input);
}

async function appendInvalidation(options: Options,
  event: z.infer<typeof memoryContextRecordedEventSchema>, sequence: number,
  receipt: Receipt): Promise<Receipt> {
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline: performance.now() + 2000 };
  try {
    const result = await options.store.append(command);
    if (result.status === 'conflict') return { status: 'reload_required' };
    if (result.status !== 'appended') return { status: 'unavailable' };
    // Reconcile participation closure separately because it uses another stream.
    const current = await readChatFacts(options.store, options.silo,
      event.data.conversationId, event.data.turnId);
    if (current.conversationClosed || current.turnEnded) return { status: 'reload_required' };
    return receipt;
  } catch {
    // Recover uncertain appends from history on a later call; never append twice here.
    return { status: 'unavailable' };
  }
}

export async function invalidateMemoryContext(options: Options, input: Request): Promise<Receipt> {
  try {
    const request = requestSchema.parse(input);
    return await recordInvalidation(options, request);
  } catch {
    return { status: 'refused' };
  }
}
