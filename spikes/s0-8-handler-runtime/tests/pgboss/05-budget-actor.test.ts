// Pass condition 5: the budget actor. A single writer per key answers
// synchronous reserve and settle requests; p50/p99 for 1,000 sequential and
// 100 concurrent reserve calls; no overspend under concurrency.
//
// pg-boss has no request/response call: send() returns a job id, not an
// answer. This test builds the bridge a gateway would need. The request is a
// job on a key_strict_fifo queue (one writer per budget key, enforced by
// pg-boss), the handler writes its answer with pg_notify, and the caller waits
// on a LISTEN connection. That reply path goes through PostgreSQL, so the
// caller and the worker could be different processes.
//
// The handler is a read-then-write that corrupts the balance if two copies
// run at once on one key (src/budget-store.ts). A negative control runs the
// same handler on a queue with no per-key ordering and must overspend.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newPool, startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, startStaggeredWorkers, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import {
  applyBudgetRequest,
  createBudget,
  createBudgetTables,
  readBudget,
  replayLog,
  type BudgetAnswer,
  type BudgetRequest,
} from '../../src/budget-store.ts';
import { percentile } from '../../src/util.ts';

const REPLY_CHANNEL = 'budget_reply';

interface Bridge {
  request: (req: Omit<BudgetRequest, 'requestId'>) => Promise<{ answer: BudgetAnswer; latencyMs: number }>;
  close: () => Promise<void>;
}

