import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import type { MemoryIdentity } from '@opencrane/events';
import { memoryKeys, memoryProjection, memoryScopeId, ProjectionRunner } from '../src/index.ts';
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
    projection = memoryProjection({ decrypt: keys.decrypt });
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

  async function append(memoryId: string, ownerId = 'alice', text = 'Deliveries café 東京') {
    const scopeId = memoryScopeId('test', 'person', ownerId);
    const identity: MemoryIdentity = {
      silo: 'test', scopeId, scopeKind: 'person', ownerId, memoryId, revision: 1,
    };
    keys.provision(identity);
    const encrypted = keys.encrypt(identity, text);
    const data = {
      schemaVersion: 1, ...identity, kind: 'fact', pinned: false, expiresAt: null,
      sources: [{ memberId: ownerId, commandId: memoryId }], dependsOn: [], ...encrypted,
    };
    // Keep silo in the envelope, as required by the saved event contract.
    const { silo: _silo, ...payload } = data;
    const envelope = { ...event(memoryId), subject: `scope-${scopeId}`,
      type: 'memory.written', data: payload };
    const expectedSequence = positions.get(scopeId) ?? 0;
    const result = await nats.store.append({ event: envelope, expectedSequence });
    expect(result.status).toBe('appended');
    if (result.status !== 'appended') throw new Error('Fixture append failed');
    positions.set(scopeId, result.sequence);
    return identity;
  }

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
      await append('last');
      await runner.run(projection);
      const before = await state();
      expect(before.facts).toHaveLength(3);
      expect(before.changes).toHaveLength(3);
      expect(JSON.stringify(before.changes)).not.toContain('ciphertext');
      expect(JSON.stringify(before.changes)).not.toContain('Deliveries');
      const scopeParameters = [first.silo, first.scopeId];
      const ordered = await storage.db.query(`SELECT memory_id FROM memory_facts
        WHERE silo = $1 AND scope_id = $2 ORDER BY position, memory_id`, scopeParameters);
      expect(ordered.rows).toEqual([{ memory_id: 'first' }, { memory_id: 'last' }]);
      const search = await storage.db.query(`SELECT memory_id FROM memory_facts
        WHERE silo = $1 AND scope_id = $2 AND search_vector @@ to_tsquery('simple', $3)
        ORDER BY position`, [...scopeParameters, 'deliver:* & café']);
      expect(search.rows).toEqual(ordered.rows);
      const excluded = await storage.db.query(`SELECT memory_id FROM memory_facts
        WHERE silo = $1 AND scope_id = $2 AND search_vector @@ to_tsquery('simple', $3)`,
      [...scopeParameters, 'banana']);
      expect(excluded.rows).toEqual([]);
      expect(before.indexes).toEqual(expect.arrayContaining([
        expect.objectContaining({ indexname: 'memory_facts_order' }),
        expect.objectContaining({ indexname: 'memory_facts_search',
          indexdef: expect.stringContaining('USING gin') }),
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
      expect(await readdir(directory)).toEqual(keyFiles);
      runner = new ProjectionRunner(storage.db, nats.reader, logger);
      expect(await runner.checkpoint(projection)).toBe(3);
    });

  it('rolls back rows, processed id and checkpoint after a failure during application',
    async function rollback() {
      await append('first');
      await runner.run(projection);
      const before = await state();
      await append('second');
      async function prepare(envelope: Parameters<Projection['apply']>[1]) {
        const apply = await projection.prepare!(envelope);
        async function fail(tx: Query, event: Parameters<Projection['apply']>[1], position: number) {
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
      await append('live');
      await rename(directory, `${directory}-away`);
      let transactions = 0;
      const original = storage.db;
      async function transaction<Result>(work: (tx: Query) => Promise<Result>) {
        transactions += 1;
        return original.transaction(work);
      }
      const observed: Db = { query: original.query, transaction };
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
});
