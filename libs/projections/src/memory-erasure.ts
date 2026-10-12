import { memoryForgottenEventSchema, memoryWrittenEventSchema, parseEventByType,
  type EventEnvelope } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryIdentity, memoryScopeId } from './memory-keys.ts';

type ScopeHistory = { hidden: Set<string>; children: Map<string, Set<string>> };
function scopeReference(silo: string, scopeId: string) {
  return JSON.stringify([silo, scopeId]);
}

function scopeHistory(histories: Map<string, ScopeHistory>, silo: string, scopeId: string) {
  const reference = scopeReference(silo, scopeId);
  let scope = histories.get(reference);
  if (!scope) {
    scope = { hidden: new Set(), children: new Map() };
    histories.set(reference, scope);
  }
  return scope;
}

function recordMetadata(histories: Map<string, ScopeHistory>, event: EventEnvelope) {
  if (event.type !== 'memory.written' && event.type !== 'memory.forgotten') {
    return;
  }
  if (!parseEventByType(event).success) {
    throw new Error('Invalid saved memory event');
  }
  if (event.type === 'memory.forgotten') {
    const saved = memoryForgottenEventSchema.parse(event);
    if (!('schemaVersion' in saved.data)) {
      // Stop rather than assign an old tombstone to an owner whose identity is unknown.
      throw new Error('Memory change is not supported by this projection yet');
    }
    const data = saved.data;
    if (data.scopeId !== memoryScopeId(event.silo, data.scopeKind, data.ownerId)) {
      throw new Error('Memory scope identity mismatch');
    }
    const scope = scopeHistory(histories, event.silo, data.scopeId);
    scope.hidden.add(data.memoryId);
    return;
  }
  const saved = memoryWrittenEventSchema.parse(event);
  const identity = memoryIdentity(saved);
  if (identity === null || !('schemaVersion' in saved.data)) {
    return;
  }
  const scope = scopeHistory(histories, event.silo, identity.scopeId);
  for (const dependency of saved.data.dependsOn) {
    let children = scope.children.get(dependency.memoryId);
    if (!children) {
      children = new Set();
      scope.children.set(dependency.memoryId, children);
    }
    children.add(identity.memoryId);
  }
}

/** Find every dependent copy from saved metadata; never read text or revision keys. */
export async function memoryErasureHistory(events: AsyncIterable<StoredEvent> | Iterable<StoredEvent>) {
  const histories = new Map<string, ScopeHistory>();
  for await (const stored of events) {
    recordMetadata(histories, stored.event);
  }
  for (const scope of histories.values()) {
    const pending = [...scope.hidden];
    while (pending.length > 0) {
      const memoryId = pending.pop()!;
      const children = scope.children.get(memoryId) ?? [];
      for (const child of children) {
        if (!scope.hidden.has(child)) {
          scope.hidden.add(child);
          pending.push(child);
        }
      }
    }
  }
  function hidden(silo: string, scopeId: string) {
    const scope = histories.get(scopeReference(silo, scopeId));
    return scope?.hidden ?? new Set<string>();
  }
  return { hidden };
}
