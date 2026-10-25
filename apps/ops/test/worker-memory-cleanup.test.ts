import { mkdtemp, rm } from 'node:fs/promises';
import { memoryCleanupRecordedEventSchema } from '@opencrane/events';
import { expect, it, onTestFinished, vi } from 'vitest';
import { event } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { memoryKeys, memoryProjection, memoryScopeId, ProjectionRunner } from
  '@opencrane/projections';
import { reactionWorker } from './support/reaction-worker.ts';
import { memoryCleanupHandler } from '../src/memory-cleanup.ts';

it.each(['queued', 'failed', 'completed-before-failure'])(
  'finishes %s cleanup jobs once after restart using the separate content database',
  retainedCleanup);

async function retainedCleanup(state: string) {
  const fixture = await cleanupFixture();
  const { setup, keys, identity, replacement, corrected, forgotten, subject, projection, runner } =
    fixture;
  await setup.start();
  async function jobs() {
    return setup.storage.queue.query<{ id: string; state: string; retry_count: number }>(
      "SELECT id, state, retry_count FROM pgboss.job WHERE name='cleanup-memory' ORDER BY created_on");
  }
  async function queued() {
    return (await jobs()).rows.length === 2;
  }
  await until(queued);
  await setup.stop();
  const original = (await jobs()).rows;
  expect(original).toHaveLength(2);
  for (const job of original) expect(job.state).toBe('created');
  if (state === 'completed-before-failure') {
    const handler = memoryCleanupHandler(setup.nats.store, keys, setup.reader.db);
    await handler.handle(corrected, setup.reader.db);
    await runner.run(projection);
  }
  if (state !== 'queued') {
    // Reproduce an exhausted original without waiting for the queue's retry delays.
    await setup.storage.queue.query(
      "UPDATE pgboss.job SET state='failed', retry_count=5, started_on=clock_timestamp(), " +
      'completed_on=clock_timestamp() WHERE id=$1', [original[0]!.id]);
  }
  setup.resumeHandlers();
  await setup.start();
  async function completed() {
    // Let the real projection apply cleanup reports before the next cleanup verifies it.
    await runner.run(projection);
    const rows = (await jobs()).rows;
    return rows.length === 2 && rows.every(isCompleted);
  }
  await until(completed);
  await setup.stop();
  const finished = (await jobs()).rows;
  expect(finished.map(jobId)).toEqual(original.map(jobId));
  expect(finished[0]?.retry_count).toBeLessThan(5);
  expect(keys.status(identity)).toBe('destroyed');
  expect(keys.status(replacement)).toBe('destroyed');
  const records = [];
  for await (const row of setup.nats.store.readStream(subject)) {
    if (row.event.type !== 'memory.cleanup_recorded') continue;
    const record = memoryCleanupRecordedEventSchema.parse(row.event);
    if (record.data.outcome === 'completed') records.push(record.data);
  }
  expect(records).toMatchObject([
    { changeId: corrected.id, outcome: 'completed' },
    { changeId: forgotten.id, outcome: 'completed' },
  ]);
  const position = await setup.nats.store.head();
  await setup.start();
  await setup.stop();
  expect(await setup.nats.store.head()).toBe(position);
  expect((await jobs()).rows).toEqual(finished);
  const receipts = await setup.storage.queue.query(
    "SELECT event_id FROM handler_receipts WHERE handler='cleanup-memory' ORDER BY event_id");
  expect(receipts.rows).toEqual([{ event_id: corrected.id }, { event_id: forgotten.id }]);
  const tables = await setup.storage.queue.query(
    "SELECT to_regclass('memory_facts') AS facts, to_regclass('projection_checkpoints') AS checkpoints");
  expect(tables.rows).toEqual([{ facts: null, checkpoints: null }]);
  const contentJobs = await setup.content.db.query("SELECT to_regclass('pgboss.job') AS jobs");
  expect(contentJobs.rows).toEqual([{ jobs: null }]);
  await expect(setup.reader.db.query('DELETE FROM memory_facts'))
    .rejects.toThrow('permission denied');
}

function isCompleted(job: { state: string }): boolean {
  return job.state === 'completed';
}

function jobId(job: { id: string }): string {
  return job.id;
}

async function cleanupFixture() {
  const setup = await reactionWorker(true);
  const directory = await mkdtemp('/tmp/worker-memory-cleanup-');
  async function removeKeys() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(removeKeys);
  vi.stubEnv('MEMORY_KEY_DIRECTORY', directory);
  const keys = memoryKeys(directory);
  const scopeId = memoryScopeId('test', 'person', 'alice');
  const identity = { silo: 'test', scopeId, scopeKind: 'person' as const,
    ownerId: 'alice', memoryId: 'fact', revision: 1 };
  keys.provision(identity);
  const encrypted = keys.encrypt(identity, 'Original private fact');
  const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'fact', revision: 1, kind: 'fact', pinned: false, expiresAt: null,
    sources: [], dependsOn: [], ...encrypted };
  const subject = `scope-${scopeId}`;
  const written = { ...event('written', subject, 'memory.written'), data };
  const replacement = { ...identity, revision: 2 };
  keys.provision(replacement);
  const correctedData = { ...data, revision: 2, expectedRevision: 1,
    supersedes: { memoryId: 'fact', revision: 1 }, reason: 'human',
    ...keys.encrypt(replacement, 'Corrected private fact') };
  const corrected = { ...event('corrected', subject, 'memory.corrected'), data: correctedData };
  const forgottenData = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
    memoryId: 'fact', expectedRevision: 2, revision: 3 };
  const forgotten = { ...event('forgotten', subject, 'memory.forgotten'), data: forgottenData };
  await setup.nats.seed([written, corrected, forgotten]);
  const projection = memoryProjection(keys);
  const runner = new ProjectionRunner(setup.content.db, setup.nats.reader, setup.logger);
  await runner.initialise(projection);
  await runner.run(projection);
  await setup.grantReads();
  return { setup, keys, identity, replacement, corrected, forgotten, subject, projection, runner };
}
