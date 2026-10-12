import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { memoryIdentity, memoryKeys, memoryProjection, memoryScopeId,
  ProjectionRunner, readMemoryFactIds } from '@opencrane/projections';
import type { EventEnvelope, MemoryIdentity } from '@opencrane/events';
import { database } from '../../../libs/projections/test/database.ts';
import { memoryCleanupHandler } from '../src/memory-cleanup.ts';
import { dispatcherHandlerNames } from '../src/dispatcher-handlers.ts';

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
  const saved = [];
  for await (const row of nats.store.readStream(forgotten.subject)) {
    if (row.event.type === 'memory.cleanup_recorded') saved.push(row.event);
  }
  return saved;
}

it('destroys dependent keys and candidate copies once, then rebuilds without hidden decryption',
  async function complete() {
    expect(dispatcherHandlerNames({ MEMORY_KEY_DIRECTORY: directory })).toContain('cleanup-memory');
    const candidate = { ...root, revision: 2 };
    const keyId = keys.provision(candidate);
    const filename = `${directory}/${keyId.slice(4)}`;
    const pending = `${filename}-pending`;
    await writeFile(pending, await readFile(filename));
    await runner.run(projection);
    await handler().handle(forgotten, storage.db);
    await handler().handle(forgotten, storage.db);
    expect(keys.status(root)).toBe('destroyed');
    expect(keys.status(child)).toBe('destroyed');
    expect(keys.status({ ...root, memoryId: 'grandchild' })).toBe('destroyed');
    expect(keys.status(candidate)).toBe('destroyed');
    expect(keys.status(independent)).toBe('available');
    expect(await readFile(filename)).toHaveLength(0);
    await expect(readFile(pending)).rejects.toThrow();
    expect(await completions()).toHaveLength(1);
    function onlyVisible(identity: MemoryIdentity, value: { ciphertext: string; keyId: string }) {
      if (identity.ownerId === 'alice') throw new Error('Hidden text was decrypted');
      return keys.decrypt(identity, value);
    }
    await runner.rebuild(memoryProjection({ decrypt: onlyVisible }));
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
    const failing = vi.spyOn(nats.store, 'append').mockResolvedValue({ status: 'unavailable' });
    await expect(handler().handle(forgotten, storage.db)).rejects.toThrow();
    expect(keys.status(root)).toBe('destroyed');
    expect(await completions()).toEqual([]);
    async function lostReply(command: Parameters<typeof append>[0]) {
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
  const data = { ...forgotten.data as object, memoryId: 'independent' };
  await expect(handler().handle({ ...forgotten, data }, storage.db)).rejects.toThrow();
  expect(keys.status(independent)).toBe('available');
  expect(await completions()).toEqual([]);
});
