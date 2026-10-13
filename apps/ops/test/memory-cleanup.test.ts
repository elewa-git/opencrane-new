import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { HandlerRuntime } from '@opencrane/handlers';
import { memoryKeys, memoryProjection, memoryScopeId,
  ProjectionRunner, readMemoryFactIds } from '@opencrane/projections';
import { memoryForgottenDataSchema, memoryCleanupRecordedEventSchema,
  type EventEnvelope, type MemoryIdentity } from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { memoryCleanupHandler, recoverMemoryCleanup } from '../src/memory-cleanup.ts';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';
import { until } from '../../../libs/handlers/test/helpers.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let directory: string;
let keys: ReturnType<typeof memoryKeys>;
let runner: ProjectionRunner;
let forgotten: EventEnvelope;
let root: MemoryIdentity;
let child: MemoryIdentity;
let independent: MemoryIdentity;
const projection = memoryProjection({ decrypt });
type CleanupResult = ReturnType<typeof memoryCleanupRecordedEventSchema.parse>;

function resultOutcome(record: CleanupResult) {
  return record.data.outcome;
}

function isUnavailable(record: CleanupResult) {
  return record.data.outcome === 'unavailable';
}

function isCompleted(record: CleanupResult) {
  return record.data.outcome === 'completed';
}

function decrypt(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
  return keys.decrypt(identity, value);
}

async function write(memoryId: string, dependsOn: MemoryIdentity[] = [], ownerId = 'alice') {
  const scopeId = memoryScopeId('test', 'person', ownerId);
  const identity: MemoryIdentity = {
    silo: 'test', scopeId, scopeKind: 'person', ownerId, memoryId, revision: 1,
  };
  keys.provision(identity);
  const dependencies = [];
  for (const dependency of dependsOn) {
    dependencies.push({ scopeId, memoryId: dependency.memoryId, revision: dependency.revision });
  }
  const encrypted = keys.encrypt(identity, 'Private remembered text');
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId, memoryId, revision: 1,
    kind: 'fact', pinned: false, expiresAt: null, sources: [], dependsOn: dependencies,
    ...encrypted };
  const record = { ...event(`write-${memoryId}`), subject: `scope-${scopeId}`,
    type: 'memory.written', data };
  await nats.seed([record]);
  return identity;
}

beforeEach(async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
  directory = await mkdtemp('/tmp/memory-cleanup-');
  keys = memoryKeys(directory);
  runner = new ProjectionRunner(storage.db, nats.reader, createLogger('memory-cleanup-test'));
  await runner.initialise(projection);
  root = await write('root');
  child = await write('child', [root]);
  await write('grandchild', [child]);
  independent = await write('independent', [], 'bob');
  await runner.run(projection);
  const data = { schemaVersion: 1, scopeId: root.scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: root.memoryId, expectedRevision: 1, revision: 2 };
  forgotten = { ...event('forget-root'), subject: `scope-${root.scopeId}`,
    type: 'memory.forgotten', data };
  await nats.seed([forgotten]);
});

