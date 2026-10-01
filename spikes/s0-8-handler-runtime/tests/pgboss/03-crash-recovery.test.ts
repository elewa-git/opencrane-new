// Pass condition 3: crash recovery. A worker process is killed (SIGKILL, a
// real process death) in the middle of a handler. The event must be handed to
// another worker, and with an idempotency key the effect must land exactly once.
//
// The tests kill at two different moments, because they are different risks:
//   - before the effect was written: redelivery just runs the handler again;
//   - after the effect was written but before the job was marked done: the
//     handler runs a second time, so only the idempotency key (or a
//     transaction) stops the effect from happening twice.
// Two control runs prove these checks have teeth: with no idempotency key the
// effect really does happen twice.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { exec, queryJobs, sql } from '../../src/pgboss-query.ts';
import { pidExists, spawnNodeTs, type LineProcess } from '../../src/proc.ts';
import { waitUntil } from '../../src/util.ts';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../src/crash-worker.ts');

describe('pg-boss: crash recovery and exactly-once effects', () => {
  let tpg: TestPg;
  let t: TestBoss;
  const spawned: LineProcess[] = [];

  const spawnWorker = (queue: string, mode: string, table: string, sleepBefore: number, holdAfter: number) => {
    const w = spawnNodeTs(WORKER_PATH, [tpg.connectionString, queue, mode, table, String(sleepBefore), String(holdAfter)]);
    spawned.push(w);
    return w;
  };
  const effectCount = async (table: string, key: string) =>
    Number((await sql<{ n: string }>(tpg.connectionString, `SELECT count(*) AS n FROM ${table} WHERE idempotency_key = $1`, [key]))[0]!.n);

  beforeAll(async () => {
    tpg = await startPg('crash');
    await exec(tpg.connectionString, `CREATE TABLE effects_guarded (idempotency_key text PRIMARY KEY, applied_at timestamptz NOT NULL)`);
    await exec(tpg.connectionString, `CREATE TABLE effects_plain (idempotency_key text, applied_at timestamptz NOT NULL)`);
    await exec(tpg.connectionString, `CREATE TABLE effects_tx (idempotency_key text, applied_at timestamptz NOT NULL)`);
    // This instance only sets up queues and runs pg-boss's own maintenance
    // (which reclaims jobs whose worker died). It never works jobs itself.
    t = await startBoss(tpg.connectionString, { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1 });
  }, 90_000);

  afterAll(async () => {
    await Promise.all(spawned.map((w) => w.kill().catch(() => undefined)));
    await stopBoss(t);
    await tpg?.stop();
  });

  it('crash BEFORE the effect: the job is redelivered and the effect lands once', async () => {
    const queue = 'crash-before';
    const key = 'reserve-before-effect';
    await t.boss.createQueue(queue, { expireInSeconds: 5, retryLimit: 3, retryDelay: 0 });
    await t.boss.send(queue, { idempotencyKey: key });

    const w1 = spawnWorker(queue, 'guarded', 'effects_guarded', 2000, 0);
    await w1.waitForLine((l) => l.includes(`WORKER started ${key}`), 20_000);
    await new Promise((r) => setTimeout(r, 300));
    const pid1 = await w1.kill();
    expect(pidExists(pid1), 'the first worker process must really be gone').toBe(false);
    expect(await effectCount('effects_guarded', key), 'the effect must not exist yet').toBe(0);

    // A replacement process (a restarted Pod). Recovery needs no human step.
    const w2 = spawnWorker(queue, 'guarded', 'effects_guarded', 300, 0);
    await w2.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 30_000);
    await waitUntil(async () => (await queryJobs(tpg.connectionString, queue))[0]?.state === 'completed', 15_000, 200);

    const [job] = await queryJobs(tpg.connectionString, queue);
    expect(job?.retryCount, 'pg-boss must record that the job was attempted again').toBeGreaterThanOrEqual(1);
    expect(await effectCount('effects_guarded', key)).toBe(1);
  }, 120_000);

  it('crash AFTER the effect, before the ack: the idempotency key keeps the effect to exactly one', async () => {
    const queue = 'crash-after-guarded';
    const key = 'reserve-after-effect-guarded';
    await t.boss.createQueue(queue, { expireInSeconds: 5, retryLimit: 3, retryDelay: 0 });
    await t.boss.send(queue, { idempotencyKey: key });

    const w1 = spawnWorker(queue, 'guarded', 'effects_guarded', 200, 60_000);
    await w1.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 20_000);
    await w1.kill();
    expect(await effectCount('effects_guarded', key), 'the effect landed before the crash').toBe(1);

    const w2 = spawnWorker(queue, 'guarded', 'effects_guarded', 200, 0);
    await w2.waitForLine((l) => l.includes(`WORKER already-applied ${key}`), 30_000);
    await waitUntil(async () => (await queryJobs(tpg.connectionString, queue))[0]?.state === 'completed', 15_000, 200);

    const [job] = await queryJobs(tpg.connectionString, queue);
    expect(job?.retryCount).toBeGreaterThanOrEqual(1);
    expect(await effectCount('effects_guarded', key), 'the handler ran twice but the effect happened once').toBe(1);
  }, 120_000);

  it('CONTROL: crash after the effect with NO idempotency key: the effect happens twice', async () => {
    const queue = 'crash-after-plain';
    const key = 'reserve-after-effect-plain';
    await t.boss.createQueue(queue, { expireInSeconds: 5, retryLimit: 3, retryDelay: 0 });
    await t.boss.send(queue, { idempotencyKey: key });

    const w1 = spawnWorker(queue, 'unguarded', 'effects_plain', 200, 60_000);
    await w1.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 20_000);
    await w1.kill();
    const w2 = spawnWorker(queue, 'unguarded', 'effects_plain', 200, 0);
    await waitUntil(async () => (await queryJobs(tpg.connectionString, queue))[0]?.state === 'completed', 40_000, 200);

    expect(await effectCount('effects_plain', key), 'without a guard, at-least-once delivery duplicates the effect').toBe(2);
    void w2;
  }, 120_000);

  it('transactional worker: a crash rolls back the effect with the job, so it lands once with no extra guard', async () => {
    const queue = 'crash-transactional';
    const key = 'reserve-transactional';
    await t.boss.createQueue(queue, { expireInSeconds: 5, retryLimit: 3, retryDelay: 0 });
    await t.boss.send(queue, { idempotencyKey: key });

    const w1 = spawnWorker(queue, 'transactional', 'effects_tx', 200, 60_000);
    await w1.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 20_000);
    await w1.kill();
    // The write was inside the handler's transaction, which died with the process.
    await waitUntil(async () => (await effectCount('effects_tx', key)) === 0, 15_000, 200);

    const w2 = spawnWorker(queue, 'transactional', 'effects_tx', 200, 0);
    await w2.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 30_000);
    await waitUntil(async () => (await queryJobs(tpg.connectionString, queue))[0]?.state === 'completed', 15_000, 200);
    expect(await effectCount('effects_tx', key)).toBe(1);
  }, 120_000);

  it('heartbeat: a long-running handler on a queue with heartbeats is recovered about 10 s after the crash', async () => {
    const queue = 'crash-heartbeat';
    const key = 'reserve-heartbeat';
    // expireInSeconds is long (a handler may legitimately run for minutes);
    // the heartbeat is what notices a dead worker. pg-boss requires >= 10 s.
    await t.boss.createQueue(queue, { expireInSeconds: 600, heartbeatSeconds: 10, retryLimit: 3, retryDelay: 0 });
    await t.boss.send(queue, { idempotencyKey: key });

    const w1 = spawnWorker(queue, 'guarded', 'effects_guarded', 60_000, 0);
    await w1.waitForLine((l) => l.includes(`WORKER started ${key}`), 20_000);
    await new Promise((r) => setTimeout(r, 500));
    const killedAt = performance.now();
    await w1.kill();

    const w2 = spawnWorker(queue, 'guarded', 'effects_guarded', 200, 0);
    await w2.waitForLine((l) => l.includes(`WORKER effect-applied ${key}`), 60_000);
    const recoverySeconds = (performance.now() - killedAt) / 1000;
    console.log(`[crash-recovery] heartbeat queue: killed worker recovered and finished after ${recoverySeconds.toFixed(1)}s`);
    expect(recoverySeconds, 'recovery must wait for the missing heartbeat, not the 600 s expiry').toBeLessThan(45);
    expect(recoverySeconds, 'pg-boss cannot detect a dead worker faster than its heartbeat period').toBeGreaterThan(5);
    await waitUntil(async () => (await queryJobs(tpg.connectionString, queue))[0]?.state === 'completed', 15_000, 200);
    expect(await effectCount('effects_guarded', key)).toBe(1);
    expect(t.errors).toEqual([]);
  }, 150_000);
});
