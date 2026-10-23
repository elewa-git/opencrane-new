import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getEventDefinition, routineDefinitionSchema, type EventEnvelope } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines } from '../src/index.ts';
import { database } from './database.ts';

const exec = promisify(execFile);
const logger = createLogger('routine-test', { level: 'silent' });
let storage: Awaited<ReturnType<typeof database>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let runner: ProjectionRunner;
let sequence: number;

beforeEach(async function setup() {
  storage = await database('pg');
  nats = await natsFixture();
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(routines);
  sequence = 0;
});
afterEach(async function cleanup() {
  await nats?.close();
  await storage?.close();
});

function record(type: string, overrides: Record<string, unknown> = {}): EventEnvelope {
  const example: unknown = getEventDefinition(type)?.example;
  if (!example || typeof example !== 'object') throw new Error('Missing example');
  const data = { ...example, ...overrides };
  const actor = Reflect.get(data, 'actorId') as string | undefined;
  const principal = { kind: actor ? 'human' as const : 'system' as const,
    id: actor ?? 'opencrane-server' };
  return { id: `${type}-${sequence++}`, commandId: `request-${sequence}`, type, data,
    subject: 'routine-orders', silo: 'test', source: 'opencrane-server', principal,
    time: '2026-10-11T07:00:00Z', correlation: {} };
}
async function save(event: EventEnvelope) {
  await nats.seed([event]);
  await runner.run(routines);
}
async function snapshot() {
  const current = await storage.db.query('SELECT * FROM routines ORDER BY silo, routine_id');
  const occurrences = await storage.db.query(
    'SELECT * FROM routine_occurrences ORDER BY silo, routine_id, occurrence_id');
  const checkpoints = await storage.db.query('SELECT * FROM projection_checkpoints');
  const receipts = await storage.db.query(
    'SELECT * FROM projection_events ORDER BY projection, event_id');
  const generations = await storage.db.query('SELECT * FROM projection_generations');
  return { current: current.rows, occurrences: occurrences.rows,
    checkpoints: checkpoints.rows, receipts: receipts.rows, generations: generations.rows };
}

it('rebuilds encrypted facts, frozen runs, compact ranges and legacy without effects', async function () {
  const created = record('routine.created');
  await save(created);
  await save(record('routine.resumed'));
  const due = record('routine.due');
  await save(due);
  await save(record('routine.run_activation_admitted'));
  await save(record('routine.run_finished'));
  await save(record('routine.paused'));
  const definition = routineDefinitionSchema.parse(Reflect.get(created.data as object, 'definition'));
  const replacement = { ...definition, ownerId: 'bob', assistantId: 'new-assistant',
    payingGroupId: 'new-payer', assistantPayingGroupId: 'new-payer' };
  await save(record('routine.reassigned', { definition: replacement, definitionRevision: 2 }));
  await save(record('routine.updated', { definition: replacement, definitionRevision: 3,
    actorId: 'bob' }));
  await save(record('routine.occurrences_missed', { count: 100000 }));
  await save(record('routine.occurrence_skipped'));
  const legacy = record('routine.created');
  legacy.subject = 'routine-old';
  legacy.data = { routineId: 'old', assistantId: 'old', schedule: '* * * * *', createdBy: 'alice' };
  await save(legacy);
  await save(created);
  await save(due);
  await runner.run(routines);
  const before = await snapshot();
  expect(before.current).toHaveLength(2);
  expect(before.occurrences).toHaveLength(3);
  const frozen = { due: { definitionRevision: 1, definition: { ownerId: 'alice',
    assistantId: 'sales-assistant', payingGroupId: 'sales', instructions: definition.instructions } },
  terminal: { outcome: 'cancelled' } };
  const run = before.occurrences.find(isRun);
  expect(run?.['data']).toMatchObject(frozen);
  const old = before.current.find(isLegacy);
  const legacyState = { status: 'legacy-needs-migration', executionAvailable: false };
  expect(old?.['state']).toMatchObject(legacyState);
  const append = vi.spyOn(nats.store, 'append');
  const rebuilt = await rebuildRoutineProjection(storage.db, nats.reader, logger, { verify: true });
  expect(rebuilt.verified).toBe(true);
  const after = await snapshot();
  expect(after.current).toEqual(before.current);
  expect(after.occurrences).toEqual(before.occurrences);
  expect(append).not.toHaveBeenCalled();
});
function isRun(row: Record<string, unknown>) { return row['kind'] === 'run'; }
function isLegacy(row: Record<string, unknown>) { return row['routine_id'] === 'old'; }

