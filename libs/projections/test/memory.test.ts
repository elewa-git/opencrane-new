import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEventAt } from '@opencrane/event-store';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import {
  getEventDefinition, memoryWrittenEventSchema, type EventEnvelope, type MemoryIdentity,
} from '@opencrane/events';
import {
  memoryKeys, memoryProjection, memoryScopeId, ProjectionRunner, readMemoryFactIds,
} from '../src/index.ts';
import type { Db, Projection, Query } from '../src/index.ts';
import { database } from './database.ts';

const execute = promisify(execFile);
const logger = createLogger('memory-test');

describe.skipIf(!process.env['PG_TEST_URL'])('memory with PostgreSQL and NATS', () => {
  let nats: Awaited<ReturnType<typeof natsFixture>>;
  let storage: Awaited<ReturnType<typeof database>>;
  let directory: string;
  let keys: ReturnType<typeof memoryKeys>;
  let projection: Projection;
  let runner: ProjectionRunner;
  const positions = new Map<string, number>();

  beforeEach(async function setUp() {
    nats = await natsFixture();
    storage = await database('pg');
    directory = await mkdtemp('/tmp/memory-projection-');
    keys = memoryKeys(directory);
    const custody = { decrypt: keys.decrypt };
    projection = memoryProjection(custody);
    runner = new ProjectionRunner(storage.db, nats.reader, logger);
    positions.clear();
    await runner.initialise(projection);
  });
  afterEach(async function cleanUp() {
    await storage.close();
    await nats.close();
    await rm(directory, { recursive: true, force: true });
    await rm(`${directory}-away`, { recursive: true, force: true });
  });

  async function append(
    memoryId: string, ownerId = 'alice', text = 'Deliveries café 東京',
    dependsOn: { scopeId: string; memoryId: string; revision: number }[] = [],
  ) {
    const scopeId = memoryScopeId('test', 'person', ownerId);
    const identity: MemoryIdentity = {
      silo: 'test', scopeId, scopeKind: 'person', ownerId, memoryId, revision: 1,
    };
    keys.provision(identity);
    const encrypted = keys.encrypt(identity, text);
    const data = {
      schemaVersion: 1, ...identity, kind: 'fact', pinned: false, expiresAt: null,
      sources: [{ memberId: ownerId, commandId: memoryId }], dependsOn, ...encrypted,
    };
    // Keep silo in the envelope, as required by the saved event contract.
    const { silo: _silo, ...payload } = data;
    const envelope = { ...event(memoryId), subject: `scope-${scopeId}`,
      type: 'memory.written', data: payload };
    const expectedSequence = positions.get(scopeId) ?? 0;
    const result = await nats.store.append({ event: envelope, expectedSequence });
    expect(result.status).toBe('appended');
    if (result.status !== 'appended') {
      throw new Error('Fixture append failed');
    }
    positions.set(scopeId, result.sequence);
    return identity;
  }


  async function tombstone(identity: MemoryIdentity, changeId = 'forget-first') {
    const { silo: _silo, ...fields } = identity;
    const data = { schemaVersion: 1, ...fields, expectedRevision: 1, revision: 2 };
    const envelope = { ...event(changeId), type: 'memory.forgotten',
      subject: `scope-${identity.scopeId}`, data };
    await nats.seed([envelope]);
  }

  async function hiddenRows() {
    const result = await storage.db.query(`SELECT memory_id, content_status,
      search_text, search_vector FROM memory_facts ORDER BY memory_id`);
    return result.rows;
  }

  it('restarts and rebuilds pending erasure without decrypting hidden text or changing keys',
    async function pendingErasure() {
      const root = await append('root');
      const source = [{ scopeId: root.scopeId, memoryId: root.memoryId, revision: 1 }];
      const child = await append('child', 'alice', 'Derived private text', source);
      const childSource = [{ scopeId: child.scopeId, memoryId: child.memoryId, revision: 1 }];
      await append('grandchild', 'alice', 'Another private copy', childSource);
      await append('unrelated', 'bob', 'Independent text');
      await tombstone(root);
      const files = await readdir(directory);
      function decryptVisible(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
        if (identity.ownerId === 'alice') {
          throw new Error('Hidden text must never be decrypted');
        }
        return keys.decrypt(identity, value);
      }
      const pending = memoryProjection({ decrypt: decryptVisible });
      await runner.run(pending);
      const expected = [
        { memory_id: 'child', content_status: 'erased', search_text: null, search_vector: null },
        { memory_id: 'grandchild', content_status: 'erased', search_text: null, search_vector: null },
        { memory_id: 'root', content_status: 'erased', search_text: null, search_vector: null },
        expect.objectContaining({ memory_id: 'unrelated', search_text: 'Independent text' }),
      ];
      expect(await hiddenRows()).toEqual(expected);
      expect(await readMemoryFactIds(storage.db, root.silo, root.scopeId)).toEqual([]);
      await storage.reopen();
      runner = new ProjectionRunner(storage.db, nats.reader, logger);
      await runner.rebuild(pending);
      expect(await hiddenRows()).toEqual(expected);
      expect(await readdir(directory)).toEqual(files);
      expect(keys.status(root)).toBe('available');
    });

  it('removes root and dependent search text atomically, then recovers after an index failure',
    async function erasureRollback() {
      const root = await append('root');
      const source = [{ scopeId: root.scopeId, memoryId: root.memoryId, revision: 1 }];
      await append('child', 'alice', 'Private copy', source);
      await runner.run(projection);
      const before = await state();
      await tombstone(root);
      async function prepare(envelope: EventEnvelope) {
        const apply = await projection.prepare!(envelope);
        async function fail(tx: Query, saved: EventEnvelope, position: number) {
          await apply(tx, saved, position);
          throw new Error('Injected index failure');
        }
        return fail;
      }
      const failing = { ...projection, prepare };
      await expect(runner.run(failing)).rejects.toThrow('Injected index failure');
      expect(await state()).toEqual(before);
      expect(await runner.checkpoint(projection)).toBe(2);
      await runner.run(projection);
      expect(await hiddenRows()).toEqual([
        { memory_id: 'child', content_status: 'erased', search_text: null, search_vector: null },
        { memory_id: 'root', content_status: 'erased', search_text: null, search_vector: null },
      ]);
      const changes = (await state()).changes;
      expect(changes).toContainEqual(expect.objectContaining({ outcome: 'forgotten', revision: '2' }));
      expect(JSON.stringify(changes)).not.toContain('Private');
    });

  it('keeps tombstones permanent across duplicate delivery and later writes with historical links',
    async function noResurrection() {
      const root = await append('root');
      const source = [{ scopeId: root.scopeId, memoryId: root.memoryId, revision: 1 }];
      await append('child', 'alice', 'Private copy', source);
      await runner.run(projection);
      await tombstone(root);
      await tombstone(root);
      const original = await readEventAt(nats.reader, `scope-${root.scopeId}`, 1, Infinity);
      const child = await readEventAt(nats.reader, `scope-${root.scopeId}`, 2, Infinity);
      const savedChild = memoryWrittenEventSchema.parse(child!.event);
      const changedChild = { ...savedChild, id: 'child-again', commandId: 'child-again',
        data: { ...savedChild.data, dependsOn: [] } };
      const laterRoot = { ...original!.event, id: 'root-again', commandId: 'root-again' };
      await nats.seed([laterRoot, changedChild]);
      await runner.run(projection);
      expect(await readMemoryFactIds(storage.db, root.silo, root.scopeId)).toEqual([]);
      const before = await state();
      await runner.rebuild(projection);
      expect(await state()).toEqual(before);
      expect(before.dependencies).toContainEqual(expect.objectContaining({
        memory_id: 'child', dependency_id: 'root',
      }));
    });

  it('quarantines earlier control text without stopping replay', async function controls() {
    await append('old-controls');
    function decrypt() {
      return 'Before\u0001after';
    }
    const earlier = memoryProjection({ decrypt });
    await runner.run(earlier);
    expect(await runner.checkpoint(earlier)).toBe(1);
    const rows = await storage.db.query(
      'SELECT content_status, search_text, search_vector FROM memory_facts');
    expect(rows.rows).toEqual([
      { content_status: 'quarantined', search_text: null, search_vector: null },
    ]);
    await runner.rebuild(earlier);
    expect(await runner.checkpoint(earlier)).toBe(1);
    const rebuilt = await storage.db.query(
      'SELECT content_status, search_text, search_vector FROM memory_facts');
    expect(rebuilt.rows).toEqual(rows.rows);
  });

  async function state() {
    const facts = await storage.db.query('SELECT * FROM memory_facts ORDER BY silo, scope_id, position');
    const dependencies = await storage.db.query('SELECT * FROM memory_dependencies ORDER BY memory_id');
    const changes = await storage.db.query('SELECT * FROM memory_changes ORDER BY position');
    const indexes = await storage.db.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'memory_%' ORDER BY indexname",
    );
    return { facts: facts.rows, dependencies: dependencies.rows, changes: changes.rows,
      indexes: indexes.rows };
  }

  it('rebuilds identical current rows, search indexes and scope-local order without key writes',
    async function rebuild() {
      const first = await append('first');
      await append('foreign', 'bob', 'Private banana');
      const dependencies = [{ scopeId: first.scopeId, memoryId: 'first', revision: 1 }];
      await append('last', 'alice', 'Deliveries café 東京', dependencies);
      await runner.run(projection);
      const before = await state();
      expect(before.facts).toHaveLength(3);
      expect(before.changes).toHaveLength(3);
      expect(before.dependencies).toEqual([{ silo: 'test', scope_id: first.scopeId,
        memory_id: 'last', revision: '1', dependency_id: 'first', dependency_revision: '1' }]);
      const metadata = await storage.db.query(`SELECT owner_id, revision, kind, pinned,
        expires_at, sources, content_status FROM memory_facts WHERE memory_id = 'first'`);
      expect(metadata.rows).toEqual([{ owner_id: 'alice', revision: '1', kind: 'fact',
        pinned: false, expires_at: null, sources: [{ memberId: 'alice', commandId: 'first' }],
        content_status: 'available' }]);
      expect(JSON.stringify(before.changes)).not.toContain('ciphertext');
      expect(JSON.stringify(before.changes)).not.toContain('Deliveries');
      const scopeParameters = [first.silo, first.scopeId];
      const ordered = await readMemoryFactIds(storage.db, first.silo, first.scopeId);
      expect(ordered).toEqual([{ memory_id: 'first' }, { memory_id: 'last' }]);
      const search = await storage.db.query(`SELECT memory_id FROM memory_facts
        WHERE silo = $1 AND scope_id = $2 AND search_vector @@ to_tsquery('simple', $3)
        ORDER BY position`, [...scopeParameters, 'deliver:* & café']);
      expect(search.rows).toEqual(ordered);
      const excluded = await readMemoryFactIds(storage.db, first.silo, first.scopeId, 'banana');
      expect(excluded).toEqual([]);
      expect(await readMemoryFactIds(storage.db, 'other', first.scopeId)).toEqual([]);
      const bobScope = memoryScopeId('test', 'person', 'bob');
      expect(await readMemoryFactIds(storage.db, 'test', bobScope, 'banana'))
        .toEqual([{ memory_id: 'foreign' }]);
      const indexResult = await storage.db.query<{ indexdef: string }>(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'memory_facts_search'",
      );
      expect(indexResult.rows[0]?.indexdef).toContain('USING gin');
      expect(before.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ indexname: 'memory_facts_order' }),
        expect.objectContaining({ indexname: 'memory_facts_pkey' }),
      ]));
      const keyFiles = await readdir(directory);
      await storage.reopen();
      const databaseName = await storage.db.query('SELECT current_database() AS name');
      const url = new URL(process.env['PG_TEST_URL']!);
      url.pathname = `/${String(databaseName.rows[0]?.['name'])}`;
      const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: url.href,
        MEMORY_KEY_DIRECTORY: directory };
      const args = ['--experimental-strip-types', 'apps/ops/src/replay.ts', 'memory'];
      await expect(execute(process.execPath, args, { env })).rejects.toThrow('stop');
      const confirmedArgs = [...args, '--confirm-memory-stopped'];
      const output = await execute(process.execPath, confirmedArgs, { env });
      expect(output.stdout).toContain('PASS: memory rebuilt through event 3');
      expect(await state()).toEqual(before);
      const rebuiltSearch = await storage.db.query(`SELECT memory_id FROM memory_facts
        WHERE silo = $1 AND scope_id = $2 AND search_vector @@ to_tsquery('simple', $3)
        ORDER BY position`, [...scopeParameters, 'deliver:* & café']);
      expect(rebuiltSearch.rows).toEqual(search.rows);
      expect(await readdir(directory)).toEqual(keyFiles);
      runner = new ProjectionRunner(storage.db, nats.reader, logger);
      expect(await runner.checkpoint(projection)).toBe(3);
    });

  it('rolls back rows, processed id and checkpoint after a failure during application',
    async function rollback() {
      const first = await append('first');
      await runner.run(projection);
      const before = await state();
      const dependency = [{ scopeId: first.scopeId, memoryId: 'first', revision: 1 }];
      await append('second', 'alice', 'Deliveries café 東京', dependency);
      async function prepare(envelope: EventEnvelope) {
        const apply = await projection.prepare!(envelope);
        async function fail(tx: Query, event: EventEnvelope, position: number) {
          await apply(tx, event, position);
          throw new Error('Injected crash after memory writes');
        }
        return fail;
      }
      const crashing = { ...projection, prepare };
      await expect(runner.run(crashing)).rejects.toThrow('Injected crash');
      expect(await state()).toEqual(before);
      expect(await runner.checkpoint(projection)).toBe(1);
      const processed = await storage.db.query(
        "SELECT event_id FROM projection_events WHERE projection = 'memory' ORDER BY event_id",
      );
      expect(processed.rows).toEqual([{ event_id: 'first' }]);
      await storage.reopen();
      runner = new ProjectionRunner(storage.db, nats.reader, logger);
      await runner.run(projection, { attempt: 2 });
      expect(await runner.checkpoint(projection)).toBe(2);
    });

  it('keeps destroyed text unavailable and stops before a transaction on transient custody failure',
    async function custody() {
      const destroyed = await append('destroyed');
      keys.delete(destroyed);
      await runner.run(projection);
      const unavailable = await storage.db.query(
        'SELECT content_status, search_text, search_vector FROM memory_facts',
      );
      expect(unavailable.rows).toEqual([
        { content_status: 'unavailable', search_text: null, search_vector: null },
      ]);
      const live = await append('live');
      const encrypted = keys.encrypt(live, 'fixture');
      const keyPath = `${directory}/${encrypted.keyId.slice(4)}`;
      await rename(keyPath, `${keyPath}-away`);
      await expect(runner.run(projection)).rejects.toThrow('Memory key store unavailable');
      expect(await runner.checkpoint(projection)).toBe(1);
      await rename(`${keyPath}-away`, keyPath);
      await rename(directory, `${directory}-away`);
      let transactions = 0;
      const original = storage.db;
      async function transaction<Result>(work: (tx: Query) => Promise<Result>) {
        transactions += 1;
        return original.transaction(work);
      }
      const observed: Db = { query: original.query.bind(original), transaction };
      const stopped = new ProjectionRunner(observed, nats.reader, logger);
      await expect(stopped.run(projection)).rejects.toThrow('Memory key store unavailable');
      expect(transactions).toBe(0);
      expect(await runner.checkpoint(projection)).toBe(1);
      await rename(`${directory}-away`, directory);
      await runner.run(projection);
      await runner.rebuild(projection);
      expect(await runner.checkpoint(projection)).toBe(2);
      const rows = await storage.db.query(
        'SELECT memory_id, search_text FROM memory_facts ORDER BY position',
      );
      expect(rows.rows).toEqual([
        { memory_id: 'destroyed', search_text: null },
        { memory_id: 'live', search_text: 'Deliveries café 東京' },
      ]);
    });

  it('quarantines legacy ciphertext without guessing its owner or creating a key',
    async function legacy() {
      const data = { scopeId: 'old', memoryId: 'legacy', ciphertext: 'AAAAAAAAAAAAAAAAAAAA',
        keyId: 'key:old' };
      const envelope = { ...event('legacy'), type: 'memory.written', subject: 'scope-old', data };
      await nats.seed([envelope]);
      await runner.run(projection);
      const rows = await storage.db.query(`SELECT scope_kind, owner_id, revision, ciphertext,
        key_id, content_status, search_text, search_vector FROM memory_facts`);
      expect(rows.rows).toEqual([{ scope_kind: null, owner_id: null, revision: null,
        ciphertext: data.ciphertext, key_id: 'key:old', content_status: 'quarantined',
        search_text: null, search_vector: null }]);
      await runner.rebuild(projection);
      expect((await state()).changes).toEqual([
        expect.objectContaining({ outcome: 'quarantined' }),
      ]);
      expect(await readdir(directory)).toEqual([]);
      expect(await runner.checkpoint(projection)).toBe(1);
    });

  it.each(['memory.corrected', 'memory.forgotten', 'memory.consolidated'])(
    '%s stops replay without changing rows or the checkpoint', async function unsupported(type) {
      await append('first');
      await runner.run(projection);
      const before = await state();
      const saved = event('unsupported');
      const definition = getEventDefinition(type)!;
      const envelope = { ...saved, type, subject: 'scope-old', data: definition.example };
      await nats.seed([envelope]);
      await expect(runner.run(projection)).rejects.toThrow('Memory change is not supported');
      expect(await state()).toEqual(before);
      expect(await runner.checkpoint(projection)).toBe(1);
    });

  it('refuses direct application before writing any rows', async function direct() {
    await expect(projection.apply(storage.db, event('direct'), 1))
      .rejects.toThrow('requires ProjectionRunner preparation');
    expect((await state()).facts).toEqual([]);
    expect(await runner.checkpoint(projection)).toBe(0);
  });

  it.each(['invalid', 'dependencies', 'key', 'damaged', 'tag'])(
    '%s stops preparation without a transaction or checkpoint advance', async function refused(kind) {
      const identity = await append('first');
      const saved = await readEventAt(nats.reader, `scope-${identity.scopeId}`, 1, Infinity);
      const original = memoryWrittenEventSchema.parse(saved!.event);
      const encrypted = keys.encrypt(identity, 'private fixture text');
      const dependency = { scopeId: identity.scopeId, memoryId: 'parent', revision: 1 };
      const data: Record<string, unknown> = { ...original.data };
      let message = 'Invalid saved memory event';
      if (kind === 'invalid') {
        data['pinned'] = 'invalid';
      } else if (kind === 'dependencies') {
        data['dependsOn'] = [dependency, dependency];
      } else if (kind === 'key') {
        data['keyId'] = `key:${'b'.repeat(64)}`;
        message = 'Memory key identity mismatch';
      } else if (kind === 'damaged') {
        await writeFile(`${directory}/${encrypted.keyId.slice(4)}`, Buffer.alloc(31));
        message = 'Memory key store damaged';
      } else {
        const bytes = Buffer.from(String(data['ciphertext']), 'base64');
        bytes[12] = bytes[12]! ^ 1;
        data['ciphertext'] = bytes.toString('base64');
        message = 'authenticate';
      }
      const envelope = { ...original, data };
      // Supply raw saved input to exercise the projection's own checks before any SQL work.
      const source = {
        head: () => Promise.resolve(1),
        async *subscribe() {
          await Promise.resolve();
          yield { event: envelope, sequence: 1 };
        },
      };
      const before = await state();
      let transactions = 0;
      const originalDb = storage.db;
      async function transaction<Result>(work: (tx: Query) => Promise<Result>) {
        transactions += 1;
        return originalDb.transaction(work);
      }
      const observed = { query: originalDb.query.bind(originalDb), transaction };
      const stopped = new ProjectionRunner(observed, source, logger);
      await expect(stopped.run(projection)).rejects.toThrow(message);
      expect(transactions).toBe(0);
      expect(await state()).toEqual(before);
      expect(await runner.checkpoint(projection)).toBe(0);
    });

  it('keeps a newer row and its dependencies when a stale or repeated write arrives',
    async function revisions() {
      const scopeId = memoryScopeId('test', 'person', 'alice');
      const dependencies = [{ scopeId, memoryId: 'original-parent', revision: 1 }];
      const first = await append('first', 'alice', 'Original text', dependencies);
      await runner.run(projection);
      const saved = await readEventAt(nats.reader, `scope-${first.scopeId}`, 1, Infinity);
      const original = memoryWrittenEventSchema.parse(saved!.event);
      const encrypted = keys.encrypt(first, 'Replacement text');
      for (const revision of [1, 2]) {
        // Represent a row from a later correction without accepting a new write schema here.
        await storage.db.query('UPDATE memory_facts SET revision=$1', [revision]);
        await storage.db.query('UPDATE memory_dependencies SET revision=$1', [revision]);
        const before = await state();
        const dependency = { scopeId: first.scopeId, memoryId: 'parent', revision: 1 };
        const data = { ...original.data, ...encrypted, dependsOn: [dependency] };
        const envelope = { ...original, id: `repeat-${revision}`,
          commandId: `repeat-${revision}`, data };
        await nats.seed([envelope]);
        await runner.run(projection);
        const after = await state();
        expect(after.facts).toEqual(before.facts);
        expect(after.dependencies).toEqual(expect.arrayContaining(before.dependencies));
        expect(after.dependencies).toContainEqual(expect.objectContaining({
          memory_id: 'first', revision: '1', dependency_id: 'parent',
        }));
      }
      expect(await runner.checkpoint(projection)).toBe(3);
      expect((await state()).changes).toHaveLength(3);
    });

  it('keeps written change history identical after a key is destroyed and replayed',
    async function outcomes() {
      const first = await append('first');
      await runner.run(projection);
      const before = (await state()).changes;
      expect(before).toEqual([expect.objectContaining({ outcome: 'written' })]);
      keys.delete(first);
      await runner.rebuild(projection);
      expect((await state()).changes).toEqual(before);
      expect((await state()).facts).toEqual([
        expect.objectContaining({ content_status: 'unavailable', search_text: null }),
      ]);
    });

  it('checks later keys before dropping any live tables during rebuild', async function preflight() {
    await append('first');
    const later = await append('later');
    await runner.run(projection);
    const before = await state();
    const encrypted = keys.encrypt(later, 'fixture');
    const path = `${directory}/${encrypted.keyId.slice(4)}`;
    const bytes = await readFile(path);
    await writeFile(path, Buffer.alloc(31));
    const generation = await storage.db.query('SELECT * FROM projection_generations');
    const processed = await storage.db.query('SELECT * FROM projection_events ORDER BY event_id');
    await expect(runner.rebuild(projection)).rejects.toThrow('Memory key store damaged');
    expect(await state()).toEqual(before);
    expect(await runner.checkpoint(projection)).toBe(2);
    expect(await storage.db.query('SELECT * FROM projection_generations')).toEqual(generation);
    expect(await storage.db.query('SELECT * FROM projection_events ORDER BY event_id'))
      .toEqual(processed);
    await writeFile(path, bytes);
    await runner.rebuild(projection);
    expect(await state()).toEqual(before);
  });

});
