import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { memoryForgottenEventSchema, memoryCorrectedEventSchema,
  memoryCleanupRecordedEventSchema, memoryCleanupRecordedDataSchema,
  type EventEnvelope, type MemoryIdentity } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { registerHandler } from '@opencrane/handlers';
import { memoryIdentity, memoryErasureHistory, type memoryKeys,
  readEvents, type EventSource, type Query } from '@opencrane/projections';
import type { Handler, HandlerRuntime } from '@opencrane/handlers';

type Keys = ReturnType<typeof memoryKeys>;
type MemoryChange = ReturnType<typeof memoryForgottenEventSchema.parse> |
  ReturnType<typeof memoryCorrectedEventSchema.parse>;

function parseChange(event: EventEnvelope) {
  if (event.type === 'memory.corrected') {
    return memoryCorrectedEventSchema.parse(event);
  }
  return memoryForgottenEventSchema.parse(event);
}

function recordedFor(event: EventEnvelope, saved: MemoryChange,
  outcome: 'completed' | 'unavailable') {
  if (event.type !== 'memory.cleanup_recorded' || !('schemaVersion' in saved.data)) return false;
  const record = memoryCleanupRecordedEventSchema.parse(event);
  return record.data.outcome === outcome &&
    record.data.changeId === saved.id && record.data.scopeId === saved.data.scopeId &&
    record.data.scopeKind === saved.data.scopeKind && record.data.ownerId === saved.data.ownerId;
}

async function cleanupHistory(store: EventStore, trigger: EventEnvelope) {
  const saved = parseChange(trigger);
  if (!('schemaVersion' in saved.data)) {
    throw new Error('Memory cleanup requires a version-1 change');
  }
  const rows: StoredEvent[] = [];
  let original: MemoryChange | undefined;
  let completed = false;
  let unavailable = false;
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(saved.subject, 1, deadline)) {
    if (row.event.silo !== saved.silo || row.event.subject !== saved.subject) {
      throw new Error('Unsupported memory cleanup history');
    }
    rows.push(row);
    if (row.event.id === saved.id && row.event.type === saved.type) {
      original = parseChange(row.event);
    }
    if (recordedFor(row.event, saved, 'completed')) completed = true;
    if (recordedFor(row.event, saved, 'unavailable')) unavailable = true;
  }
  // Require the saved deletion target. A queue message cannot choose another fact.
  if (!original || JSON.stringify(original) !== JSON.stringify(saved)) {
    throw new Error('Memory change was not saved');
  }
  return { saved, data: saved.data, rows, completed, unavailable };
}

function cleanupRecord(saved: MemoryChange, outcome: 'completed' | 'unavailable') {
  const target = saved.data;
  if (!('schemaVersion' in target)) {
    throw new Error('Memory change needs recorded ownership');
  }
  const reference = [saved.silo, saved.id, 'memory.cleanup_recorded'];
  if (outcome === 'unavailable') reference.push('unavailable');
  const hash = createHash('sha256');
  hash.update(JSON.stringify(reference));
  const id = hash.digest('hex');
  const data: ReturnType<typeof memoryCleanupRecordedDataSchema.parse> = {
    schemaVersion: 1, scopeId: target.scopeId,
    scopeKind: target.scopeKind, ownerId: target.ownerId,
    changeId: saved.id, outcome };
  if (outcome === 'unavailable') {
    data.failureCode = 'retry_exhausted';
  }
  const event = { id, commandId: id, type: 'memory.cleanup_recorded',
    source: 'opencrane-worker', subject: saved.subject, silo: saved.silo,
    time: new Date().toISOString(), principal: { kind: 'system', id: 'opencrane-worker' },
    correlation: {}, data };
  return memoryCleanupRecordedEventSchema.parse(event);
}