describe('pg-boss: budget actor, one writer per key, synchronous answers', () => {
  let tpg: TestPg;
  let t: TestBoss; // polling configuration (staggered workers, no NOTIFY)
  let tNotify: TestBoss; // NOTIFY configuration
  let pool: pg.Pool;
  let listener: pg.Client;
  const waiting = new Map<string, (a: BudgetAnswer) => void>();

  /** Caller side of the bridge: enqueue a request on `queue` and wait for the NOTIFY reply. */
  function bridgeFor(boss: TestBoss, queue: string, useKey: boolean): Bridge {
    return {
      request: async (req) => {
        const requestId = randomUUID();
        const started = performance.now();
        const reply = new Promise<BudgetAnswer>((resolve) => waiting.set(requestId, resolve));
        await boss.boss.send(queue, { ...req, requestId } satisfies BudgetRequest, {
          id: requestId,
          ...(useKey ? { singletonKey: req.key } : {}),
        });
        const answer = await reply;
        return { answer, latencyMs: performance.now() - started };
      },
      close: async () => undefined,
    };
  }

  /** Worker side: apply the request, then answer through pg_notify. */
  const handle = async (req: BudgetRequest, gapMs = 1) => {
    const answer = await applyBudgetRequest(pool, req, gapMs);
    await pool.query(`SELECT pg_notify($1, $2)`, [REPLY_CHANNEL, JSON.stringify(answer)]);
  };

  beforeAll(async () => {
    tpg = await startPg('budget');
    pool = newPool(tpg.connectionString, 30);
    await createBudgetTables(pool);

    listener = new pg.Client({ connectionString: tpg.connectionString });
    await listener.connect();
    await listener.query(`LISTEN ${REPLY_CHANNEL}`);
    listener.on('notification', (msg) => {
      const answer = JSON.parse(msg.payload ?? '{}') as BudgetAnswer;
      const resolve = waiting.get(answer.requestId);
      if (resolve) {
        waiting.delete(answer.requestId);
        resolve(answer);
      }
    });

    t = await startBoss(tpg.connectionString);
    tNotify = await startBoss(tpg.connectionString, { useListenNotify: true });
  }, 90_000);

  afterAll(async () => {
    await stopBoss(t);
    await stopBoss(tNotify);
    await listener?.end().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await tpg?.stop();
  });

  /** 1,000 sequential reserves, then 100 concurrent reserves on one key; returns the numbers. */
  async function measure(label: string, bridge: Bridge) {
    // --- 1,000 sequential reserve calls ---
    const seqKey = `seq-${label}`;
    await createBudget(pool, seqKey, 1_000_000);
    const seqLatencies: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const { answer, latencyMs } = await bridge.request({ op: 'reserve', key: seqKey, amountCents: 1 });
      expect(answer.accepted).toBe(true);
      seqLatencies.push(latencyMs);
    }
    const seqState = await readBudget(pool, seqKey);
    expect(seqState.reservedCents, 'every accepted reserve must be reflected in the balance').toBe(1000);
    expect(seqState.logged).toBe(1000);

    // --- 100 concurrent reserve calls on ONE key; only half fit under the ceiling ---
    const concKey = `conc-${label}`;
    const AMOUNT_CENTS = 10;
    const CALLS = 100;
    const CEILING_CENTS = (AMOUNT_CENTS * CALLS) / 2;
    await createBudget(pool, concKey, CEILING_CENTS);
    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: CALLS }, () => bridge.request({ op: 'reserve', key: concKey, amountCents: AMOUNT_CENTS })),
    );
    const wallMs = performance.now() - t0;
    const accepted = outcomes.filter((o) => o.answer.accepted);
    const concState = await readBudget(pool, concKey);

    const stats = {
      seqP50: percentile(seqLatencies, 50),
      seqP99: percentile(seqLatencies, 99),
      concP50: percentile(outcomes.map((o) => o.latencyMs), 50),
      concP99: percentile(outcomes.map((o) => o.latencyMs), 99),
      concWallMs: wallMs,
      accepted: accepted.length,
    };
    console.log(
      `[budget-actor:${label}] 1000 sequential: p50=${stats.seqP50.toFixed(1)}ms p99=${stats.seqP99.toFixed(1)}ms | ` +
        `100 concurrent on one key: wall=${(wallMs / 1000).toFixed(1)}s p50=${stats.concP50.toFixed(0)}ms p99=${stats.concP99.toFixed(0)}ms accepted=${accepted.length}/${CALLS}`,
    );

    // Inspect the independent test ledger as well as the replies. This is a stub, not the event store.
    expect(accepted.length, 'exactly the requests that fit under the ceilingCents are accepted').toBe(CEILING_CENTS / AMOUNT_CENTS);
    expect(concState.reservedCents, 'the balance equals the accepted total').toBe(CEILING_CENTS);
    expect(concState.reservedCents, 'never above the ceilingCents').toBeLessThanOrEqual(CEILING_CENTS);
    expect(concState.logged, 'one log entry per accepted request').toBe(CEILING_CENTS / AMOUNT_CENTS);
    const log = await replayLog(pool, concKey);
    expect(log.maxRunningCents).toBeLessThanOrEqual(CEILING_CENTS);
    expect(log.finalBalanceCents).toBe(CEILING_CENTS);
    return { stats, concKey, acceptedRequests: accepted, AMOUNT_CENTS, CEILING_CENTS };
  }

  it('polling configuration: 1,000 sequential and 100 concurrent reserves, then concurrent settles, with no overspend', async () => {
    const QUEUE = 'budget-poll';
    await t.boss.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 0 });
    // Staggered single-slot workers, no NOTIFY: a request that waits behind
    // another on the same key is picked up within about interval / workers.
    await startStaggeredWorkers<BudgetRequest>(t.boss, QUEUE, 20, { pollingIntervalSeconds: 0.5 }, async (job) => handle(job.data));
    const bridge = bridgeFor(t, QUEUE, true);
    const { stats, concKey, acceptedRequests, AMOUNT_CENTS, CEILING_CENTS } = await measure('poll', bridge);
    expect(stats.seqP99, 'sequential p99 must stay bounded').toBeLessThan(1000);

    // --- settle: every accepted hold of 10 is replaced by the 6 actually used, all at once ---
    const settles = await Promise.all(
      acceptedRequests.map(() => bridge.request({ op: 'settle', key: concKey, amountCents: 6, reservedAmountCents: AMOUNT_CENTS })),
    );
    expect(settles.every((s) => s.answer.accepted)).toBe(true);
    const afterSettle = await readBudget(pool, concKey);
    expect(afterSettle.reservedCents, '50 holds of 10 settled to 6 each').toBe(50 * 6);

    // The freed room is usable again: 300 + 20 x 10 = 500, so exactly 20 of 30 new holds fit.
    const more = await Promise.all(Array.from({ length: 30 }, () => bridge.request({ op: 'reserve', key: concKey, amountCents: AMOUNT_CENTS })));
    expect(more.filter((m) => m.answer.accepted)).toHaveLength((CEILING_CENTS - afterSettle.reservedCents) / AMOUNT_CENTS);
    expect((await readBudget(pool, concKey)).reservedCents).toBe(CEILING_CENTS);
    await t.boss.offWork(QUEUE);
    expect(t.errors).toEqual([]);
  }, 280_000);

  it('NOTIFY configuration: same measurements; fast when sequential, slow when many wait on one key', async () => {
    const QUEUE = 'budget-notify';
    await tNotify.boss.createQueue(QUEUE, { policy: 'key_strict_fifo', retryLimit: 0, notify: true });
    await tNotify.boss.work<BudgetRequest>(
      QUEUE,
      { localConcurrency: 20, batchSize: 1, pollingIntervalSeconds: 0.5, notifyPollingIntervalSeconds: 0.5 },
      async (jobs) => {
        const job = jobs[0];
        if (job) await handle(job.data);
      },
    );
    const { stats } = await measure('notify', bridgeFor(tNotify, QUEUE, true));
    expect(stats.seqP99).toBeLessThan(1000);
    await tNotify.boss.offWork(QUEUE);
    expect(tNotify.errors).toEqual([]);
  }, 280_000);

  it('NEGATIVE CONTROL: the same handler with no per-key ordering overspends', async () => {
    const QUEUE = 'budget-control';
    await t.boss.createQueue(QUEUE, { policy: 'standard', retryLimit: 0 });
    // 20 workers created together all fetch at the same instant, so up to 20 handlers run at once,
    // and a 5 ms read-to-write gap makes the overlap certain, not just likely.
    await t.boss.work<BudgetRequest>(QUEUE, { localConcurrency: 20, batchSize: 1, pollingIntervalSeconds: 0.5 }, async (jobs) => {
      const job = jobs[0];
      if (job) await handle(job.data, 5);
    });
    const bridge = bridgeFor(t, QUEUE, false);

    const key = 'control';
    const AMOUNT_CENTS = 10;
    const CALLS = 100;
    const CEILING_CENTS = 500;
    await createBudget(pool, key, CEILING_CENTS);
    const outcomes = await Promise.all(Array.from({ length: CALLS }, () => bridge.request({ op: 'reserve', key, amountCents: AMOUNT_CENTS })));
    const accepted = outcomes.filter((o) => o.answer.accepted).length;
    const state = await readBudget(pool, key);
    console.log(`[budget-actor:control] without per-key ordering: accepted=${accepted} (limit 50), balance=${state.reservedCents} (ceilingCents ${CEILING_CENTS})`);
    expect(accepted, 'two writers on one key must accept more than fit, otherwise the real test proves nothing').toBeGreaterThan(
      CEILING_CENTS / AMOUNT_CENTS + 10,
    );
    await t.boss.offWork(QUEUE);
  }, 120_000);
});
