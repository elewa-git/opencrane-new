import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getEventDefinition, routineDefinitionSchema, type EventEnvelope } from '@opencrane/events';
import { natsFixture } from '@opencrane/event-store/testing';
import { createLogger } from '@opencrane/observability';
import { ProjectionRunner, rebuildRoutineProjection, routines, type Query } from '../src/index.ts';
import { database } from './database.ts';

const exec = promisify(execFile);
const privateCanary = 'routine-private-canary';
const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 9), Buffer.alloc(12, 7));
const encryptedParts = [cipher.update(privateCanary), cipher.final(), cipher.getAuthTag()];
const encrypted = Buffer.concat(encryptedParts);
const instructions = { ciphertext: encrypted.toString('base64'), keyId: 'key:1' };
const logger = createLogger('routine-test', { level: 'silent' });
let storage: Awaited<ReturnType<typeof database>>;
let nats: Awaited<ReturnType<typeof natsFixture>>;
let runner: ProjectionRunner;
let sequence: number;

async function setup() {
  storage = await database('pg');
  nats = await natsFixture();
  runner = new ProjectionRunner(storage.db, nats.reader, logger);
  await runner.initialise(routines);
  sequence = 0;
}
beforeEach(setup);
async function cleanup() {
  await nats?.close();
  await storage?.close();
  vi.restoreAllMocks();
}
afterEach(cleanup);

