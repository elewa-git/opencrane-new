import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { memoryReferences } from '@opencrane/models';
import { HandlerRuntime, type Handler } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { memoryKeys, memoryProjection, memoryScopeId, memoryErasureHistory, ProjectionRunner,
  readMemoryFactIds } from '@opencrane/projections';
import { memoryCorrectedEventSchema, memoryValueEventSchema,
  type EventEnvelope, type MemoryIdentity }
  from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { memoryCleanupHandler, recoverMemoryCleanup } from '../src/memory-cleanup.ts';
import { scanNightlyMemory } from '../src/nightly-memory.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let storage: Awaited<ReturnType<typeof database>>;
let directory: string;
let keys: ReturnType<typeof memoryKeys>;
let runner: ProjectionRunner;
const scopeId = memoryScopeId('test', 'person', 'alice');
const root: MemoryIdentity = { silo: 'test', scopeId, scopeKind: 'person',
  ownerId: 'alice', memoryId: 'root', revision: 1 };
const logger = createLogger('correction-test');

beforeEach(async function setup() {
  nats = await natsFixture();
  storage = await database('pg');
  directory = await mkdtemp('/tmp/memory-correction-');
  keys = memoryKeys(directory);
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(memoryProjection(keys));
});
afterEach(async function cleanup() {
  vi.restoreAllMocks();
  await storage?.close();
  await nats?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function memoryRecord(memoryId: string, revision = 1,
  dependsOn: { scopeId: string; memoryId: string; revision: number }[] = []) {
  const identity = { ...root, memoryId, revision };
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, `Private ${memoryId} revision ${revision}`);
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId, revision, kind: 'fact', pinned: false, expiresAt: null,
    sources: [{ memberId: 'alice', commandId: 'statement' }], dependsOn, ...encrypted };
  let type = 'memory.written';
  let payload: unknown = data;
  if (revision > 1) {
    type = 'memory.corrected';
    payload = { ...data, expectedRevision: revision - 1,
      supersedes: { memoryId, revision: revision - 1 }, reason: 'human' };
  }
  const record = { ...event(`${memoryId}-${revision}`), type,
    subject: `scope-${scopeId}`, data: payload };
  return record;
}

async function save(memoryId: string, revision = 1,
  dependsOn: { scopeId: string; memoryId: string; revision: number }[] = []) {
  const record = memoryRecord(memoryId, revision, dependsOn);
  await nats.seed([record]);
  return record;
}

const invalidBindings = [
  { ownerId: 'bob' },
  { keyId: `key:${'a'.repeat(64)}` },
];
it.each(invalidBindings)('refuses a correction with an unrelated identity %j before append',
  async function refusedCorrection(patch) {
    await save('root');
    const before = await history();
    const correction = memoryRecord('root', 2);
    const parsed = memoryCorrectedEventSchema.parse(correction);
    const invalid = { ...parsed, data: { ...parsed.data, ...patch } };
    const result = await nats.store.append({ event: invalid, expectedSequence: 1 });
    expect(result).toEqual({ status: 'rejected', reason: 'invalid_event' });
    expect(await history()).toEqual(before);
    expect(await nats.store.head(correction.subject)).toBe(1);
  });

it('appends a correction whose scope, owner and revision key agree', async function validAppend() {
  await save('root');
  const correction = memoryRecord('root', 2);
  const result = await nats.store.append({ event: correction, expectedSequence: 1 });
  expect(result).toEqual({ status: 'appended', sequence: 2 });
  const rows = await history();
  expect(rows).toHaveLength(2);
  expect(rows[1]?.event).toEqual(correction);
});

async function history() {
  const rows = [];
  for await (const row of nats.store.readStream(`scope-${scopeId}`)) {
    rows.push(row);
  }
  return rows;
}

async function correctedChain() {
  await save('source');
  const sources = [{ scopeId, memoryId: 'source', revision: 1 }];
  await save('root', 1, sources);
  await save('root', 2, sources);
  await save('root', 3, sources);
  await save('child', 1, [{ scopeId, memoryId: 'root', revision: 3 }]);
  await save('grandchild', 1, [{ scopeId, memoryId: 'child', revision: 1 }]);
  await runner.run(memoryProjection(keys));
  return save('root', 4, sources);
}

