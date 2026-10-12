import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { PgBoss, TestClock, type Db } from 'pg-boss';
import { scheduleNightly } from '../../../libs/handlers/src/queue.ts';
import { event } from '@opencrane/event-store/testing';
import { memoryMaintenanceRecordedDataSchema } from '@opencrane/events';
import { memoryWrittenExample } from '../../../libs/events/src/memory.ts';
import { memoryProjection, memoryScopeId, ProjectionRunner } from '@opencrane/projections';
import { fixture, logger, until } from '../../../libs/handlers/test/helpers.ts';
import { scanNightlyMemory } from '../src/nightly-memory.ts';

let services: Awaited<ReturnType<typeof fixture>>;
const scopeId = memoryScopeId('test', 'person', 'alice');
const custody = { decrypt };
const projection = memoryProjection(custody);
function decrypt() {
  return null;
}
async function close() {
  vi.useRealTimers();
  await services?.close();
}
afterEach(close);
async function append(type: string, data: unknown, time = '2026-10-12T01:00:00Z') {
  const position = await services.nats.store.head();
  const eventName = type.replaceAll('.', '-');
  const id = `${eventName}-${position}`;
  const base = event(id, `scope-${scopeId}`, type);
  const record = { ...base, silo: 'test', source: 'opencrane-server', time, data,
    commandId: id, principal: { kind: 'human' as const, id: 'alice' } };
  const expectedSequence = await services.nats.store.head(record.subject);
  const command = { event: record, expectedSequence, historyChecked: true as const };
  const result = await services.nats.store.append(command);
  expect(result.status).toBe('appended');
}
function written(memoryId = memoryWrittenExample.memoryId) {
  const fields = ['test', scopeId, 'person', 'alice', memoryId, 1];
  const hash = createHash('sha256');
  const encoded = JSON.stringify(fields);
  hash.update(encoded);
  const keyDigest = hash.digest('hex');
  return { ...memoryWrittenExample, scopeId, memoryId, keyId: `key:${keyDigest}` };
}
async function setup(dirty = true) {
  services = await fixture();
  const binding = { scopeId, scopeKind: 'person', ownerId: 'alice', memberId: 'alice',
    assistantId: 'assistant', payingGroupId: 'sales', enabled: true,
    acceptedCapCents: 100, revision: 1 };
  await append('memory.maintenance_bound', binding);
  if (dirty) {
    const fact = written();
    await append('memory.written', fact);
  }
  const runner = new ProjectionRunner(services.db, services.nats.reader, logger);
  await runner.initialise(projection);
  await runner.run(projection);
}
async function records() {
  const rows = [];
  for await (const row of services.nats.store.readStream(`scope-${scopeId}`)) {
    if (row.event.type === 'memory.maintenance_recorded') {
      rows.push(row.event.data);
    }
  }
  return rows;
}
async function scan(time: string) {
  const runner = new ProjectionRunner(services.db, services.nats.reader, logger);
  await runner.run(projection);
  const occurrence = new Date(time);
  function selectedTime() {
    return occurrence;
  }
  await scanNightlyMemory(services.db, services.nats.store, 'test', occurrence, selectedTime);
}
async function boundary() {
    await setup();
    await scan('2026-10-12T01:59:59Z');
    const before = await records();
    expect(before).toEqual([]);
    const firstScan = scan('2026-10-12T02:00:00Z');
    const secondScan = scan('2026-10-12T02:00:00Z');
    const scans = [firstScan, secondScan];
    await Promise.all(scans);
    const first = await records();
    expect(first).toHaveLength(1);
    const expected = { action: 'refused', reason: 'qualification_blocked',
      intendedAt: '2026-10-12T02:00:00.000Z', acceptedCapCents: 100 };
    expect(first[0]).toMatchObject(expected);
    const laterFact = written('later');
    await append('memory.written', laterFact);
    await scan('2026-10-12T02:01:00Z');
    const duplicate = await records();
    expect(duplicate).toEqual(first);
    await scan('2026-10-13T02:00:00Z');
    const nextNight = await records();
    expect(nextNight).toHaveLength(2);
}
it('crosses the boundary once, keeps dirty inputs and ignores duplicate or changed delivery',
  boundary, 30_000);
async function clean() {
  await setup(false);
  await scan('2026-10-12T02:00:00Z');
  const saved = await records();
  expect(saved).toEqual([]);
}
it('leaves a clean scope alone',
  clean, 30_000);
async function missed() {
  await setup();
  await scan('2026-10-12T02:15:00Z');
  await scan('2026-10-15T11:00:00Z');
  const saved = await records();
  expect(saved).toHaveLength(2);
  const expected = { action: 'missed', reason: 'window_missed',
    intendedAt: '2026-10-15T02:00:00.000Z' };
  const offlineNight: unknown = expect.objectContaining(expected);
  const expectedHistory: unknown = expect.arrayContaining([offlineNight]);
  expect(saved).toEqual(expectedHistory);
  await scan('2026-10-16T02:00:00Z');
  const nextNight = await records();
  expect(nextNight).toHaveLength(3);
}
it('records late and offline nights without catching up older nights',
  missed, 30_000);
async function overlap() {
  await setup();
  await scan('2026-10-12T02:00:00Z');
  const [first] = await records();
  const recorded = memoryMaintenanceRecordedDataSchema.parse(first);
  const unresolved = { ...recorded, action: 'due', reason: null };
  await append('memory.maintenance_recorded', unresolved, '2026-10-12T02:01:00Z');
  await scan('2026-10-13T02:00:00Z');
  const expected = { action: 'missed', reason: 'overlap' };
  const overlapNight: unknown = expect.objectContaining(expected);
  const expectedHistory: unknown = expect.arrayContaining([overlapNight]);
  const saved = await records();
  expect(saved).toEqual(expectedHistory);
}
it('records overlap and retains the dirty backlog',
  overlap, 30_000);

