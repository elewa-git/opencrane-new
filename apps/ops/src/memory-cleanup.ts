import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { memoryForgottenEventSchema, memoryCleanupRecordedEventSchema,
  type EventEnvelope, type MemoryIdentity } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { registerHandler } from '@opencrane/handlers';
import { memoryIdentity, memoryErasureHistory, type memoryKeys,
  type Query } from '@opencrane/projections';

type Keys = ReturnType<typeof memoryKeys>;
type Tombstone = ReturnType<typeof memoryForgottenEventSchema.parse>;

function completedFor(event: EventEnvelope, saved: Tombstone) {
  if (event.type !== 'memory.cleanup_recorded' || !('schemaVersion' in saved.data)) return false;
  const record = memoryCleanupRecordedEventSchema.parse(event);
  return record.data.changeId === saved.id && record.data.scopeId === saved.data.scopeId &&
    record.data.scopeKind === saved.data.scopeKind && record.data.ownerId === saved.data.ownerId;
}

async function cleanupHistory(store: EventStore, trigger: EventEnvelope) {
  const saved = memoryForgottenEventSchema.parse(trigger);
  if (!('schemaVersion' in saved.data) || saved.data.scopeKind !== 'person') {
    throw new Error('Memory cleanup requires a person tombstone');
  }
  const rows: StoredEvent[] = [];
  let original: Tombstone | undefined;
  let completed = false;
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(saved.subject, 1, deadline)) {
    if (row.event.silo !== saved.silo || row.event.subject !== saved.subject ||
        row.event.type === 'memory.corrected') {
      throw new Error('Unsupported memory cleanup history');
    }
    rows.push(row);
    if (row.event.id === saved.id && row.event.type === 'memory.forgotten') {
      original = memoryForgottenEventSchema.parse(row.event);
    }
    if (completedFor(row.event, saved)) completed = true;
  }
  // Require the saved deletion target. A queue message cannot choose another fact.
  if (!original || JSON.stringify(original) !== JSON.stringify(saved)) {
    throw new Error('Memory tombstone was not saved');
  }
  const erasure = await memoryErasureHistory(rows);
  const hidden = erasure.hidden(saved.silo, saved.data.scopeId);
  return { saved, data: saved.data, rows, hidden, completed };
}

function cleanupIdentities(rows: StoredEvent[], hidden: Set<string>) {
  const identities: MemoryIdentity[] = [];
  const latest = new Map<string, MemoryIdentity>();
  for (const row of rows) {
    if (row.event.type !== 'memory.written') continue;
    const identity = memoryIdentity(row.event);
    if (!identity) throw new Error('Memory cleanup requires recorded ownership');
    if (!hidden.has(identity.memoryId)) continue;
    identities.push(identity);
    const previous = latest.get(identity.memoryId);
    if (!previous || previous.revision < identity.revision) {
      latest.set(identity.memoryId, identity);
    }
  }
  const candidates: MemoryIdentity[] = [];
  for (const identity of latest.values()) {
    // Close the one next-revision slot too, including temporary copies left by a crash.
    const candidate = { ...identity, revision: identity.revision + 1 };
    candidates.push(candidate);
  }
  return { identities, candidates };
}

async function destroyKeys(keys: Keys, identities: MemoryIdentity[], committed: boolean) {
  let processed = 0;
  for (const identity of identities) {
    if (committed && keys.status(identity) === 'missing') {
      throw new Error('Memory custody unavailable');
    }
    keys.delete(identity);
    if (keys.status(identity) !== 'destroyed') {
      throw new Error('Memory deletion was not verified');
    }
    if (++processed % 16 === 0) await setImmediate();
  }
}

async function verifySearchRemoval(db: Query, silo: string, scopeId: string,
  hidden: Set<string>, sequence: number) {
  const checkpoint = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='memory'",
  );
  if (Number(checkpoint.rows[0]?.sequence ?? -1) < sequence) {
    throw new Error('Memory projection is behind cleanup');
  }
  const result = await db.query<{ content_status: string; search_text: string | null;
    search_vector: string | null; ciphertext: string; key_id: string }>(
    `SELECT content_status, search_text, search_vector, ciphertext, key_id FROM memory_facts
      WHERE silo=$1 AND scope_id=$2 AND memory_id=ANY($3::text[])`,
    [silo, scopeId, [...hidden]],
  );
  if (result.rows.length !== hidden.size) {
    throw new Error('Memory removal has not been projected');
  }
  for (const row of result.rows) {
    if (row.content_status !== 'erased' || row.search_text !== null || row.search_vector !== null ||
        row.ciphertext !== '' || row.key_id !== '') {
      throw new Error('Memory search removal was not verified');
    }
  }
}

export function memoryCleanupHandler(store: EventStore, keys: Keys) {
  async function cleanup(trigger: EventEnvelope, db: Query) {
    const state = await cleanupHistory(store, trigger);
    if (state.completed) return;
    const targets = cleanupIdentities(state.rows, state.hidden);
    await destroyKeys(keys, targets.identities, true);
    await destroyKeys(keys, targets.candidates, false);
    const sequence = state.rows.at(-1)?.sequence ?? 0;
    const data = state.data;
    await verifySearchRemoval(db, state.saved.silo, data.scopeId, state.hidden, sequence);
    const hash = createHash('sha256');
    const reference = [state.saved.silo, state.saved.id, 'memory.cleanup_recorded'];
    const encodedReference = JSON.stringify(reference);
    hash.update(encodedReference);
    const id = hash.digest('hex');
    const event = {
      id, commandId: id, type: 'memory.cleanup_recorded', source: 'opencrane-worker',
      subject: state.saved.subject, silo: state.saved.silo, time: new Date().toISOString(),
      principal: { kind: 'system', id: 'opencrane-worker' }, correlation: {},
      data: { schemaVersion: 1, scopeId: data.scopeId, scopeKind: data.scopeKind,
        ownerId: data.ownerId, changeId: state.saved.id, outcome: 'completed' },
    };
    const completion = memoryCleanupRecordedEventSchema.parse(event);
    // Refuse completion if content moved after the checked history. Retry from events.
    const command = { event: completion, expectedSequence: sequence, historyChecked: true as const,
      deadline: performance.now() + 2000 };
    const result = await store.append(command);
    if (result.status !== 'appended') {
      throw new Error('Memory cleanup completion was not saved');
    }
  }
  return registerHandler('cleanup-memory', cleanup);
}