it('publishes only revision four, preserves its links and erases the old dependent chain',
  async function correctedReplay() {
    const correction = await correctedChain();
    await save('fresh-child', 1, [{ scopeId, memoryId: 'root', revision: 4 }]);
    const before = await readdir(directory);
    function visibleOnly(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
      if (identity.memoryId !== 'source' && identity.memoryId !== 'fresh-child' &&
          (identity.memoryId !== 'root' || identity.revision !== 4)) {
        throw new Error('Hidden content was decrypted');
      }
      return keys.decrypt(identity, value);
    }
    const projection = memoryProjection({ decrypt: visibleOnly });
    await runner.run(projection);
    await storage.reopen();
    runner = new ProjectionRunner(storage.db, nats.reader, logger);
    await runner.rebuild(projection);
    expect(await readdir(directory)).toEqual(before);
    const refs = memoryReferences(await history(), 'test', scopeId, keys);
    expect(refs.current({ ...root, revision: 4 })).toBe('current');
    expect(refs.current({ ...root, revision: 3 })).toBe('superseded');
    expect(refs.current({ ...root, memoryId: 'grandchild' })).not.toBe('current');
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    expect(reaction.eventTypes).toContain('memory.corrected');
    await reaction.handle(correction, storage.db);
    await reaction.handle(correction, storage.db);
    expect(keys.status({ ...root, revision: 3 })).toBe('destroyed');
    expect(keys.status({ ...root, revision: 4 })).toBe('available');
    expect(keys.status({ ...root, memoryId: 'child' })).toBe('destroyed');
    expect(keys.status({ ...root, memoryId: 'grandchild' })).toBe('destroyed');
    await runner.rebuild(projection);
    expect(await readMemoryFactIds(storage.db, 'test', scopeId)).toEqual([
      { memory_id: 'source' }, { memory_id: 'root' }, { memory_id: 'fresh-child' },
    ]);
    const result = await storage.db.query(`SELECT revision, sources, search_text
      FROM memory_facts WHERE memory_id='root'`);
    expect(result.rows).toEqual([{ revision: '4',
      sources: [{ memberId: 'alice', commandId: 'statement' }],
      search_text: 'Private root revision 4' }]);
    const sourceChange = await save('source', 2);
    await runner.run(memoryProjection(keys));
    await reaction.handle(sourceChange, storage.db);
    expect(keys.status({ ...root, revision: 4 })).toBe('destroyed');
    expect(keys.status({ ...root, memoryId: 'fresh-child' })).toBe('destroyed');
  });

it('recovers correction cleanup, records exhaustion and keeps later revision keys',
  async function recovery() {
    const correction = await correctedChain();
    await save('root', 5, [{ scopeId, memoryId: 'source', revision: 1 }]);
    const candidate = { ...root, revision: 6 };
    keys.provision(candidate);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    await expect(reaction.handle(correction, storage.db)).rejects.toThrow();
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test', handlers: [reaction] });
    try {
      await runtime.start();
      const checkpoint = await nats.reader.head();
      expect(await recoverMemoryCleanup(runtime, nats.reader, checkpoint)).toBe(4);
      await storage.db.query("UPDATE pgboss.job SET state='failed' " +
        "WHERE name='cleanup-memory' AND data->>'id'=$1", [correction.id]);
      expect(await recoverMemoryCleanup(runtime, nats.reader, checkpoint)).toBe(1);
      await runner.run(memoryProjection(keys));
      await storage.db.query("UPDATE memory_facts SET revision=4 WHERE memory_id='root'");
      await expect(reaction.handle(correction, storage.db)).rejects.toThrow(
        'Superseded memory remains projected');
      await runner.rebuild(memoryProjection(keys));
      await reaction.handle(correction, storage.db);
      expect(keys.status({ ...root, revision: 4 })).toBe('destroyed');
      expect(keys.status({ ...root, revision: 5 })).toBe('available');
      expect(keys.status(candidate)).toBe('available');
      const records = [];
      for (const row of await history()) {
        if (row.event.type === 'memory.cleanup_recorded') records.push(row.event);
      }
      expect(records).toHaveLength(2);
      expect(JSON.stringify(records)).not.toMatch(/Private|ciphertext|keyId/);
    } finally {
      await runtime.stop();
    }
  });