afterEach(async function cleanup() {
  vi.restoreAllMocks();
  await storage?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function handler() {
  return memoryCleanupHandler(nats.store, keys);
}

async function completions() {
  const saved: CleanupResult[] = [];
  for await (const row of nats.store.readStream(forgotten.subject)) {
    if (row.event.type === 'memory.cleanup_recorded') {
      const record = memoryCleanupRecordedEventSchema.parse(row.event);
      if (record.data.changeId === forgotten.id) saved.push(record);
    }
  }
  return saved;
}

async function queuedCleanup() {
  const reaction = handler();
  const options = { db: storage.db, logger: createLogger('cleanup-runtime-test'),
    silo: 'test', handlers: [reaction] };
  const runtime = new HandlerRuntime(options);
  async function enqueue(transaction: Parameters<typeof reaction.handle>[1]) {
    await runtime.enqueue(reaction, forgotten, transaction);
  }
  async function finished() {
    const result = await storage.db.query(`SELECT event_id FROM handler_receipts
      WHERE handler='cleanup-memory' AND event_id=$1`, [forgotten.id]);
    return result.rows.length === 1;
  }
  try {
    await runtime.start();
    await storage.db.transaction(enqueue);
    await runtime.work(1);
    await until(finished);
  } finally {
    await runtime.stop();
  }
}

it('destroys dependent keys and candidate copies once, then rebuilds without hidden decryption',
  async function complete() {
    const model = vi.spyOn(globalThis, 'fetch');
    model.mockRejectedValue(new Error('Model disabled'));
    expect(dispatcherHandlerNames({ MEMORY_KEY_DIRECTORY: directory })).toContain('cleanup-memory');
    const candidate = { ...root, revision: 2 };
    const keyId = keys.provision(candidate);
    const filename = `${directory}/${keyId.slice(4)}`;
    const pending = `${filename}-pending`;
    await writeFile(pending, await readFile(filename));
    await runner.run(projection);
    await queuedCleanup();
    await storage.db.query('DROP SCHEMA pgboss CASCADE');
    await storage.db.query('DROP TABLE handler_receipts');
    await handler().handle(forgotten, storage.db);
    expect(model).not.toHaveBeenCalled();
    expect(keys.status(root)).toBe('destroyed');
    expect(keys.status(child)).toBe('destroyed');
    const grandchild = { ...root, memoryId: 'grandchild' };
    expect(keys.status(grandchild)).toBe('destroyed');
    expect(keys.status(candidate)).toBe('destroyed');
    expect(keys.status(independent)).toBe('available');
    expect(await readFile(filename)).toHaveLength(0);
    await expect(readFile(pending)).rejects.toThrow();
    expect(await completions()).toHaveLength(1);
    function onlyVisible(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
      if (identity.ownerId === 'alice') throw new Error('Hidden text was decrypted');
      return keys.decrypt(identity, value);
    }
    const replay = memoryProjection({ decrypt: onlyVisible });
    await runner.rebuild(replay);
    expect(await readMemoryFactIds(storage.db, root.silo, root.scopeId)).toEqual([]);
    function provisionAgain() {
      keys.provision(root);
    }
    expect(provisionAgain).toThrow('Memory key destroyed');
  });

it('keeps cleanup pending when the projection is behind or searchable text remains',
  async function indexBoundary() {
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow();
    expect(await completions()).toEqual([]);
    await runner.run(projection);
    await storage.db.query(`UPDATE memory_facts SET search_text='Leftover text'
      WHERE memory_id='child'`);
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow();
    expect(await completions()).toEqual([]);
    await runner.rebuild(projection);
    await handler().handle(forgotten, storage.db);
    expect(await completions()).toHaveLength(1);
  });

it('retries partial key deletion without reporting success or restoring erased keys',
  async function keyBoundary() {
    await runner.run(projection);
    const remove = keys.delete;
    function failChild(identity: MemoryIdentity) {
      if (identity.memoryId === 'child') throw new Error('Deletion unavailable');
      remove(identity);
    }
    const failingKeys = { ...keys, delete: failChild };
    const failing = memoryCleanupHandler(nats.store, failingKeys);
    await expect(failing.handle(forgotten, storage.db)).rejects.toThrow('Deletion unavailable');
    expect(keys.status(root)).toBe('destroyed');
    expect(keys.status(child)).toBe('available');
    expect(await completions()).toEqual([]);
    await handler().handle(forgotten, storage.db);
    expect(keys.status(child)).toBe('destroyed');
    expect(await completions()).toHaveLength(1);
  });

it('refuses missing committed custody rather than treating it as erasure',
  async function missingKey() {
    await runner.run(projection);
    const keyId = keys.provision(child);
    await rm(`${directory}/${keyId.slice(4)}`);
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow('Memory custody unavailable');
    expect(await completions()).toEqual([]);
  });

it('keeps keys erased across append failure and a lost completion reply',
  async function appendBoundary() {
    await runner.run(projection);
    const append = nats.store.append.bind(nats.store);
    const failure = { status: 'unavailable' as const, cause: new Error('Append unavailable') };
    const failing = vi.spyOn(nats.store, 'append');
    failing.mockResolvedValue(failure);
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow();
    expect(keys.status(root)).toBe('destroyed');
    expect(await completions()).toEqual([]);
    async function lostReply(command: Parameters<typeof append>[0]): Promise<never> {
      await append(command);
      throw new Error('Reply lost');
    }
    failing.mockImplementation(lostReply);
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow('Reply lost');
    failing.mockRestore();
    await handler().handle(forgotten, storage.db);
    expect(await completions()).toHaveLength(1);
  });

it('refuses a deletion target that is not the saved tombstone', async function forgedTarget() {
  await runner.run(projection);
  const original = memoryForgottenDataSchema.parse(forgotten.data);
  const data = { ...original, memoryId: 'independent' };
  await expect(handler().handle({ ...forgotten, data }, storage.db)).rejects.toThrow();
  expect(keys.status(independent)).toBe('available');
  expect(await completions()).toEqual([]);
});

it('records one safe unavailable result after exhausted retries, then completes on replay',
  async function exhaustedCleanup() {
    const laterFact = await write('later');
    await runner.run(projection);
    const remove = keys.delete;
    function failChild(identity: MemoryIdentity) {
      if (identity.memoryId === 'child') throw new Error('PRIVATE ERROR /keys/private');
      remove(identity);
    }
    const failingKeys = { ...keys, delete: failChild };
    const reaction = memoryCleanupHandler(nats.store, failingKeys);
    const logger = createLogger('cleanup-exhaustion-test');
    const errors = vi.spyOn(logger, 'error');
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test',
      handlers: [reaction], retryLimit: 0 });
    await runtime.start();
    async function enqueue(transaction: Parameters<typeof reaction.handle>[1]) {
      await runtime.enqueue(reaction, forgotten, transaction);
    }
    await storage.db.transaction(enqueue);
    await runtime.work(1);
    async function unavailable() {
      const results = await completions();
      return results.some(isUnavailable);
    }
    await until(unavailable);
    const failed = (await runtime.deadLetters('cleanup-memory'))[0]!;
    expect(failed).toBeDefined();
    expect((await completions()).map(resultOutcome)).toEqual(['unavailable']);
    await reaction.exhausted?.(forgotten);
    await reaction.exhausted?.(forgotten);
    expect(await completions()).toHaveLength(1);
    const factsBefore = await storage.db.query(
      'SELECT * FROM memory_facts WHERE silo=$1 AND scope_id=$2 ORDER BY memory_id',
      [root.silo, root.scopeId],
    );
    await runner.run(projection);
    const factsAfter = await storage.db.query(
      'SELECT * FROM memory_facts WHERE silo=$1 AND scope_id=$2 ORDER BY memory_id',
      [root.silo, root.scopeId],
    );
    expect(factsAfter.rows).toEqual(factsBefore.rows);
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain(forgotten.id);
    expect(logged).toContain(root.scopeId);
    expect(logged).toContain(failed.id);
    expect(logged).not.toContain('PRIVATE ERROR');
    expect(logged).not.toContain('/keys/private');
    const outputSql = 'SELECT output, source_output FROM pgboss.job ' +
      "WHERE name IN ('cleanup-memory', 'cleanup-memory-dead')";
    const outputs = await storage.db.query(outputSql);
    expect(JSON.stringify(outputs.rows)).not.toContain('PRIVATE ERROR');
    const target = memoryForgottenDataSchema.parse(forgotten.data);
    expect(await readMemoryFactIds(storage.db, root.silo, root.scopeId))
      .toEqual([{ memory_id: laterFact.memoryId }]);
    const later = { ...forgotten, id: 'forget-later', commandId: 'forget-later',
      data: { ...target, memoryId: laterFact.memoryId } };
    await nats.seed([later]);
    async function enqueueLater(transaction: Parameters<typeof reaction.handle>[1]) {
      await runtime.enqueue(reaction, later, transaction);
    }
    await storage.db.transaction(enqueueLater);
    await runner.run(projection);
    const laterReceipt = await storage.db.query(
      "SELECT 1 FROM handler_receipts WHERE handler='cleanup-memory' AND event_id=$1", [later.id],
    );
    expect(laterReceipt.rows).toEqual([]);
    expect(await readMemoryFactIds(storage.db, root.silo, root.scopeId)).toEqual([]);
    expect(await readMemoryFactIds(storage.db, independent.silo, independent.scopeId))
      .toEqual([{ memory_id: 'independent' }]);
    await runtime.stop();
    const repaired = memoryCleanupHandler(nats.store, keys);
    const retry = new HandlerRuntime({ db: storage.db, logger, silo: 'test',
      handlers: [repaired], retryLimit: 0 });
    await retry.start();
    await retry.work(1);
    await retry.replay('cleanup-memory', failed.id);
    async function completed() {
      const results = await completions();
      return results.some(isCompleted);
    }
    await until(completed);
    await retry.stop();
    expect(await repaired.exhausted?.(forgotten)).toBe(false);
    expect(keys.status(child)).toBe('destroyed');
    expect((await completions()).map(resultOutcome))
      .toEqual(['unavailable', 'completed']);
  }, 30_000);