async function processes() {
  await setup();
  const children = [];
  const ready = [];
  const exited = [];
  for (let index = 0; index < 2; index++) {
    const natsEnvironment = services.nats.env();
    const env = { ...process.env, ...natsEnvironment,
      NIGHTLY_TEST_DATABASE: services.connectionString };
    const options = { env, execArgv: ['--experimental-strip-types'] };
    const child = fork('apps/ops/test/support/nightly-process.ts', [], options);
    children.push(child);
    const readyMessage = once(child, 'message');
    ready.push(readyMessage);
    const exitMessage = once(child, 'exit');
    exited.push(exitMessage);
  }
  try {
    await Promise.all(ready);
    for (const child of children) {
      child.send('go');
    }
    const results = await Promise.all(exited);
    expect(results).toEqual([[0, null], [0, null]]);
    const first = await records();
    expect(first).toHaveLength(1);
    await scan('2026-10-12T02:01:00Z');
    const duplicate = await records();
    expect(duplicate).toHaveLength(1);
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
  }
}
it('two scheduler processes claim the same scope, date and input key once',
  processes, 30_000);

async function slowHistory() {
  await setup();
  const timers: { toFake: ['Date'] } = { toFake: ['Date'] };
  vi.useFakeTimers(timers);
  vi.setSystemTime('2026-10-12T02:14:59Z');
  const store = services.nats.store;
  const originalReadStream = store.readStream.bind(store);
  async function* delayedHistory(subject: string, after?: number, deadline?: number) {
    yield* originalReadStream(subject, after, deadline);
    vi.setSystemTime('2026-10-12T02:15:05Z');
  }
  store.readStream = delayedHistory;
  const startedAt = new Date();
  await scanNightlyMemory(services.db, store, 'test', startedAt);
  store.readStream = originalReadStream;
  const saved = await records();
  const expected = {
    action: 'missed',
    reason: 'window_missed',
    intendedAt: '2026-10-12T02:00:00.000Z',
    selectedAt: '2026-10-12T02:15:05.000Z',
  };
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject(expected);
}
it('records the actual selection time when history crosses the window end',
  slowHistory, 30_000);

async function exhaustedTrigger() {
  await setup();
  const runner = new ProjectionRunner(services.db, services.nats.reader, logger);
  const before = await services.db.query<Record<string, unknown>>('SELECT * FROM memory_facts');
  // Leave the worker paused with a new event waiting before the night begins.
  const pausedFact = written('paused-fact');
  await append('memory.written', pausedFact);
  const clock = new TestClock('2026-10-12T02:00:00Z');
  let sessionStatements: string[] = [];
  function setSessionStatements(statements: string[]) {
    sessionStatements = statements;
    return Promise.resolve();
  }
  async function executeSql(sql: string, values?: unknown[]) {
    const client = await services.pool.connect();
    try {
      for (const statement of sessionStatements) {
        await client.query(statement);
      }
      return await client.query(sql, values);
    } finally {
      client.release();
    }
  }
  const adapter: Db = { executeSql, setSessionStatements };
  const options = { db: adapter, clock, schedule: false };
  const boss = new PgBoss(options);
  function selectionTime() {
    const now = clock.now();
    return new Date(now);
  }
  async function scanTrigger(occurrence?: Date) {
    const selectedAt = selectionTime();
    const intendedAt = occurrence ?? selectedAt;
    await scanNightlyMemory(services.db, services.nats.store, 'test', intendedAt, selectionTime);
  }
  async function exhausted() {
    await clock.tick(1000);
    const jobs = await boss.findJobs('dream-nightly');
    for (const job of jobs) {
      if (job.state === 'failed' && job.retryCount === 5) {
        return true;
      }
    }
    return false;
  }
  async function recovered() {
    await clock.tick(1000);
    const saved = await records();
    for (const record of saved) {
      const parsed = memoryMaintenanceRecordedDataSchema.parse(record);
      if (parsed.date === '2026-10-12' && parsed.action === 'missed') {
        return true;
      }
    }
    return false;
  }
  try {
    await boss.start();
    await scheduleNightly(boss, 'test', scanTrigger);
    const payload = { silo: 'test' };
    await boss.send('dream-nightly', payload);
    await until(exhausted);
    const failed = await boss.findJobs('dream-nightly');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.state).toBe('failed');
    const absent = await records();
    expect(absent).toEqual([]);
    await clock.setTime('2026-10-12T03:00:00Z');
    await runner.run(projection);
    await clock.setTime('2026-10-13T02:00:00Z');
    await boss.send('dream-nightly', payload);
    await until(recovered, 5000);
    const saved = await records();
    const missedNight = {
      date: '2026-10-12',
      action: 'missed',
      reason: 'window_missed',
      intendedAt: '2026-10-12T02:00:00.000Z',
    };
    const matchingNight: unknown = expect.objectContaining(missedNight);
    const expectedHistory: unknown = expect.arrayContaining([matchingNight]);
    expect(saved).toEqual(expectedHistory);
    await runner.run(projection);
    const after = await services.db.query<Record<string, unknown>>('SELECT * FROM memory_facts');
    expect(after.rows).toHaveLength(before.rows.length + 1);
    const originalFact = before.rows[0];
    const oldFact: unknown = expect.objectContaining(originalFact);
    const expectedFacts: unknown = expect.arrayContaining([oldFact]);
    expect(after.rows).toEqual(expectedFacts);
  } finally {
    await boss.stop();
  }
}
it('recovers an exhausted trigger as a missed night and leaves its inputs dirty',
  exhaustedTrigger, 30_000);