it('keeps a later forget permanent and removes the current and candidate keys',
  async function forgottenAfterCorrection() {
    const correction = await correctedChain();
    const candidate = { ...root, revision: 5 };
    keys.provision(candidate);
    const forgotten: EventEnvelope = { ...event('forget'), subject: `scope-${scopeId}`,
      type: 'memory.forgotten', data: { schemaVersion: 1, scopeId, scopeKind: 'person',
        ownerId: 'alice', memoryId: 'root', expectedRevision: 4, revision: 5 } };
    await nats.seed([forgotten]);
    await runner.run(memoryProjection(keys));
    await memoryCleanupHandler(nats.store, keys, storage.db).handle(correction, storage.db);
    expect(keys.status({ ...root, revision: 4 })).toBe('destroyed');
    expect(keys.status(candidate)).toBe('destroyed');
    await save('root', 6);
    await runner.rebuild(memoryProjection(keys));
    expect(await readMemoryFactIds(storage.db, 'test', scopeId)).toEqual([{ memory_id: 'source' }]);
    const refs = memoryReferences(await history(), 'test', scopeId, 'event-only');
    expect(refs.current({ ...root, revision: 6 })).toBe('erased');
  });


it('selects the current correction for nightly review without opening old text', async function night() {
  const binding: EventEnvelope = { ...event('binding'), subject: `scope-${scopeId}`,
    source: 'opencrane-server', principal: { kind: 'human', id: 'alice' },
    type: 'memory.maintenance_bound', data: { scopeId, scopeKind: 'person', ownerId: 'alice',
      memberId: 'alice', assistantId: 'assistant', payingGroupId: 'team', enabled: true,
      acceptedCapCents: 100, revision: 1 } };
  await nats.seed([binding]);
  await correctedChain();
  await runner.run(memoryProjection(keys));
  function clock() {
    return new Date('2027-01-01T02:01:00Z');
  }
  await scanNightlyMemory(storage.db, nats.store, 'test', clock(), clock);
  const rows = await history();
  expect(rows.at(-1)?.event.data).toMatchObject({
    inputRefs: [{ memoryId: 'source', revision: 1 }, { memoryId: 'root', revision: 4 }],
  });
});

it('retains the greatest replaced revision when corrections arrive out of order',
  async function reorderedCorrections() {
    await save('root');
    await save('root', 4);
    await save('root', 2);
    await save('child', 1, [{ scopeId, memoryId: 'root', revision: 3 }]);
    const erasure = await memoryErasureHistory(await history());
    expect(erasure.superseded('test', scopeId).get('root')).toBe(3);
    expect(erasure.hidden('test', scopeId)).toEqual(new Set(['child']));
  });

it('closes the candidate after the greatest hidden revision in reordered history',
  async function reorderedHiddenRevisions() {
    const correction = await save('root', 4);
    await save('root', 2);
    const candidate = { ...root, revision: 5 };
    keys.provision(candidate);
    const forgotten = { ...event('forget-root'), subject: `scope-${scopeId}`,
      type: 'memory.forgotten', data: { schemaVersion: 1, scopeId, scopeKind: 'person',
        ownerId: 'alice', memoryId: 'root', expectedRevision: 4, revision: 5 } };
    await nats.seed([forgotten]);
    await runner.run(memoryProjection(keys));
    await memoryCleanupHandler(nats.store, keys, storage.db).handle(correction, storage.db);
    expect(keys.status(candidate)).toBe('destroyed');
  });

function completion(changeId: string) {
  const id = 'cleanup-result';
  return { ...event(id), source: 'opencrane-worker', subject: `scope-${scopeId}`,
    principal: { kind: 'system' as const, id: 'opencrane-worker' },
    type: 'memory.cleanup_recorded', data: { schemaVersion: 1, scopeId, scopeKind: 'person',
      ownerId: 'alice', changeId, outcome: 'completed' } };
}

const unrelatedCompletions = [
  { changeId: 'another-change' },
  { scopeId: memoryScopeId('test', 'person', 'bob') },
  { scopeKind: 'group' },
  { ownerId: 'bob' },
  { outcome: 'unavailable', failureCode: 'retry_exhausted' },
];
it.each(unrelatedCompletions)('keeps cleanup pending for an unrelated completion %j',
  async function unrelatedCompletion(patch) {
    await save('root');
    const correction = await save('root', 2);
    const record = completion(correction.id);
    const data = { ...record.data, ...patch };
    await nats.seed([{ ...record, subject: `scope-${data.scopeId}`, data }]);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test', handlers: [reaction] });
    try {
      await runtime.start();
      expect(await recoverMemoryCleanup(runtime, nats.reader, 2)).toBe(1);
    } finally {
      await runtime.stop();
    }
    await expect(reaction.handle(correction, storage.db))
      .rejects.toThrow('Memory projection is behind cleanup');
  });

