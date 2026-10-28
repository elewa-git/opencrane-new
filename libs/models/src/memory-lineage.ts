import { memoryWrittenDataSchema, memoryValueEventSchema, parseEventByType,
  type EventEnvelope, type MemoryIdentity } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { memoryIdentity, shouldReplaceMemoryRevision } from '@opencrane/projections';

const changeIdentity = memoryWrittenDataSchema.pick({ scopeId: true, memoryId: true });
const changeFields = changeIdentity.strip();

type Reference = Pick<MemoryIdentity, 'scopeId' | 'memoryId' | 'revision'>;
type Status = 'current' | 'erased' | 'superseded' | 'invalid';
type Write = ReturnType<typeof memoryValueEventSchema.parse>;
type Custody = 'event-only' | {
  status: (identity: MemoryIdentity) => 'available' | 'destroyed' | 'missing';
};

function newerWrite(previous: Write | undefined, next: Write) {
  const previousRevision = previous && 'schemaVersion' in previous.data
    ? previous.data.revision : null;
  const nextRevision = 'schemaVersion' in next.data ? next.data.revision : null;
  return shouldReplaceMemoryRevision(previousRevision, nextRevision);
}

function recordChange(event: EventEnvelope, scopeId: string, hidden: Map<string, Status>) {
  const data = changeFields.parse(event.data);
  if (data.scopeId !== scopeId) {
    throw new Error('Invalid memory scope');
  }
  // Refuse legacy replacements without guessing their owner or revision.
  if (event.type === 'memory.forgotten') {
    hidden.set(data.memoryId, 'erased');
  } else if (!hidden.has(data.memoryId)) {
    hidden.set(data.memoryId, 'superseded');
  }
}

function versionedReplacement(event: EventEnvelope) {
  if (event.type !== 'memory.corrected') {
    return undefined;
  }
  const saved = memoryValueEventSchema.parse(event);
  if ('schemaVersion' in saved.data) {
    return saved;
  }
  return undefined;
}

function memoryHistory(rows: StoredEvent[], silo: string, scopeId: string) {
  const latest = new Map<string, Write>();
  const historical = new Map<string, Reference[]>();
  const hidden = new Map<string, Status>();
  for (const row of rows) {
    const event = row.event;
    if (!event.type.startsWith('memory.')) {
      continue;
    }
    const checked = parseEventByType(event);
    if (!checked.success || event.silo !== silo || event.subject !== `scope-${scopeId}`) {
      throw new Error('Invalid memory history');
    }
    const replacement = versionedReplacement(event);
    if (event.type === 'memory.written' || replacement) {
      const saved = replacement ?? memoryValueEventSchema.parse(event);
      if (saved.data.scopeId !== scopeId) {
        throw new Error('Invalid memory scope');
      }
      const previousWrite = latest.get(saved.data.memoryId);
      // Keep the same current revision as the projection; repeated writes cannot reset expiry.
      if (newerWrite(previousWrite, saved)) {
        latest.set(saved.data.memoryId, saved);
      }
      if ('schemaVersion' in saved.data) {
        const previous = historical.get(saved.data.memoryId) ?? [];
        previous.push(...saved.data.dependsOn);
        historical.set(saved.data.memoryId, previous);
      }
    } else if (event.type === 'memory.forgotten' || event.type === 'memory.corrected') {
      recordChange(checked.event, scopeId, hidden);
    }
  }
  return { latest, historical, hidden };
}

function ownStatus(history: ReturnType<typeof memoryHistory>, scopeId: string,
  custody: Custody, reference: Reference, checkedAt?: number): Status {
  if (reference.scopeId !== scopeId) {
    return 'invalid';
  }
  const prohibition = history.hidden.get(reference.memoryId);
  if (prohibition) {
    return prohibition;
  }
  const saved = history.latest.get(reference.memoryId);
  if (!saved) {
    return 'invalid';
  }
  const identity = memoryIdentity(saved);
  if (!identity) {
    return 'invalid';
  }
  if (identity.revision !== reference.revision) {
    return 'superseded';
  }
  if ('schemaVersion' in saved.data && saved.data.expiresAt !== null &&
      Date.parse(saved.data.expiresAt) <= (checkedAt ?? Date.now())) {
    return 'invalid';
  }
  // Check saved changes without revision keys in dispatch processes.
  if (custody === 'event-only') {
    return 'current';
  }
  const status = custody.status(identity);
  if (status === 'missing') {
    throw new Error('Memory custody unavailable');
  }
  if (status === 'destroyed') {
    return 'erased';
  }
  return 'current';
}

/** Check saved references without decrypting any fact text. */
export function memoryReferences(rows: StoredEvent[], silo: string, scopeId: string,
  custody: Custody, checkedAt?: number) {
  const history = memoryHistory(rows, silo, scopeId);
  function current(reference: Reference, at = checkedAt): Status {
    const status = ownStatus(history, scopeId, custody, reference, at);
    if (status !== 'current') {
      return status;
    }
    const visiting = new Set<string>();
    const complete = new Set<string>();
    const pending = [{ reference, exit: false }];
    while (pending.length > 0) {
      const step = pending.pop()!;
      const id = JSON.stringify([step.reference.scopeId, step.reference.memoryId,
        step.reference.revision]);
      if (step.exit) {
        visiting.delete(id);
        complete.add(id);
        continue;
      }
      if (complete.has(id)) {
        continue;
      }
      const invalidDependency = visiting.has(id) ||
        ownStatus(history, scopeId, custody, step.reference, at) !== 'current';
      if (invalidDependency) {
        return 'invalid';
      }
      visiting.add(id);
      const finished = { reference: step.reference, exit: true };
      pending.push(finished);
      const dependencies = history.historical.get(step.reference.memoryId) ?? [];
      for (const dependency of dependencies) {
        const next = { reference: dependency, exit: false };
        pending.push(next);
      }
    }
    return 'current';
  }
  return { current };
}