it('does not rebuild completed, legacy or non-person cleanup jobs',
  async function excludedRecovery() {
    await runner.run(projection);
    const checkpoint = await nats.store.head();
    await handler().handle(forgotten, storage.db);
    const legacy = { ...forgotten, id: 'legacy-forget', commandId: 'legacy-forget',
      data: { scopeId: root.scopeId, memoryId: 'root' } };
    const groupScope = memoryScopeId('test', 'group', 'group-one');
    const group = { ...forgotten, id: 'group-forget', commandId: 'group-forget',
      subject: `scope-${groupScope}`, data: { schemaVersion: 1, scopeId: groupScope,
        scopeKind: 'group', ownerId: 'group-one', memoryId: 'one', expectedRevision: 1,
        revision: 2 } };
    await nats.seed([legacy, group]);
    const reaction = handler();
    const logger = createLogger('recovery-filter-test');
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test',
      handlers: [reaction] });
    await runtime.start();
    expect(await recoverMemoryCleanup(runtime, nats.reader, checkpoint)).toBe(0);
    const jobs = await storage.db.query("SELECT id FROM pgboss.job WHERE name='cleanup-memory'");
    expect(jobs.rows).toEqual([]);
    await runtime.stop();
  }, 30_000);

it('converges when two workers report the same exhausted cleanup',
  async function concurrentExhaustion() {
    const reaction = handler();
    async function report() {
      return reaction.exhausted?.(forgotten);
    }
    function succeeded(result: PromiseSettledResult<boolean | undefined>) {
      return result.status === 'fulfilled' && result.value === true;
    }
    const attempts = await Promise.allSettled([report(), report()]);
    expect(attempts.some(succeeded)).toBe(true);
    expect((await completions()).map(resultOutcome)).toEqual(['unavailable']);
  }, 30_000);