async function appendRecord(
  store: EventStore,
  saved: MemoryChange,
  outcome: 'completed' | 'unavailable',
  sequence: number,
) {
  const event = cleanupRecord(saved, outcome);
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline: performance.now() + 2000 };
  const result = await store.append(command);
  if (result.status !== 'appended') throw new Error('Memory cleanup result was not saved');
}

function cleanupIdentities(rows: StoredEvent[], hidden: Set<string>, superseded: Map<string, number>) {
  const identities: MemoryIdentity[] = [];
  const latest = new Map<string, MemoryIdentity>();
  for (const row of rows) {
    if (row.event.type !== 'memory.written' && row.event.type !== 'memory.corrected') {
      continue;
    }
    const identity = memoryIdentity(row.event);
    if (!identity) throw new Error('Memory cleanup requires recorded ownership');
    if (hidden.has(identity.memoryId) ||
        identity.revision <= (superseded.get(identity.memoryId) ?? 0)) {
      identities.push(identity);
    }
    if (!hidden.has(identity.memoryId)) continue;
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
  hidden: Set<string>, superseded: Map<string, number>, sequence: number) {
  const checkpoint = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name='memory'",
  );
  if (Number(checkpoint.rows[0]?.sequence ?? -1) < sequence) {
    throw new Error('Memory projection is behind cleanup');
  }
  const affected = new Set([...hidden, ...superseded.keys()]);
  const result = await db.query<{ memory_id: string; revision: string;
    content_status: string; search_text: string | null;
    search_vector: string | null; ciphertext: string; key_id: string }>(
    `SELECT memory_id, revision, content_status, search_text, search_vector, ciphertext, key_id
      FROM memory_facts
      WHERE silo=$1 AND scope_id=$2 AND memory_id=ANY($3::text[])`,
    [silo, scopeId, [...affected]],
  );
  if (result.rows.length !== affected.size) {
    throw new Error('Memory removal has not been projected');
  }
  for (const row of result.rows) {
    if (!hidden.has(row.memory_id)) {
      if (Number(row.revision) <= (superseded.get(row.memory_id) ?? 0)) {
        throw new Error('Superseded memory remains projected');
      }
      continue;
    }
    if (row.content_status !== 'erased' || row.search_text !== null || row.search_vector !== null ||
        row.ciphertext !== '' || row.key_id !== '') {
      throw new Error('Memory search removal was not verified');
    }
  }
}

export function memoryCleanupHandler(store: EventStore, keys: Keys, contentDb: Query) {
  async function cleanup(trigger: EventEnvelope) {
    const state = await cleanupHistory(store, trigger);
    if (state.completed) return;
    const erasure = await memoryErasureHistory(state.rows);
    const hidden = erasure.hidden(state.saved.silo, state.data.scopeId);
    const superseded = erasure.superseded(state.saved.silo, state.data.scopeId);
    const targets = cleanupIdentities(state.rows, hidden, superseded);
    await destroyKeys(keys, targets.identities, true);
    await destroyKeys(keys, targets.candidates, false);
    const sequence = state.rows.at(-1)?.sequence ?? 0;
    const data = state.data;
    await verifySearchRemoval(contentDb, state.saved.silo, data.scopeId, hidden, superseded, sequence);
    // Refuse completion if content moved after the checked history. Retry from events.
    await appendRecord(store, state.saved, 'completed', sequence);
  }
  async function exhausted(trigger: EventEnvelope): Promise<boolean> {
    const state = await cleanupHistory(store, trigger);
    if (state.completed || state.unavailable) return false;
    const sequence = state.rows.at(-1)?.sequence ?? 0;
    await appendRecord(store, state.saved, 'unavailable', sequence);
    return true;
  }
  return { ...registerHandler('cleanup-memory', cleanup), exhausted };
}

