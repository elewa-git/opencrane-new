// Pass condition 3: crash recovery. A worker process is killed (SIGKILL, a
// real process death) in the middle of an activity. The event must be handed
// to another worker, and with an idempotency key the effect must land exactly
// once. Same two crash moments and the same control as the pg-boss test:
//   - before the effect was written;
//   - after the effect was written, before the activity reported success
//     (the activity runs twice, so only the idempotency key keeps it to one);
//   - control: no idempotency key, so the effect happens twice.
// Here the SERVER notices the dead worker, through the activity's heartbeat
// timeout (2 seconds), and hands the activity to whichever worker is polling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, Client as WorkflowClient } from '@temporalio/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startTemporalServer, type TestTemporalServer } from '../../src/temporal-server.ts';
import { exec, sql } from '../../src/pgboss-query.ts';
import { pidExists, spawnNodeTs, type LineProcess } from '../../src/proc.ts';
import type { ApplyEffectInput } from '../../src/temporal-workflows/activities.ts';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/temporal-worker-process.ts');

describe('temporal: crash recovery and exactly-once effects', () => {
  let server: TestTemporalServer;
  let effectsDb: TestPg;
  let connection: Connection;
  let client: WorkflowClient;
  const spawned: LineProcess[] = [];

  // Each case has its own task queue, so a worker left over from an earlier
  // case can never pick up a later case's activity.
  const spawnWorker = (taskQueue: string) => {
    const w = spawnNodeTs(WORKER_PATH, [server.address, server.namespace, taskQueue]);
    spawned.push(w);
    return w;
  };
  const effectCount = async (table: string, key: string) =>
    Number((await sql<{ n: string }>(effectsDb.connectionString, `SELECT count(*) AS n FROM ${table} WHERE idempotency_key = $1`, [key]))[0]!.n);
  const start = (workflowId: string, taskQueue: string, input: Omit<ApplyEffectInput, 'connectionString'>) =>
    client.workflow.start('crashRecoveryWorkflow', {
      taskQueue,
      workflowId,
      args: [{ ...input, connectionString: effectsDb.connectionString }],
    });

  beforeAll(async () => {
    // Two databases: the effect lives in its own PostgreSQL, apart from Temporal's.
    effectsDb = await startPg('temporal-effects');
    await exec(effectsDb.connectionString, `CREATE TABLE effects_guarded (idempotency_key text PRIMARY KEY, applied_at timestamptz NOT NULL)`);
    await exec(effectsDb.connectionString, `CREATE TABLE effects_plain (idempotency_key text, applied_at timestamptz NOT NULL)`);
    server = await startTemporalServer('crash');
    connection = await Connection.connect({ address: server.address });
    client = new WorkflowClient({ connection, namespace: server.namespace });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(spawned.map((w) => w.kill().catch(() => undefined)));
    await connection?.close();
    await server?.stop();
    await effectsDb?.stop();
  });

  it('crash BEFORE the effect: the activity is redelivered and the effect lands once', async () => {
    const key = 'reserve-before-effect';
    const tq = 'crash-before-tq';
    const w1 = spawnWorker(tq);
    await w1.waitForLine((l) => l.includes('WORKER ready'), 60_000);
    const handle = await start('crash-before', tq, { effectsTable: 'effects_guarded', idempotencyKey: key, guarded: true, sleepBeforeEffectMs: 3000, holdAfterEffectMs: 0 });
    await w1.waitForLine((l) => l.includes(`ACTIVITY started ${key} attempt=1`), 30_000);
    const killedAt = performance.now();
    const pid1 = await w1.kill();
    expect(pidExists(pid1), 'the first worker process must really be gone').toBe(false);
    expect(await effectCount('effects_guarded', key), 'the effect must not exist yet').toBe(0);

    const w2 = spawnWorker(tq);
    await w2.waitForLine((l) => l.includes(`ACTIVITY started ${key} attempt=2`), 60_000);
    const detectedSeconds = (performance.now() - killedAt) / 1000;
    const result = await handle.result();
    console.log(`[crash-recovery] before-effect: the server handed the activity to the other worker ${detectedSeconds.toFixed(1)}s after the kill including replacement startup (heartbeat timeout 2s); attempt=${result.attempt}`);
    expect(detectedSeconds, 'recovery must be driven by the 2 s heartbeat timeout, not the 60 s activity timeout').toBeLessThan(15);
    expect(result.attempt, 'the server must have run the activity again').toBeGreaterThanOrEqual(2);
    expect(await effectCount('effects_guarded', key)).toBe(1);
  }, 150_000);

  it('crash AFTER the effect, before the ack: the idempotency key keeps the effect to exactly one', async () => {
    const key = 'reserve-after-effect-guarded';
    const tq = 'crash-after-guarded-tq';
    const w1 = spawnWorker(tq);
    await w1.waitForLine((l) => l.includes('WORKER ready'), 60_000);
    const handle = await start('crash-after-guarded', tq, { effectsTable: 'effects_guarded', idempotencyKey: key, guarded: true, sleepBeforeEffectMs: 200, holdAfterEffectMs: 60_000 });
    await w1.waitForLine((l) => l.includes(`ACTIVITY effect-applied ${key}`), 30_000);
    await w1.kill();
    expect(await effectCount('effects_guarded', key), 'the effect landed before the crash').toBe(1);

    const w2 = spawnWorker(tq);
    await w2.waitForLine((l) => l.includes(`ACTIVITY already-applied ${key}`), 60_000);
    const result = await handle.result();
    expect(result).toMatchObject({ alreadyApplied: true });
    expect(result.attempt).toBeGreaterThanOrEqual(2);
    expect(await effectCount('effects_guarded', key), 'the activity ran twice but the effect happened once').toBe(1);
  }, 150_000);

  it('CONTROL: crash after the effect with NO idempotency key: the effect happens twice', async () => {
    const key = 'reserve-after-effect-plain';
    const tq = 'crash-after-plain-tq';
    const w1 = spawnWorker(tq);
    await w1.waitForLine((l) => l.includes('WORKER ready'), 60_000);
    const handle = await start('crash-after-plain', tq, { effectsTable: 'effects_plain', idempotencyKey: key, guarded: false, sleepBeforeEffectMs: 200, holdAfterEffectMs: 60_000 });
    await w1.waitForLine((l) => l.includes(`ACTIVITY effect-applied ${key} attempt=1`), 30_000);
    await w1.kill();
    const w2 = spawnWorker(tq);
    await w2.waitForLine((l) => l.includes(`ACTIVITY effect-applied ${key} attempt=2`), 60_000);
    expect(await effectCount('effects_plain', key), 'without a guard, at-least-once delivery duplicates the effect').toBe(2);
    await handle.terminate('control finished');
  }, 150_000);
});
