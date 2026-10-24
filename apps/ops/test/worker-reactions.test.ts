import { withConnectionStage } from '../../../libs/models/src/connection-stage-lock.ts';
import { event as fixtureEvent } from '@opencrane/event-store/testing';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { memoryWrittenExample } from '../../../libs/events/src/memory.ts';
import { memoryProjection, memoryScopeId, ProjectionRunner } from '@opencrane/projections';
import { envelope, history } from '@opencrane/models';
import { until } from '@opencrane/authz/testing';
import { reactionWorker } from './support/reaction-worker.ts';

function memoryEvent(subject: string, type: string, data: unknown, id: string, time: Date) {
  const base = fixtureEvent(id, subject, type);
  return { ...base, silo: 'test', source: 'opencrane-server', time: time.toISOString(),
    data, commandId: id, principal: { kind: 'human' as const, id: 'alice' } };
}

async function memoryFixture(forgotten = false) {
  const setup = await reactionWorker();
  const scopeId = memoryScopeId('test', 'person', 'alice');
  const subject = `scope-${scopeId}`;
  const binding = { scopeId, scopeKind: 'person', ownerId: 'alice', memberId: 'alice',
    assistantId: 'assistant', payingGroupId: 'sales', enabled: true,
    acceptedCapCents: 100, revision: 1 };
  const time = new Date('2026-10-12T01:00:00Z');
  const bound = memoryEvent(subject, 'memory.maintenance_bound', binding, 'bound', time);
  const fields = ['test', scopeId, 'person', 'alice', memoryWrittenExample.memoryId, 1];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(fields));
  const fact = { ...memoryWrittenExample, scopeId, keyId: `key:${hash.digest('hex')}` };
  const written = memoryEvent(subject, 'memory.written', fact, 'written', time);
  await setup.nats.seed([bound, written]);
  if (forgotten) {
    const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId: fact.memoryId, revision: 2, expectedRevision: 1 };
    const event = memoryEvent(subject, 'memory.forgotten', data, 'forgotten', time);
    await setup.nats.seed([event]);
  }
  function decrypt() {
    return null;
  }
  const custody = { decrypt };
  const projection = memoryProjection(custody);
  const runner = new ProjectionRunner(setup.content.db, setup.nats.reader, setup.logger);
  await runner.initialise(projection);
  await runner.run(projection);
  await setup.grantReads();
  async function project() {
    await runner.run(projection);
  }
  async function records() {
    const rows = await history(setup.nats.store, subject, 'test');
    const saved: unknown[] = [];
    for (const row of rows) {
      if (row.event.type === 'memory.maintenance_recorded') {
        saved.push(row.event.data);
      }
    }
    return saved;
  }
  return { ...setup, records, project };
}