async function restoreCleanupBatch(runtime: HandlerRuntime, handler: Handler,
  batch: MemoryChange[], completed: Set<string>): Promise<number> {
  const failedOriginals: { event: MemoryChange; id: string }[] = [];
  let queued = 0;
  async function enqueuePending(tx: Query) {
    for (const event of batch) {
      const existing = await tx.query<{ id: string; state: string }>(
        "SELECT id, state FROM pgboss.job " +
        "WHERE name='cleanup-memory' AND data->>'id'=$1 LIMIT 1",
        [event.id],
      );
      const receipt = await tx.query(
        "SELECT 1 FROM handler_receipts WHERE handler='cleanup-memory' AND event_id=$1",
        [event.id],
      );
      const original = existing.rows[0];
      if (original?.state === 'failed') {
        failedOriginals.push({ event, id: original.id });
        continue;
      }
      if (receipt.rows.length || original || completed.has(event.id)) continue;
      await runtime.enqueue(handler, event, tx);
      queued += 1;
    }
  }
  await runtime.options.db.transaction(enqueuePending);
  const retryOptions = { resetRetries: true };
  for (const original of failedOriginals) {
    // Report after the SQL transaction, so the event store can append one outcome.
    await runtime.reportFailedOriginal(handler, original.event, original.id);
    // Retry the original in place so later changes cannot pass it or stay blocked after repair.
    // Let the handler reuse a saved completion if the earlier attempt lost its queue commit.
    await runtime.replay(handler.name, original.id, retryOptions);
    queued += 1;
  }
  return queued;
}

function rememberCompletion(event: EventEnvelope, changes: Map<string, MemoryChange>,
  failedChanges: Set<string>, completed: Set<string>): void {
  const result = memoryCleanupRecordedEventSchema.parse(event);
  const changeId = result.data.changeId;
  const original = changes.get(changeId);
  if (!original || !recordedFor(event, original, 'completed')) return;
  if (failedChanges.has(changeId)) {
    // Keep the saved completion until the failed queue commit has been retried.
    completed.add(changeId);
  } else {
    changes.delete(changeId);
  }
}

/** Restore missing jobs and retry failed cleanup before the dispatcher starts its workers. */
export async function recoverMemoryCleanup(runtime: HandlerRuntime, source: EventSource,
  checkpoint: number): Promise<number> {
  function isCleanup(candidate: typeof runtime.options.handlers[number]) {
    return candidate.name === 'cleanup-memory';
  }
  const handler = runtime.options.handlers.find(isCleanup);
  if (!handler) return 0;
  const cleanupHandler = handler;
  const failedJobs = await runtime.options.db.query<{ event_id: string }>(
    "SELECT data->>'id' AS event_id FROM pgboss.job WHERE name='cleanup-memory' AND state='failed'",
  );
  const failedChanges = new Set<string>();
  for (const job of failedJobs.rows) failedChanges.add(job.event_id);
  const changes = new Map<string, MemoryChange>();
  const completed = new Set<string>();
  const head = await source.head();
  if (head < checkpoint) throw new Error('Cleanup recovery checkpoint exceeds history');
  for (let start = 1; start <= head; start += 256) {
    const end = Math.min(start + 255, head);
    for await (const row of readEvents(source, start, end)) {
      const event = row.event;
      if (event.silo !== runtime.options.silo) throw new Error('Cleanup recovery silo mismatch');
      if (event.type === 'memory.forgotten' || event.type === 'memory.corrected') {
        const saved = parseChange(event);
        if (!('schemaVersion' in saved.data)) continue;
        if (row.sequence <= checkpoint) {
          changes.set(event.id, saved);
        }
      }
      if (event.type === 'memory.cleanup_recorded') {
        rememberCompletion(event, changes, failedChanges, completed);
      }
    }
  }
  const saved = [...changes.values()];
  let queued = 0;
  for (let start = 0; start < saved.length; start += 256) {
    const batch = saved.slice(start, start + 256);
    queued += await restoreCleanupBatch(runtime, cleanupHandler, batch, completed);
  }
  return queued;
}