it.each([{ silo: 'other' }, { subject: 'scope-other' }])(
  'refuses foreign cleanup history %j before deleting keys', async function foreignHistory(patch) {
    await save('root');
    const correction = await save('root', 2);
    const rows = await history();
    const foreign = { ...rows[0]!, event: { ...rows[0]!.event, ...patch } };
    async function* damagedHistory() {
      yield foreign;
      for await (const row of nats.reader.readStream(correction.subject, 2)) {
        yield row;
      }
    }
    vi.spyOn(nats.store, 'readStream').mockImplementation(damagedHistory);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    await expect(reaction.handle(correction, storage.db))
      .rejects.toThrow('Unsupported memory cleanup history');
    expect(keys.status(root)).toBe('available');
  });

it('refuses cleanup when a legacy value has no recorded ownership', async function legacyValue() {
  await save('root');
  const legacy = { ...event('legacy'), subject: `scope-${scopeId}`, type: 'memory.written',
    data: { scopeId, memoryId: 'legacy', ciphertext: 'ZmFrZS1jaXBoZXJ0ZXh0', keyId: 'key:old' } };
  await nats.seed([legacy]);
  const correction = await save('root', 2);
  await runner.run(memoryProjection(keys));
  await expect(memoryCleanupHandler(nats.store, keys, storage.db).handle(correction, storage.db))
    .rejects.toThrow('Memory cleanup requires recorded ownership');
  expect(keys.status(root)).toBe('available');
});

it('refuses completion when key deletion returns without a permanent marker',
  async function missingDeletionMarker() {
    await save('root');
    const correction = await save('root', 2);
    await runner.run(memoryProjection(keys));
    function noDeletion() {}
    const failedKeys = { ...keys, delete: noDeletion };
    await expect(memoryCleanupHandler(nats.store, failedKeys, storage.db).handle(correction, storage.db))
      .rejects.toThrow('Memory deletion was not verified');
    expect(keys.status(root)).toBe('available');
    expect(await nats.store.head()).toBe(2);
  });

const remainingSearchData = [
  "content_status='available'",
  "search_text='leftover'",
  "search_vector=to_tsvector('simple', 'leftover')",
  "ciphertext='leftover'",
  "key_id='leftover'",
];
it.each(remainingSearchData)('refuses correction cleanup while a hidden row retains %s',
  async function incompleteSearchRemoval(assignment) {
    const correction = await correctedChain();
    await runner.run(memoryProjection(keys));
    await storage.db.query(`UPDATE memory_facts SET ${assignment} WHERE memory_id='child'`);
    const sequence = await nats.store.head();
    await expect(memoryCleanupHandler(nats.store, keys, storage.db).handle(correction, storage.db))
      .rejects.toThrow('Memory search removal was not verified');
    expect(await nats.store.head()).toBe(sequence);
  });

it('refuses completion when an affected projected row is missing', async function missingRow() {
  const correction = await correctedChain();
  await runner.run(memoryProjection(keys));
  await storage.db.query("DELETE FROM memory_facts WHERE memory_id='child'");
  const sequence = await nats.store.head();
  await expect(memoryCleanupHandler(nats.store, keys, storage.db).handle(correction, storage.db))
    .rejects.toThrow('Memory removal has not been projected');
  expect(await nats.store.head()).toBe(sequence);
});

it.each(['checkpoint', 'silo'])('refuses recovery with an invalid %s',
  async function invalidRecovery(boundary) {
    await save('root');
    await save('root', 2);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    let silo = 'test';
    let checkpoint = 3;
    let message = 'Cleanup recovery checkpoint exceeds history';
    if (boundary === 'silo') {
      silo = 'other';
      checkpoint = 2;
      message = 'Cleanup recovery silo mismatch';
    }
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo, handlers: [reaction] });
    try {
      await runtime.start();
      await expect(recoverMemoryCleanup(runtime, nats.reader, checkpoint)).rejects.toThrow(message);
      expect(await runtime.deadLetters('cleanup-memory')).toEqual([]);
      expect(await nats.store.head()).toBe(2);
    } finally {
      await runtime.stop();
    }
  });

