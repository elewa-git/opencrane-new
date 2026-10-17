import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { memoryReferences } from '@opencrane/models';
import { HandlerRuntime } from '@opencrane/handlers';
import { createLogger } from '@opencrane/observability';
import { memoryKeys, memoryProjection, memoryScopeId, ProjectionRunner,
  readMemoryFactIds } from '@opencrane/projections';
import type { EventEnvelope, MemoryIdentity } from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { memoryCleanupHandler, recoverMemoryCleanup } from '../src/memory-cleanup.ts';

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

async function save(memoryId: string, revision = 1,
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
  await nats.seed([record]);
  return record;
}

async function history() {
  const rows = [];
  for await (const row of nats.store.readStream(`scope-${scopeId}`)) rows.push(row);
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
    const before = await readdir(directory);
    function visibleOnly(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
      if (identity.memoryId !== 'source' &&
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
    const reaction = memoryCleanupHandler(nats.store, keys);
    expect(reaction.eventTypes).toContain('memory.corrected');
    await reaction.handle(correction, storage.db);
    await reaction.handle(correction, storage.db);
    expect(keys.status({ ...root, revision: 3 })).toBe('destroyed');
    expect(keys.status({ ...root, revision: 4 })).toBe('available');
    expect(keys.status({ ...root, memoryId: 'child' })).toBe('destroyed');
    expect(keys.status({ ...root, memoryId: 'grandchild' })).toBe('destroyed');
    await runner.rebuild(projection);
    expect(await readMemoryFactIds(storage.db, 'test', scopeId)).toEqual([
      { memory_id: 'source' }, { memory_id: 'root' },
    ]);
    const result = await storage.db.query(`SELECT revision, sources, search_text
      FROM memory_facts WHERE memory_id='root'`);
    expect(result.rows).toEqual([{ revision: '4',
      sources: [{ memberId: 'alice', commandId: 'statement' }],
      search_text: 'Private root revision 4' }]);
  });

it('recovers correction cleanup, records exhaustion and keeps later revision keys',
  async function recovery() {
    const correction = await correctedChain();
    await save('root', 5, [{ scopeId, memoryId: 'source', revision: 1 }]);
    const candidate = { ...root, revision: 6 };
    keys.provision(candidate);
    const reaction = memoryCleanupHandler(nats.store, keys);
    await expect(reaction.handle(correction, storage.db)).rejects.toThrow();
    const runtime = new HandlerRuntime({ db: storage.db, logger, silo: 'test', handlers: [reaction] });
    try {
      await runtime.start();
      const checkpoint = await nats.reader.head();
      expect(await recoverMemoryCleanup(runtime, nats.reader, checkpoint)).toBe(4);
      await storage.db.query("UPDATE pgboss.job SET state='failed' WHERE name='cleanup-memory'");
      expect(await recoverMemoryCleanup(runtime, nats.reader, checkpoint)).toBe(0);
      await runner.run(memoryProjection(keys));
      await reaction.handle(correction, storage.db);
      expect(keys.status({ ...root, revision: 4 })).toBe('destroyed');
      expect(keys.status({ ...root, revision: 5 })).toBe('available');
      expect(keys.status(candidate)).toBe('available');
      const records = [];
      for (const row of await history()) {
        if (row.event.type === 'memory.cleanup_recorded') records.push(row.event);
      }
      expect(records).toHaveLength(5);
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
    await memoryCleanupHandler(nats.store, keys).handle(correction, storage.db);
    expect(keys.status({ ...root, revision: 4 })).toBe('destroyed');
    expect(keys.status(candidate)).toBe('destroyed');
    await save('root', 6);
    await runner.rebuild(memoryProjection(keys));
    expect(await readMemoryFactIds(storage.db, 'test', scopeId)).toEqual([{ memory_id: 'source' }]);
    const refs = memoryReferences(await history(), 'test', scopeId, 'event-only');
    expect(refs.current({ ...root, revision: 6 })).toBe('erased');
  });
