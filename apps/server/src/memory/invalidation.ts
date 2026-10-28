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

function checkLoadedReferences(options: Options, rows: StoredEvent[],
  state: MemoryContextState, scopeId: string) {
  for (const encoded of state.events.values()) {
    const decoded: unknown = JSON.parse(encoded);
    const loaded = memoryContextRecordedEventSchema.parse(decoded);
    if (loaded.data.action !== 'loaded' || loaded.data.additions.length === 0) {
      continue;
    }
    function matchesScope(position: MemoryContextRecord['scopePositions'][number]) {
      return position.scopeId === scopeId;
    }
    const position = loaded.data.scopePositions.find(matchesScope);
    if (!position) {
      throw new Error('Memory evidence unavailable');
    }
    const scopePosition = position.position;
    function throughLoad(row: StoredEvent) {
      return row.sequence <= scopePosition;
    }
    const loadedRows = rows.filter(throughLoad);
    const loadedAt = Date.parse(loaded.time);
    const references = memoryReferences(loadedRows, options.silo, scopeId, 'event-only', loadedAt);
    // Check each addition where it was loaded; later recalls need not predate the cause.
    for (const reference of loaded.data.additions) {
      if (reference.scopeId !== scopeId || references.current(reference) !== 'current') {
        throw new Error('Memory evidence unavailable');
      }
    }
  }
}

function affected(options: Options, rows: StoredEvent[], request: Request,
  saved: MemoryContextRecord, state: MemoryContextState, scopeId: string) {
  const cause = checkedCause(rows, request, saved);
  const beforeRows = rows.slice(0, cause.index);
  const afterRows = rows.slice(0, cause.index + 1);
  // Compare at the saved cause's time so delayed processing cannot change its effect.
  // Use the same time on both sides so expiry cannot impersonate a saved correction.
  const checkedAt = Date.parse(cause.row.event.time);
  const before = memoryReferences(beforeRows, options.silo, scopeId, 'event-only', checkedAt);
  const after = memoryReferences(afterRows, options.silo, scopeId, 'event-only', checkedAt);
  checkLoadedReferences(options, rows, state, scopeId);
  let changed = false;
  for (const reference of state.references) {
    if (before.current(reference) === 'current' && after.current(reference) !== 'current') {
      changed = true;
    }
  }
  // Let polling pass an unrelated forget even when its target had already expired.
  // Still require a current target before recording any change to loaded memory.
  const target = { scopeId, memoryId: cause.data.memoryId, revision: cause.data.expectedRevision };
  if (changed && before.current(target) !== 'current') {
    throw new Error('Memory change unavailable');
  }
  return { changed, position: cause.row.sequence };
}

function invalidationId(binding: string, causeId: string) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([binding, causeId]));
  return `memory-invalidation-${hash.digest('hex')}`;
}

function canWithdraw(state: MemoryContextState) {
  if ((state.status !== 'loaded' && state.status !== 'ended') || state.references.length === 0) {
    return false;
  }
  for (const encoded of state.events.values()) {
    const decoded: unknown = JSON.parse(encoded);
    if (memoryContextRecordedEventSchema.parse(decoded).data.action === 'invalidated') {
      return false;
    }
  }
  return true;
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
    // Recover the durable result before expiry or unavailable memory history can hide it.
    const decoded: unknown = JSON.parse(recorded);
    const recovered = memoryContextRecordedEventSchema.parse(decoded);
    if (recovered.data.action !== 'invalidated' ||
        recovered.data.reason !== 'content_changed' || recovered.commandId !== id) {
      return { status: 'refused' };
    }
    return receipt;
  }
  if (!canWithdraw(state)) return { status: 'refused' };
  const scopeId = memoryScopeId(options.silo, 'person', saved.requesterId);
  const rows = await history(options.store, `scope-${scopeId}`, options.silo,
    performance.now() + 10_000);
  const cause = affected(options, rows, request, saved, state, scopeId);
  if (!cause.changed) return { status: 'unchanged' };

  const current = await readChatFacts(options.store, options.silo,
    request.conversationId, request.turnId);
  if (current.turnEnded !== chat.turnEnded ||
      current.conversationClosed !== chat.conversationClosed ||
      JSON.stringify(current.memoryContext) !== JSON.stringify(state) ||
      JSON.stringify(Array.from(current.memoryContext?.events ?? [])) !==
      JSON.stringify(Array.from(state.events))) {
    return { status: 'reload_required' };
  }
  const event = invalidationEvent(options.silo, saved, state, scopeId, cause.position, id);
  foldMemoryContext(state, event);
  return appendInvalidation(options, event, current, receipt);
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
  event: z.infer<typeof memoryContextRecordedEventSchema>, before: ChatFacts,
  receipt: Receipt): Promise<Receipt> {
  const command = { event, expectedSequence: before.sequence, historyChecked: true as const,
    deadline: performance.now() + 2000 };
  try {
    const result = await options.store.append(command);
    if (result.status === 'conflict') return { status: 'reload_required' };
    if (result.status !== 'appended') return { status: 'unavailable' };
    // Reconcile participation closure separately because it uses another stream.
    const current = await readChatFacts(options.store, options.silo,
      event.data.conversationId, event.data.turnId);
    if (current.conversationClosed !== before.conversationClosed ||
        current.turnEnded !== before.turnEnded) return { status: 'reload_required' };
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