it('refuses wrong streams, silos and run bindings without changing rows', async function () {
  await save(record('routine.created'));
  await save(record('routine.resumed'));
  await save(record('routine.due'));
  const before = await snapshot();
  const wrongStream = record('routine.run_finished');
  wrongStream.subject = 'routine-other';
  const wrongSilo = record('routine.run_finished');
  wrongSilo.silo = 'other';
  const wrongBinding = record('routine.run_finished', { rootId: 'other' });
  for (const invalid of [wrongStream, wrongSilo, wrongBinding]) {
    async function applyInvalid() {
      await storage.db.transaction(async function apply(tx) { await routines.apply(tx, invalid, 99); });
    }
    await expect(applyInvalid()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
});

it('keeps older terminal runs after later runs and refuses changed duplicate bindings', async function () {
  await save(record('routine.created'));
  await save(record('routine.resumed'));
  const first = record('routine.due');
  await save(first);
  await save(record('routine.run_finished'));
  const second = { occurrenceId: 'second', rootId: 'second-root', conversationId: 'second-chat',
    messageId: 'second-input', turnId: 'second-turn' };
  await save(record('routine.due', second));
  await save(record('routine.run_finished', second));
  const before = await snapshot();
  await save(record('routine.due'));
  await save(record('routine.run_finished', { outcome: 'succeeded' }));
  const after = await snapshot();
  expect(after.current).toEqual(before.current);
  expect(after.occurrences).toEqual(before.occurrences);
  const forged = record('routine.run_finished', { rootId: 'forged' });
  await expect(routines.apply(storage.db, forged, 100)).rejects.toThrow();
});

it('rolls back interrupted rebuilds and detects changed rows without leaking encrypted bytes', async function () {
  await save(record('routine.created'));
  await save(record('routine.resumed'));
  const before = await snapshot();
  const interrupted = { head: nats.reader.head.bind(nats.reader),
    async *subscribe(from: number, signal?: AbortSignal) {
      for await (const stored of nats.reader.subscribe(from, signal)) {
        yield stored;
        throw new Error('Interrupted fixture');
      }
    } };
  await expect(rebuildRoutineProjection(storage.db, interrupted, logger))
    .rejects.toThrow('Interrupted fixture');
  expect(await snapshot()).toEqual(before);
  await storage.db.query("UPDATE routines SET state = jsonb_set(state, '{status}', '\"paused\"')");
  const changed = await snapshot();
  await expect(rebuildRoutineProjection(storage.db, nats.reader, logger, { verify: true }))
    .rejects.toThrow('Rebuilt routines differ');
  expect(await snapshot()).toEqual(changed);
});

it('runs the worker and guarded replay entrypoints using only reader credentials', async function () {
  await nats.seed([record('routine.created'), record('routine.resumed'), record('routine.due')]);
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env['PG_TEST_URL']!);
  url.pathname = `/${current.rows[0]!.name}`;
  const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: url.href };
  const workerOptions = { env, stdio: 'pipe' as const };
  const guarded = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', './apps/ops/test/support/routine-effects.ts'];
  const worker = spawn(process.execPath,
    [...guarded, 'apps/ops/src/worker.ts', 'routines'], workerOptions);
  const exited = once(worker, 'exit');
  try {
    for (let attempt = 0; attempt < 100 && await runner.checkpoint(routines) !== 3; attempt++) {
      await delay(50);
    }
    expect(await runner.checkpoint(routines)).toBe(3);
  } finally {
    worker.kill('SIGTERM');
    await exited;
  }
  const options = { env };
  const base = [...guarded, 'apps/ops/src/replay.ts', 'routines'];
  await expect(exec(process.execPath, base, options)).rejects.toThrow('confirm-routines-stopped');
  const before = await snapshot();
  const dry = await exec(process.execPath, [...base, '--dry-run'], options);
  expect(dry.stdout).toContain('DRY RUN: routines');
  expect(await snapshot()).toEqual(before);
  const rebuilt = await exec(process.execPath,
    [...base, '--confirm-routines-stopped', '--verify'], options);
  expect(rebuilt.stdout).toContain('PASS: routines');
  expect(await nats.reader.head()).toBe(3);
  const jobs = await storage.db.query("SELECT tablename FROM pg_tables WHERE schemaname='pgboss'");
  expect(jobs.rows).toEqual([]);
  const diagnostics = dry.stdout + dry.stderr + rebuilt.stdout + rebuilt.stderr;
  expect(diagnostics).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
  expect(diagnostics).not.toContain('key:1');
});
