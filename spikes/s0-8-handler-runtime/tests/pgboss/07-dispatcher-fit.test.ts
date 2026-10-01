// How well pg-boss fits the dispatcher described in events.md: "enqueue each
// event into key_strict_fifo, keyed by subject and deduplicated by event id".
//   1. Re-delivered events (JetStream delivers at least once) are enqueued once
//      and still run in order, even when the whole stream is re-sent mid-run.
//   2. The de-duplication has a window: it is the job's retention time, so it
//      is an optimisation, not the guarantee (the same lesson as S0.7).
//   3. Per-stream latency depends on how workers are started (the finding
//      behind the staggered workers used in the other tests).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPg, type TestPg } from '../../src/pg.ts';
import { jobIdForEvent, startBoss, startStaggeredWorkers, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { sql } from '../../src/pgboss-query.ts';
import { analyseRuns, keyName, type HandlerRun } from '../../src/scenario.ts';
import { waitUntil } from '../../src/util.ts';

interface EventData {
  eventId: string;
  key: string;
  seq: number;
}

describe('pg-boss: fit with the events.md dispatcher', () => {
  let tpg: TestPg;
  let t: TestBoss;

  beforeAll(async () => {
    tpg = await startPg('dispatcher');
    // Fast maintenance so the retention window can be observed in seconds.
    t = await startBoss(tpg.connectionString, {
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
    });
  }, 90_000);

  afterAll(async () => {
    await stopBoss(t);
    await tpg?.stop();
  });

  const enqueue = (queue: string, e: EventData) =>
    t.boss.send(queue, e, { id: jobIdForEvent(e.eventId), singletonKey: e.key });

  it('a repeated delivery of the whole stream is enqueued once and still runs in order', async () => {
    const QUEUE = 'dedupe-order';
    const KEYS = 5;
    const EVENTS = 40;
    await t.boss.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 0 });
    const runs: HandlerRun[] = [];
    await startStaggeredWorkers<EventData>(t.boss, QUEUE, 10, { pollingIntervalSeconds: 0.5 }, async (job) => {
      const start = performance.now();
      await new Promise((r) => setTimeout(r, 3));
      runs.push({ key: job.data.key, seq: job.data.seq, start, end: performance.now() });
    });

    const events: EventData[] = [];
    for (let seq = 0; seq < EVENTS; seq++) {
      for (let k = 0; k < KEYS; k++) events.push({ eventId: `${keyName(k)}#${seq}`, key: keyName(k), seq });
    }
    let accepted = 0;
    let ignored = 0;
    const deliverAll = async () => {
      // One chain per key, as a real dispatcher feeding streams would do.
      await Promise.all(
        Array.from({ length: KEYS }, async (_, k) => {
          for (const e of events.filter((x) => x.key === keyName(k))) {
            if ((await enqueue(QUEUE, e)) === null) ignored++;
            else accepted++;
          }
        }),
      );
    };
    await deliverAll(); // first delivery
    await deliverAll(); // the consumer restarts and delivers everything again, while handlers are still running
    await waitUntil(() => runs.length >= KEYS * EVENTS, 60_000, 100);
    await new Promise((r) => setTimeout(r, 1500)); // time for any duplicate that slipped through to show up
    await t.boss.offWork(QUEUE);

    console.log(`[dispatcher] first delivery accepted=${accepted} duplicates ignored=${ignored} runs=${runs.length}`);
    expect(accepted).toBe(KEYS * EVENTS);
    expect(ignored).toBe(KEYS * EVENTS);
    const analysis = analyseRuns(runs, KEYS, EVENTS); // also fails on a lost or duplicated run
    expect(analysis.violations).toEqual([]);
    expect(t.errors).toEqual([]);
  }, 120_000);

  it('the de-duplication only lasts as long as the completed job is kept', async () => {
    const QUEUE = 'dedupe-window';
    await t.boss.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 0, deleteAfterSeconds: 1 });
    let runs = 0;
    await startStaggeredWorkers<EventData>(t.boss, QUEUE, 3, { pollingIntervalSeconds: 0.5 }, async () => {
      runs++;
    });
    const event: EventData = { eventId: 'evt-window-1', key: 'window-key', seq: 0 };
    expect(await enqueue(QUEUE, event)).not.toBeNull();
    await waitUntil(() => runs === 1, 15_000, 100);
    expect(await enqueue(QUEUE, event), 'while the completed job is kept, a repeat is ignored').toBeNull();

    // Wait for pg-boss to delete the completed job (retention 1 s plus a maintenance pass).
    const id = jobIdForEvent(event.eventId);
    await waitUntil(async () => Number((await sql<{ n: string }>(tpg.connectionString, `SELECT count(*) AS n FROM pgboss.job WHERE id = $1`, [id]))[0]!.n) === 0, 40_000, 500);
    expect(await enqueue(QUEUE, event), 'after the job is deleted, the same event id is accepted again').not.toBeNull();
    await waitUntil(() => runs === 2, 15_000, 100);
    console.log('[dispatcher] after the retention window the same event id ran a second time (handlers must be idempotent by event id)');
    await t.boss.offWork(QUEUE);
  }, 120_000);

  it('a backlog on ONE key drains far faster with staggered workers than with workers started together', async () => {
    const JOBS = 30;
    const drain = async (label: string, start: (queue: string, handler: () => Promise<void>) => Promise<void>) => {
      const queue = `drain-${label}`;
      await t.boss.createQueue(queue, { policy: 'key_strict_fifo', retryLimit: 0 });
      let done = 0;
      const handler = async () => {
        await new Promise((r) => setTimeout(r, 2));
        done++;
      };
      for (let i = 0; i < JOBS; i++) await t.boss.send(queue, { i }, { singletonKey: 'hot-stream' });
      const t0 = performance.now();
      await start(queue, handler);
      await waitUntil(() => done === JOBS, 120_000, 50);
      const seconds = (performance.now() - t0) / 1000;
      await t.boss.offWork(queue);
      return seconds;
    };
    const together = await drain('together', async (queue, handler) => {
      // 20 workers created by one call: they wake at the same instant every interval.
      await t.boss.work(queue, { localConcurrency: 20, batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => handler());
    });
    const staggered = await drain('staggered', async (queue, handler) => {
      await startStaggeredWorkers(t.boss, queue, 20, { pollingIntervalSeconds: 0.5 }, async () => handler());
    });
    console.log(
      `[dispatcher] ${JOBS} events on one key: workers started together ${together.toFixed(1)}s (${(JOBS / together).toFixed(1)} events/s), ` +
        `staggered ${staggered.toFixed(1)}s (${(JOBS / staggered).toFixed(1)} events/s)`,
    );
    expect(staggered, 'staggering the workers must make a single hot stream drain much faster').toBeLessThan(together / 3);
    expect(t.errors).toEqual([]);
  }, 200_000);
});
