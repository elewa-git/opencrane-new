import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import type { MemoryContextState } from '@opencrane/models';
import { memoryScopeId } from '@opencrane/projections';
import { invalidateMemoryContext } from './invalidation.ts';

type Options = { silo: string; store: EventStore };

async function readChanges(options: Options, scopeId: string, position: number) {
  const deadline = performance.now() + 10_000;
  const expired = Promise.withResolvers<never>();
  function timeout() { expired.reject(new Error('Memory changes unavailable')); }
  const timer = setTimeout(timeout, 10_000);
  async function read() {
    const rows: StoredEvent[] = [];
    const subject = `scope-${scopeId}`;
    for await (const row of options.store.readStream(subject, position + 1, deadline)) {
      if (row.event.silo !== options.silo || row.event.subject !== subject) {
        throw new Error('Memory changes unavailable');
      }
      rows.push(row);
      if (rows.length === 128) break;
    }
    return rows;
  }
  try {
    return await Promise.race([read(), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

// Keep only a cursor between polls. Recheck saved loads when a later recall adds evidence.
export function memoryChanges(options: Options) {
  let evidenceCount = 0;
  let position = 0;
  return async function detect(state: MemoryContextState) {
    if (state.references.length === 0) return;
    let saved;
    let firstPosition = Infinity;
    for (const encoded of state.events.values()) {
      const decoded: unknown = JSON.parse(encoded);
      const event = memoryContextRecordedEventSchema.parse(decoded);
      if (event.data.action === 'invalidated') return;
      saved ??= event.data;
      if (event.data.action !== 'loaded') continue;
      const scopeId = memoryScopeId(options.silo, 'person', saved.requesterId);
      for (const scope of event.data.scopePositions) {
        if (scope.scopeId === scopeId) firstPosition = Math.min(firstPosition, scope.position);
      }
    }
    if (!saved || firstPosition === Infinity) return;
    if (evidenceCount !== state.events.size) {
      position = firstPosition;
      evidenceCount = state.events.size;
    }
    const scopeId = memoryScopeId(options.silo, 'person', saved.requesterId);
    const rows = await readChanges(options, scopeId, position);
    for (const row of rows) {
      if (row.event.type === 'memory.corrected' || row.event.type === 'memory.forgotten') {
        const request = { conversationId: saved.conversationId, turnId: saved.turnId,
          threadId: saved.threadId, inputGeneration: saved.inputGeneration, causeId: row.event.id };
        const receipt = await invalidateMemoryContext(options, request);
        // Retry uncertain writes and competing recalls from saved history on the next poll.
        if (receipt.status !== 'unchanged') return;
      }
      position = row.sequence;
    }
  };
}