function record(type: string, overrides: Record<string, unknown> = {}): EventEnvelope {
  const example: unknown = getEventDefinition(type)?.example;
  if (!example || typeof example !== 'object') throw new Error('Missing example');
  const data = { ...example, ...overrides };
  const definition: unknown = Reflect.get(data, 'definition');
  if (definition && typeof definition === 'object') {
    Reflect.set(data, 'definition', { ...definition, instructions });
  }
  const candidate: unknown = Reflect.get(data, 'actorId');
  const actor = typeof candidate === 'string' ? candidate : undefined;
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

async function rebuildsEncryptedFacts() {
  const created = record('routine.created');
  await save(created);
  await save(record('routine.resumed'));
  const due = record('routine.due');
  await save(due);
  await save(record('routine.run_activation_admitted'));
  const otherAttempt = { senderAttemptId: 'other-attempt' };
  const changedActivation = record('routine.run_activation_admitted', otherAttempt);
  await expect(routines.apply(storage.db, changedActivation, 99)).rejects.toThrow();
  const finished = record('routine.run_finished');
  await save(finished);
  await save(record('routine.paused'));
  if (!created.data || typeof created.data !== 'object') throw new Error('Missing definition');
  const savedDefinition: unknown = Reflect.get(created.data, 'definition');
  const definition = routineDefinitionSchema.parse(savedDefinition);
  const replacement = { ...definition, ownerId: 'bob', assistantId: 'new-assistant',
    payingGroupId: 'new-payer', assistantPayingGroupId: 'new-payer' };
  const reassignment = { definition: replacement, definitionRevision: 2 };
  await save(record('routine.reassigned', reassignment));
  const edit = { definition: replacement, definitionRevision: 3, actorId: 'bob' };
  await save(record('routine.updated', edit));
  const missedRange = { count: 100000 };
  await save(record('routine.occurrences_missed', missedRange));
  await save(record('routine.occurrences_missed', missedRange));
  await save(record('routine.occurrence_skipped'));
  await save(record('routine.retired'));
  const legacy = record('routine.created');
  legacy.subject = 'routine-old';
  legacy.data = { routineId: 'old', assistantId: 'old', schedule: '* * * * *', createdBy: 'alice' };
  await save(legacy);
  for (const type of ['routine.updated', 'routine.paused', 'routine.resumed',
    'routine.due', 'routine.retired']) {
    const oldEvent = record(type);
    oldEvent.subject = 'routine-old';
    const fields: Record<string, unknown> = { routineId: 'old' };
    if (type === 'routine.updated') {
      fields['schedule'] = '* * * * *';
      fields['updatedBy'] = 'alice';
    }
    if (type === 'routine.paused') fields['pausedBy'] = 'alice';
    if (type === 'routine.resumed') fields['resumedBy'] = 'alice';
    if (type === 'routine.due') fields['firedAt'] = oldEvent.time;
    if (type === 'routine.retired') fields['retiredBy'] = 'alice';
    oldEvent.data = fields;
    await save(oldEvent);
  }
  await save(created);
  await save(due);
  await runner.run(routines);
  const before = await snapshot();
  expect(before.current).toHaveLength(2);
  expect(before.occurrences).toHaveLength(3);
  expect(JSON.stringify(before)).not.toContain(privateCanary);
  const frozen = { due: { definitionRevision: 1, definition: { ownerId: 'alice',
    assistantId: 'sales-assistant', payingGroupId: 'sales',
    instructions: definition.instructions } },
  activation: { senderAttemptId: 'attempt' }, terminal: { outcome: 'cancelled' },
  terminalReference: { eventId: finished.id, position: 5 } };
  const run = before.occurrences.find(isRun);
  expect(run?.['data']).toMatchObject(frozen);
  const missed = before.occurrences.find(isMissed);
  expect(missed?.['data']).toMatchObject(missedRange);
  const old = before.current.find(isLegacy);
  const legacyState = { status: 'legacy-needs-migration', executionAvailable: false };
  expect(old?.['state']).toMatchObject(legacyState);
  const append = vi.spyOn(nats.store, 'append');
  const verification = { verify: true };
  const rebuilt = await rebuildRoutineProjection(storage.db, nats.reader, logger, verification);
  expect(rebuilt.verified).toBe(true);
  const after = await snapshot();
  expect(after.current).toEqual(before.current);
  expect(after.occurrences).toEqual(before.occurrences);
  expect(append).not.toHaveBeenCalled();
}
it('rebuilds encrypted facts, frozen runs, compact ranges and legacy without effects',
  rebuildsEncryptedFacts);
function isMissed(row: Record<string, unknown>) {
  return row['kind'] === 'missed';
}
function isRun(row: Record<string, unknown>) {
  return row['kind'] === 'run';
}
function isLegacy(row: Record<string, unknown>) {
  return row['routine_id'] === 'old';
}

async function refusesInvalidBindings() {
  await save(record('routine.created'));
  await save(record('routine.resumed'));
  await save(record('routine.due'));
  const before = await snapshot();
  const wrongStream = record('routine.run_finished');
  wrongStream.subject = 'routine-other';
  const wrongSilo = record('routine.run_finished');
  wrongSilo.silo = 'other';
  const foreignBinding = { rootId: 'other' };
  const wrongBinding = record('routine.run_finished', foreignBinding);
  for (const invalid of [wrongStream, wrongSilo, wrongBinding]) {
    async function applyInvalid() {
      async function apply(tx: Query) {
        await routines.apply(tx, invalid, 99);
      }
      await storage.db.transaction(apply);
    }
    await expect(applyInvalid()).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  }
}
it('refuses wrong streams, silos and run bindings without changing rows', refusesInvalidBindings);

async function keepsTerminalRuns() {
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
  const lateSuccess = { outcome: 'succeeded' };
  await save(record('routine.run_finished', lateSuccess));
  const after = await snapshot();
  expect(after.current).toEqual(before.current);
  expect(after.occurrences).toEqual(before.occurrences);
  const forgedBinding = { rootId: 'forged' };
  const forged = record('routine.run_finished', forgedBinding);
  await expect(routines.apply(storage.db, forged, 100)).rejects.toThrow();
}
it('keeps older terminal runs after later runs and refuses changed duplicate bindings',
  keepsTerminalRuns);

async function rollsBackRebuild() {
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
  const verification = { verify: true };
  await expect(rebuildRoutineProjection(storage.db, nats.reader, logger, verification))
    .rejects.toThrow('Rebuilt routines differ');
  expect(await snapshot()).toEqual(changed);
}
it('rolls back interrupted rebuilds and detects changed rows without leaking encrypted bytes',
  rollsBackRebuild);

async function runsProcessEntrypoints() {
  await nats.seed([record('routine.created'), record('routine.resumed'), record('routine.due')]);
  const current = await storage.db.query<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env['PG_TEST_URL']!);
  url.pathname = `/${current.rows[0]!.name}`;
  const env = { ...process.env, ...nats.env('projection'), DATABASE_URL: url.href,
    LOG_LEVEL: 'info' };
  const workerOptions = { env, stdio: 'pipe' as const };
  const guarded = ['--experimental-strip-types', '--experimental-test-module-mocks',
    '--import', './apps/ops/test/support/routine-effects.ts'];
  const worker = spawn(process.execPath,
    [...guarded, 'apps/ops/src/worker.ts', 'routines'], workerOptions);
  const exited = once(worker, 'exit');
  let workerDiagnostics = '';
  function collect(chunk: Buffer) {
    workerDiagnostics += chunk.toString();
  }
  worker.stdout.on('data', collect);
  worker.stderr.on('data', collect);
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
  expect(diagnostics + workerDiagnostics).not.toContain(instructions.ciphertext);
  expect(diagnostics + workerDiagnostics).not.toContain(privateCanary);
  expect(diagnostics + workerDiagnostics).not.toContain('Forbidden routine replay effect');
  expect(diagnostics).not.toContain('key:1');
}
it('runs the worker and guarded replay entrypoints using only reader credentials',
  runsProcessEntrypoints);
