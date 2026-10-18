import type { Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import type { authorityFence } from './authority.ts';
import { foldMemoryContext, type MemoryContextState } from './memory-context-fold.ts';
import { loadedMemoryRights, type MemoryContext } from './memory-context.ts';
import { memoryReferences } from './memory-lineage.ts';

type Identity = Pick<MemoryContext, 'silo' | 'requester' | 'assistant' | 'computer' |
  'generation' | 'conversation' | 'turn' | 'thread'>;
type Scope = { scopeId: string; position: number; rows: StoredEvent[] };

export class LoadedMemoryRefused extends Error {
  constructor() {
    super('memory_context_unavailable');
  }
}

function loadedContext(conversation: StoredEvent[], claims: Identity) {
  let state: MemoryContextState | undefined;
  for (const row of conversation) {
    if (row.event.type !== 'agent.memory_context_recorded') continue;
    const event = memoryContextRecordedEventSchema.parse(row.event);
    const saved = event.data;
    if (saved.turnId !== claims.turn) continue;
    if (event.silo !== claims.silo || saved.conversationId !== claims.conversation ||
        saved.requesterId !== claims.requester || saved.assistantId !== claims.assistant ||
        saved.computerId !== claims.computer || saved.generation !== claims.generation ||
        saved.threadId !== claims.thread) {
      throw new LoadedMemoryRefused();
    }
    state = foldMemoryContext(state, event);
  }
  if (state?.status === 'invalidated' || state?.status === 'ended') {
    throw new LoadedMemoryRefused();
  }
  return state;
}

async function readChanges(store: EventStore, scope: Scope, deadline: number) {
  const subject = `scope-${scope.scopeId}`;
  const position = await store.head(subject, deadline);
  if (position < scope.position) throw new LoadedMemoryRefused();
  if (position === scope.position) return false;
  for await (const row of store.readStream(subject, scope.position + 1, deadline)) {
    if (row.sequence > position) break;
    scope.rows.push(row);
  }
  if (scope.rows.at(-1)?.sequence !== position) throw new LoadedMemoryRefused();
  scope.position = position;
  return true;
}

async function readScopeChanges(store: EventStore, scopes: Iterable<Scope>, deadline: number) {
  let changed = false;
  for (const scope of scopes) {
    const updated = await readChanges(store, scope, deadline);
    changed ||= updated;
  }
  return changed;
}

/** Read scope history before starting the short access check. */
export async function prepareLoadedMemory(store: EventStore, binding: Binding | undefined,
  claims: Identity, conversation: StoredEvent[], deadline: number) {
  try {
    const state = loadedContext(conversation, claims);
    const references = state?.references ?? [];
    const scopes = new Map<string, Scope>();
    for (const reference of references) {
      if (scopes.has(reference.scopeId)) continue;
      const scope = { scopeId: reference.scopeId, position: 0, rows: [] };
      await readChanges(store, scope, deadline);
      scopes.set(scope.scopeId, scope);
    }
    for (const saved of state?.scopePositions ?? []) {
      const scope = scopes.get(saved.scopeId);
      if (scope && scope.position < saved.position) throw new LoadedMemoryRefused();
    }
    let rightsChecked = false;
    async function confirm(fresh: Awaited<ReturnType<typeof authorityFence>>) {
      if (references.length === 0) {
        await fresh();
        return;
      }
      try {
        if (!binding) throw new LoadedMemoryRefused();
        if (!rightsChecked) {
          for (const scope of scopes.values()) {
            await loadedMemoryRights(store, binding, claims, scope.scopeId, fresh, conversation);
          }
          // Keep these grants on the original authority check for every later confirmation.
          rightsChecked = true;
        }
        await readScopeChanges(store, scopes.values(), fresh.deadline);
        let changed: boolean;
        do {
          await fresh();
          // Catch memory changes saved while access was being checked. Recheck access
          // after new scope rows, keeping the original deadline for every attempt.
          changed = await readScopeChanges(store, scopes.values(), fresh.deadline);
        } while (changed);
        // Catch access revoked during the last scope read, even when no scope changed.
        // Keep the same small access streams and the original deadline.
        await fresh();
        if (performance.now() >= fresh.deadline) throw new LoadedMemoryRefused();
        confirmReferences(scopes.values(), references, claims.silo);
      } catch {
        throw new LoadedMemoryRefused();
      }
    }
    return { confirm, loaded: references.length > 0 };
  } catch {
    throw new LoadedMemoryRefused();
  }
}

function confirmReferences(scopes: Iterable<Scope>,
  references: MemoryContextState['references'], silo: string) {
  const checkedAt = Date.now();
  for (const scope of scopes) {
    const validator = memoryReferences(scope.rows, silo, scope.scopeId, 'event-only', checkedAt);
    for (const reference of references) {
      if (reference.scopeId === scope.scopeId && validator.current(reference) !== 'current') {
        throw new LoadedMemoryRefused();
      }
    }
  }
}