const invalidOriginals = ['handler', 'type', 'silo', 'absent', 'not-failed', 'altered', 'callback'];
it.each(invalidOriginals)('refuses an exhaustion report with an invalid %s',
  async function invalidOriginal(boundary) {
    await save('root');
    const correction = await save('root', 2);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test', handlers: [reaction] });
    async function enqueue(tx: Parameters<typeof reaction.handle>[1]) {
      await runtime.enqueue(reaction, correction, tx);
    }
    try {
      await runtime.start();
      await storage.db.transaction(enqueue);
      const jobs = await storage.db.query<{ id: string }>(
        "SELECT id FROM pgboss.job WHERE name='cleanup-memory'");
      const jobId = jobs.rows[0]!.id;
      await storage.db.query("UPDATE pgboss.job SET state='failed' WHERE id=$1", [jobId]);
      let reported = correction;
      let handler: Handler = { ...reaction };
      if (boundary === 'handler') handler = { ...reaction, name: 'update-members' };
      if (boundary === 'type') reported = { ...correction, type: 'member.joined' };
      if (boundary === 'silo') reported = { ...correction, silo: 'other' };
      if (boundary === 'absent') {
        await storage.db.query('DELETE FROM pgboss.job WHERE id=$1', [jobId]);
      }
      if (boundary === 'not-failed') {
        await storage.db.query("UPDATE pgboss.job SET state='created' WHERE id=$1", [jobId]);
      }
      if (boundary === 'altered') reported = { ...correction, time: '2026-10-18T00:00:00Z' };
      if (boundary === 'callback') {
        delete handler.exhausted;
      }
      const result = runtime.reportFailedOriginal(handler, reported, jobId);
      if (boundary === 'handler' || boundary === 'type' || boundary === 'silo') {
        await expect(result).rejects.toThrow('Invalid cleanup original');
      } else if (boundary === 'callback') {
        await expect(result).rejects.toThrow('Cleanup exhaustion handler missing');
      } else {
        await expect(result).resolves.toBe(false);
      }
      expect(await nats.store.head()).toBe(2);
    } finally {
      await runtime.stop();
    }
  });

it('ignores duplicate correction delivery without adding a second change',
  async function duplicateCorrection() {
    await save('root');
    const correction = await save('root', 2);
    async function head() {
      const sequence = await nats.reader.head();
      return sequence + 1;
    }
    async function* subscribe(fromSequence: number) {
      for await (const row of nats.reader.readStream(correction.subject, fromSequence)) {
        yield row;
      }
      if (fromSequence <= 3) yield { sequence: 3, event: correction };
    }
    const source = { head, subscribe };
    const replay = new ProjectionRunner(storage.db, source, logger);
    const projection = memoryProjection(keys);
    await replay.run(projection);
    expect(await replay.checkpoint(projection)).toBe(3);
    const changes = await storage.db.query(
      'SELECT position FROM memory_changes WHERE change_id=$1', [correction.id]);
    expect(changes.rows).toEqual([{ position: '2' }]);
    expect(await readMemoryFactIds(storage.db, 'test', scopeId)).toEqual([{ memory_id: 'root' }]);
  });

it('reuses saved cleanup after a lost reply and preserves another owner with the same memory id',
  async function lostReplyAndOtherOwner() {
    const original = await save('root');
    const otherScope = memoryScopeId('test', 'person', 'bob');
    const other = { ...root, scopeId: otherScope, ownerId: 'bob' };
    keys.provision(other);
    const encrypted = keys.encrypt(other, 'Private Bob root');
    const data = { ...memoryValueEventSchema.parse(original).data,
      scopeId: otherScope, ownerId: 'bob', ...encrypted };
    const otherEvent = { ...original, id: 'bob-root', commandId: 'bob-root',
      subject: `scope-${otherScope}`, data };
    await nats.seed([otherEvent]);
    const correction = await save('root', 2);
    await runner.run(memoryProjection(keys));
    const append = nats.store.append.bind(nats.store);
    async function lostReply(command: Parameters<typeof append>[0]): Promise<never> {
      const result = await append(command);
      expect(result.status).toBe('appended');
      throw new Error('Reply lost');
    }
    const failing = vi.spyOn(nats.store, 'append');
    failing.mockImplementation(lostReply);
    const reaction = memoryCleanupHandler(nats.store, keys, storage.db);
    await expect(reaction.handle(correction, storage.db)).rejects.toThrow('Reply lost');
    failing.mockRestore();
    const sequence = await nats.store.head();
    await reaction.handle(correction, storage.db);
    expect(await nats.store.head()).toBe(sequence);
    expect(keys.status(root)).toBe('destroyed');
    expect(keys.status({ ...root, revision: 2 })).toBe('available');
    expect(keys.status(other)).toBe('available');
    expect(await readMemoryFactIds(storage.db, 'test', otherScope)).toEqual([{ memory_id: 'root' }]);
    expect(keys.decrypt(other, encrypted)).toBe('Private Bob root');
  });