it('rebuilds pending cleanup after both job tables are lost without touching keys',
  async function lostJobs() {
    await runner.run(projection);
    const reaction = handler();
    const logger = createLogger('cleanup-recovery-test');
    const options = { db: storage.db, logger, silo: 'test', handlers: [reaction] };
    const first = new HandlerRuntime(options);
    await first.start();
    async function enqueue(transaction: Parameters<typeof reaction.handle>[1]) {
      await first.enqueue(reaction, forgotten, transaction);
    }
    await storage.db.transaction(enqueue);
    await first.stop();
    await storage.db.query('DROP SCHEMA pgboss CASCADE');
    await storage.db.query('DROP TABLE handler_receipts');
    const unrelated = [];
    for (let index = 0; index < 260; index++) {
      unrelated.push(event(`unrelated-${index}`));
    }
    await nats.seed(unrelated);
    const provision = vi.spyOn(keys, 'provision');
    const deletion = vi.spyOn(keys, 'delete');
    const decryption = vi.spyOn(keys, 'decrypt');
    const fetchCall = vi.spyOn(globalThis, 'fetch');
    const reads = vi.spyOn(nats.reader, 'subscribe');
    const restarted = new HandlerRuntime(options);
    await restarted.start();
    await recoverMemoryCleanup(restarted, nats.reader, await nats.store.head());
    expect(provision).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(decryption).not.toHaveBeenCalled();
    expect(fetchCall).not.toHaveBeenCalled();
    const starts = [];
    for (const call of reads.mock.calls) {
      starts.push(call[0]);
    }
    expect(starts).toEqual([1, 257]);
    const jobs = await storage.db.query("SELECT id FROM pgboss.job WHERE name='cleanup-memory'");
    expect(jobs.rows).toHaveLength(1);
    await restarted.work(1);
    async function completed() {
      return (await completions()).length === 1;
    }
    await until(completed);
    await restarted.stop();
    expect((await completions()).map(resultOutcome)).toEqual(['completed']);
  }, 30_000);