async function wiredNightly(action: string) {
  const setup = await memoryFixture(action === 'no_changes');
  await setup.start();
  if (action === 'missed') {
    await setup.clock.setTime('2026-10-13T03:00:00Z');
  }
  const occurrence = new Date('2026-10-12T02:00:00Z');
  await setup.scan(occurrence);
  const first = await setup.records();
  const expectedRun = { action, date: '2026-10-12', intendedAt: '2026-10-12T02:00:00.000Z' };
  expect(first).toMatchObject([expectedRun]);
  await setup.project();
  await setup.scan(occurrence);
  await setup.stop();
  await setup.start();
  await setup.scan(occurrence);
  expect(await setup.records()).toEqual(first);
  await expect(setup.reader.db.query('DELETE FROM memory_maintenance_bindings'))
    .rejects.toThrow('permission denied');
  const jobs = await setup.storage.queue.query(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  expect(jobs.rows).toEqual([
    { tablename: 'handler_dispatcher' }, { tablename: 'handler_receipts' },
  ]);
  const tables = await setup.content.db.query("SELECT to_regclass('handler_dispatcher') AS name");
  expect(tables.rows).toEqual([{ name: null }]);
}
it.each(['refused', 'missed', 'no_changes'])(
  'uses content for the wired nightly callback and keeps %s across restart', wiredNightly);

async function unavailableCheckpoint(missing: boolean) {
  const setup = await memoryFixture();
  if (missing) {
    await setup.content.db.query("DELETE FROM projection_checkpoints WHERE name='memory'");
  } else {
    await setup.content.db.query("UPDATE projection_checkpoints SET sequence=0 WHERE name='memory'");
  }
  await setup.start();
  const payload = { silo: 'test' };
  const id = await setup.boss().send('dream-nightly', payload);
  async function retrying() {
    await setup.clock.tick(1000);
    const jobs = await setup.boss().findJobs('dream-nightly');
    return jobs[0]?.state === 'retry';
  }
  await until(retrying);
  const jobs = await setup.boss().findJobs('dream-nightly');
  expect(jobs[0]?.output).toMatchObject({ message: 'Nightly memory metadata is behind the event log' });
  expect(await setup.records()).toEqual([]);
  // Simulate exhausted delivery without waiting through exponential queue delays.
  await setup.storage.queue.query(
    "UPDATE pgboss.job SET state='failed', retry_count=5 WHERE id=$1", [id]);
  await setup.stop();
  await setup.content.db.query(
    "INSERT INTO projection_checkpoints (name, sequence) VALUES ('memory', $1) " +
    'ON CONFLICT (name) DO UPDATE SET sequence=EXCLUDED.sequence', [await setup.nats.store.head()]);
  await setup.clock.setTime('2026-10-13T03:00:00Z');
  await setup.start();
  const boss = setup.boss();
  const deleteJob = boss.deleteJob.bind(boss);
  const inspected = Promise.withResolvers<void>();
  // Keep deletion behind the first queue read to reproduce a result arriving before cleanup.
  async function deleteAfterInspection(...args: Parameters<typeof boss.deleteJob>) {
    if (args[0] === 'dream-nightly' && args[1] === id) {
      await inspected.promise;
    }
    return deleteJob(...args);
  }
  const deletion = vi.spyOn(boss, 'deleteJob');
  deletion.mockImplementation(deleteAfterInspection);
  async function remainingTrigger() {
    const remaining = await setup.storage.queue.query(
      'SELECT id FROM pgboss.job WHERE id=$1', [id]);
    inspected.resolve();
    return remaining.rows;
  }
  try {
    await boss.send('dream-nightly', payload);
    async function recovered() {
      await setup.clock.tick(1000);
      return (await setup.records()).length === 1;
    }
    await until(recovered);
    expect(await setup.records()).toMatchObject([{ action: 'missed', date: '2026-10-12' }]);
    expect(await remainingTrigger()).toEqual([]);
  } finally {
    inspected.resolve();
    deletion.mockRestore();
  }
}
it.each([true, false])('retains failed trigger recovery with missing checkpoint: %s',
  unavailableCheckpoint);

async function sharedProfileLock(path: string) {
  const setup = await reactionWorker();
  const stage = { siloId: 'test', userId: 'alice', serverId: 'server', connectionId: 'installed',
    profileId: 'profile', purpose: 'personal' as const, generation: 1,
    endpointDigest: 'a'.repeat(64), operationId: 'create', expectedSequence: 0,
    appendUntil: Date.now() - 60_000 };
  const identity = { reference: 'synthetic-reference', uid: 'original', resourceVersion: '1' };
  const subject = 'connection-alice-server-profile';
  const activation = { connectionId: stage.connectionId, ownerKind: 'personal', purpose: 'personal',
    generation: 1, uid: identity.uid, resourceVersion: identity.resourceVersion,
    endpointDigest: stage.endpointDigest, operationId: stage.operationId, changedBy: 'alice',
    expectedSequence: 0, appendUntil: stage.appendUntil, reason: 'bearer_create' };
  const data = { userId: 'alice', serverId: 'server', profile: 'profile',
    secretRef: `secret:${identity.reference}`, activation };
  const created = envelope('test', subject, 'connection.created', data, 'create');
  created.principal = { kind: 'human', id: 'alice' };
  await setup.nats.seed([created]);
  const position = await setup.nats.store.head(subject);
  const pending = { ...stage, generation: 2, operationId: 'pending', expectedSequence: position };
  const stages = [stage, pending];
  const recovered = { status: 'recovered' as const, identity };
  const deleted = { status: 'deleted' as const };
  setup.recover.mockResolvedValue(recovered);
  setup.remove.mockResolvedValue(deleted);
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  async function stageInFlight() {
    entered.resolve();
    await held.promise;
  }
  await setup.reader.db.query('SELECT 1');
  const staging = withConnectionStage(setup.reader.db, stage, stageInFlight);
  await Promise.race([entered.promise, staging]);
  try {
    const scanning = Promise.withResolvers<void>();
    async function listStages() {
      await scanning.promise;
      return { status: 'listed' as const, stages, continuation: undefined };
    }
    if (path === 'scan') {
      setup.candidates.mockImplementation(listStages);
    }
    await setup.start();
    scanning.resolve();
    if (path === 'handler') {
      const revoked = { userId: 'alice', serverId: 'server', profile: 'profile', revokedBy: 'alice',
        expectedSequence: position, reason: 'owner_requested' };
      const event = envelope('test', subject, 'connection.revoked', revoked);
      event.principal = { kind: 'human', id: 'alice' };
      await setup.nats.seed([event]);
      async function retrying() {
        const jobs = await setup.storage.queue.query<{ state: string }>(
          "SELECT state FROM pgboss.job WHERE name='cleanup-connection'");
        return jobs.rows[0]?.state === 'retry' || setup.recover.mock.calls.length > 0;
      }
      await until(retrying);
    } else {
      async function scanned() {
        const locks = await setup.content.db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' " +
          'AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())');
        return locks.rows[0]!.count > 0 || setup.recover.mock.calls.length > 0;
      }
      await until(scanned);
      await setup.stop();
    }
    expect(setup.recover).not.toHaveBeenCalled();
    expect(setup.remove).not.toHaveBeenCalled();
    const rows = await history(setup.nats.store, subject, 'test');
    const closures = rows.filter(isClosure);
    expect(closures).toEqual([]);
  } finally {
    held.resolve();
    await staging;
  }
  if (path === 'handler') {
    async function removed() {
      await setup.clock.tick(1000);
      return setup.remove.mock.calls.length === 1;
    }
    await until(removed);
    expect(setup.remove).toHaveBeenCalledWith(stage, identity);
  }
}
function isClosure(row: Awaited<ReturnType<typeof history>>[number]) {
  return row.event.type === 'connection.operation_closed';
}
it.each(['scan', 'handler'])('shares the content staging lock with the wired %s', sharedProfileLock);

async function drainOnLoss() {
  const setup = await memoryFixture();
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  async function candidates() {
    entered.resolve();
    await held.promise;
    setup.ordering.push('scan-drained');
    return { status: 'listed' as const, stages: [], continuation: undefined };
  }
  setup.candidates.mockImplementation(candidates);
  await setup.start();
  await entered.promise;
  const stopped = setup.loseContent();
  function stopping() {
    return process.exitCode === 1;
  }
  try {
    await until(stopping);
    expect(await setup.records()).toEqual([]);
    expect(setup.ordering).not.toContain('content-close');
    expect(setup.ordering).not.toContain('jobs-close');
  } finally {
    held.resolve();
    await stopped;
  }
  expect(process.exitCode).toBe(1);
  const closeIndex = setup.ordering.indexOf('content-close');
  for (const event of ['scan-drained', 'runtime-stopped', 'watcher-stopped']) {
    expect(setup.ordering.indexOf(event)).toBeLessThan(closeIndex);
  }
}
it('drains affected work before closing both pools after content loss', drainOnLoss);
