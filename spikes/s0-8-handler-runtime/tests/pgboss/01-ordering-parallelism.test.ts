// Pass condition 1: per-key ordering with parallelism. 100 keys x 100 events,
// random handler delays; strict order per key judged from what the handlers
// themselves observed, and different keys measured running in parallel.
// Also a negative control: the same kind of load on a queue WITHOUT per-key
// ordering must be caught by the same checker, so the PASS cannot be vacuous.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, startStaggeredWorkers, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { analyseRuns, handlerDelayMs, keyName, type HandlerRun } from '../../src/scenario.ts';
import { waitUntil } from '../../src/util.ts';

interface EventData {
  keyIndex: number;
  key: string;
  seq: number;
}

describe('pg-boss: per-key FIFO order with real cross-key parallelism', () => {
  let tpg: TestPg;
  let t: TestBoss;

  beforeAll(async () => {
    tpg = await startPg('order');
    // The queue cache and the monitor feed the "burst" fetch mode, so both are
    // set to one second here (the default is a minute).
    t = await startBoss(tpg.connectionString, { queueCacheIntervalSeconds: 1, monitorIntervalSeconds: 1 });
  }, 90_000);

  afterAll(async () => {
    await stopBoss(t);
    await tpg?.stop();
  });

  it('runs 100 keys x 100 events in strict per-key order, in parallel across keys', async () => {
    const KEYS = 100;
    const EVENTS = 100;
    const QUEUE = 'ordering';
    await t.boss.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 0 });

    const runs: HandlerRun[] = [];
    // 40 single-slot workers started 12 ms apart (see startStaggeredWorkers);
    // burst mode lets a worker fetch again at once while a backlog exists.
    await startStaggeredWorkers<EventData>(
      t.boss,
      QUEUE,
      40,
      { pollingIntervalSeconds: 0.5, burstWhenReadyExceeds: 1 },
      async (job) => {
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, handlerDelayMs(job.data.keyIndex, job.data.seq)));
        runs.push({ key: job.data.key, seq: job.data.seq, start, end: performance.now() });
      },
    );

    // The dispatcher: one sequential chain per key, all 100 chains at once.
    // A real dispatcher feeding one stream also sends that stream's events
    // one after another, so created-times within a key strictly increase.
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: KEYS }, async (_, k) => {
        for (let seq = 0; seq < EVENTS; seq++) {
          await t.boss.send(QUEUE, { keyIndex: k, key: keyName(k), seq } satisfies EventData, {
            singletonKey: keyName(k),
          });
        }
      }),
    );
    const dispatchSeconds = (performance.now() - t0) / 1000;

    await waitUntil(() => runs.length >= KEYS * EVENTS, 280_000, 100);
    const totalSeconds = (performance.now() - t0) / 1000;
    await t.boss.offWork(QUEUE);

    const analysis = analyseRuns(runs, KEYS, EVENTS);
    console.log(
      `[ordering] events=${analysis.totalRuns} keys=${analysis.keysSeen} dispatch=${dispatchSeconds.toFixed(1)}s ` +
        `total=${totalSeconds.toFixed(1)}s throughput=${(analysis.totalRuns / totalSeconds).toFixed(0)} events/s ` +
        `max concurrent handlers=${analysis.maxConcurrent} (40 workers)`,
    );
    expect(analysis.violations, 'every rule in the delivery contract must hold').toEqual([]);
    expect(analysis.totalRuns).toBe(KEYS * EVENTS);
    expect(analysis.maxConcurrent, 'different keys must run at the same time, not one by one').toBeGreaterThan(1);
    expect(t.errors).toEqual([]);
  }, 300_000);

  it('NEGATIVE CONTROL: the same load on a queue without per-key ordering breaks the rules', async () => {
    const KEYS = 20;
    const EVENTS = 50;
    const QUEUE = 'ordering-control';
    await t.boss.createQueue(QUEUE, { policy: 'standard', retryLimit: 0 });

    const runs: HandlerRun[] = [];
    await startStaggeredWorkers<EventData>(t.boss, QUEUE, 20, { pollingIntervalSeconds: 0.5 }, async (job) => {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, handlerDelayMs(job.data.keyIndex, job.data.seq)));
      runs.push({ key: job.data.key, seq: job.data.seq, start, end: performance.now() });
    });
    // A burst on one stream: all of a key's events arrive together, so many
    // events of the same key are waiting at the same moment.
    for (let k = 0; k < KEYS; k++) {
      for (let seq = 0; seq < EVENTS; seq++) {
        await t.boss.send(QUEUE, { keyIndex: k, key: keyName(k), seq } satisfies EventData);
      }
    }
    await waitUntil(() => runs.length >= KEYS * EVENTS, 120_000, 100);
    await t.boss.offWork(QUEUE);

    const analysis = analyseRuns(runs, KEYS, EVENTS);
    console.log(`[ordering-control] standard queue: ${analysis.violations.length}+ rule breaches, e.g. ${analysis.violations[0]}`);
    expect(analysis.violations.length, 'without key_strict_fifo the checker must see breaches').toBeGreaterThan(0);
  }, 150_000);
});
