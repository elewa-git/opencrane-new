// Pass condition 5: the budget actor. A single writer per key answers
// synchronous reserve and settle requests; p50/p99 for 1,000 sequential and
// 100 concurrent reserve calls; no overspend under concurrency.
//
// Temporal has a native request/response call for this: an Update sent to a
// long-running workflow (one workflow per budget key). Variants:
//   memory    the answer is computed in the workflow only (nothing is written);
//   activity  every answer is first written to PostgreSQL by an activity;
//   local     the same write as a local activity. This is an OBSERVATION, not a
//             pass: under concurrent Updates a few were rejected by the worker
//             and the durable log then held more than the workflow had
//             accepted. It is not used for the decision.
// The durable activity variant is the fair comparison with pg-boss, whose
// handler writes to PostgreSQL before it answers. A negative control removes
// the workflow's lock and must overspend: Update handlers that await something
// are interleaved, so the single writer is something the code has to keep.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { newPool } from '../../src/pg.ts';
import { createBudgetTables, replayLog } from '../../src/budget-store.ts';
import { percentile } from '../../src/util.ts';
import type { BudgetAnswer, BudgetRequest } from '../../src/temporal-workflows/workflows.ts';

type Durable = 'none' | 'activity' | 'local';

describe('temporal: budget actor, one workflow per key, synchronous Update answers', () => {
  let setup: TemporalTestSetup;
  let pool: pg.Pool;
  let connectionString = '';
  const isDev = process.env.S08_TEMPORAL_BACKEND === 'dev';

  beforeAll(async () => {
    setup = await setupTemporalTest('budget', 'budget-tq');
    if (!('tpg' in setup.server)) return; // The dev-only command selects the memory benchmark.
    connectionString = setup.server.tpg.connectionString;
    pool = newPool(connectionString, 20); // the same PostgreSQL, a different database from Temporal's
    await createBudgetTables(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await setup?.stop();
  });

  async function startActor(key: string, ceilingCents: number, durable: Durable, serialise: boolean, entryDelayMs?: number) {
    if (isDev && durable !== 'none') throw new Error('Durable budget tests require PostgreSQL');
    const handle = await setup.client.workflow.start('budgetActorWorkflow', {
      taskQueue: setup.taskQueue,
      workflowId: `budget-${key}`,
      args: [{ key, ceilingCents, connectionString, durable, serialise, entryDelayMs }],
    });
    const call = async (req: Omit<BudgetRequest, 'requestId'>) => {
      const started = performance.now();
      const answer = (await handle.executeUpdate('budget', { args: [{ ...req, requestId: randomUUID() }] })) as BudgetAnswer;
      return { answer, latencyMs: performance.now() - started };
    };
    const balance = () => handle.query<{ reservedCents: number; ceilingCents: number; handled: number }>('balance');
    return { handle, call, balance };
  }

  async function measure(label: string, durable: Durable) {
    // --- 1,000 sequential reserve calls ---
    const seqKey = `${label}-seq`;
    const seq = await startActor(seqKey, 1_000_000, durable, true);
    const seqLatencies: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const { answer, latencyMs } = await seq.call({ op: 'reserve', amountCents: 1 });
      expect(answer.accepted).toBe(true);
      seqLatencies.push(latencyMs);
    }
    expect((await seq.balance()).reservedCents).toBe(1000);
    if (durable !== 'none') expect(await replayLog(pool, seqKey)).toMatchObject({ entries: 1000, finalBalanceCents: 1000 });
    // Each Update adds events to the workflow's history; the limit is 51,200 events per run.
    const historyLength = (await seq.handle.describe()).historyLength;
    console.log(`[budget-actor:${label}] history after 1000 Updates: ${historyLength} events (${(historyLength / 1000).toFixed(1)} per request; hard limit 51,200 per run)`);
    expect(historyLength, 'the history grows with every request, so a long-lived actor must continue as new').toBeGreaterThan(1000);
    await seq.handle.terminate('measured');

    // --- 100 concurrent reserve calls on ONE key; only half fit under the ceiling ---
    const AMOUNT_CENTS = 10;
    const CALLS = 100;
    const CEILING_CENTS = (AMOUNT_CENTS * CALLS) / 2;
    const concKey = `${label}-conc`;
    const conc = await startActor(concKey, CEILING_CENTS, durable, true);
    const t0 = performance.now();
    const outcomes = await Promise.all(Array.from({ length: CALLS }, () => conc.call({ op: 'reserve', amountCents: AMOUNT_CENTS })));
    const wallMs = performance.now() - t0;
    const accepted = outcomes.filter((o) => o.answer.accepted);
    const stats = {
      seqP50: percentile(seqLatencies, 50),
      seqP99: percentile(seqLatencies, 99),
      concP50: percentile(outcomes.map((o) => o.latencyMs), 50),
      concP99: percentile(outcomes.map((o) => o.latencyMs), 99),
      concWallMs: wallMs,
    };
    console.log(
      `[budget-actor:${label}] 1000 sequential: p50=${stats.seqP50.toFixed(1)}ms p99=${stats.seqP99.toFixed(1)}ms | ` +
        `100 concurrent on one key: wall=${wallMs.toFixed(0)}ms p50=${stats.concP50.toFixed(0)}ms p99=${stats.concP99.toFixed(0)}ms accepted=${accepted.length}/${CALLS}`,
    );
    expect(accepted.length, 'exactly the requests that fit under the ceilingCents are accepted').toBe(CEILING_CENTS / AMOUNT_CENTS);
    expect((await conc.balance()).reservedCents).toBe(CEILING_CENTS);
    if (durable !== 'none') {
      const log = await replayLog(pool, concKey);
      expect(log.entries).toBe(CEILING_CENTS / AMOUNT_CENTS);
      expect(log.maxRunningCents, 'the durable log never passes the ceilingCents at any moment').toBeLessThanOrEqual(CEILING_CENTS);
      expect(log.finalBalanceCents).toBe(CEILING_CENTS);
    }
    return { stats, conc, accepted, CEILING_CENTS, AMOUNT_CENTS, concKey };
  }

  it('memory only: 1,000 sequential and 100 concurrent reserves, no overspend', async () => {
    const { stats, conc, accepted } = await measure('memory', 'none');
    expect(stats.seqP99).toBeLessThan(1000);
    const settles = await Promise.all(accepted.map(() => conc.call({ op: 'settle', amountCents: 6, reservedAmountCents: 10 })));
    expect(settles.every((s) => s.answer.accepted)).toBe(true);
    expect((await conc.balance()).reservedCents).toBe(300);
    const more = await Promise.all(Array.from({ length: 30 }, () => conc.call({ op: 'reserve', amountCents: 10 })));
    expect(more.filter((r) => r.answer.accepted)).toHaveLength(20);
    expect((await conc.balance()).reservedCents).toBe(500);
    await conc.handle.terminate('measured');
  }, 200_000);

  it('durable (activity): same measurements, then concurrent settles, with the log checked at every step', async () => {
    const { stats, conc, accepted, CEILING_CENTS, AMOUNT_CENTS, concKey } = await measure('activity', 'activity');
    expect(stats.seqP99).toBeLessThan(1000);

    // Settle: every accepted hold of 10 is replaced by the 6 actually used, all at once.
    const settles = await Promise.all(accepted.map(() => conc.call({ op: 'settle', amountCents: 6, reservedAmountCents: AMOUNT_CENTS })));
    expect(settles.every((s) => s.answer.accepted)).toBe(true);
    expect((await conc.balance()).reservedCents).toBe(50 * 6);
    // The freed room is usable again: 300 + 20 x 10 = 500, so exactly 20 of 30 new holds fit.
    const more = await Promise.all(Array.from({ length: 30 }, () => conc.call({ op: 'reserve', amountCents: AMOUNT_CENTS })));
    expect(more.filter((m) => m.answer.accepted)).toHaveLength(20);
    const log = await replayLog(pool, concKey);
    expect(log.maxRunningCents, 'the log never passed the ceilingCents, through reserves and settles').toBeLessThanOrEqual(CEILING_CENTS);
    expect(log.finalBalanceCents).toBe(CEILING_CENTS);
    expect((await conc.balance()).reservedCents).toBe(CEILING_CENTS);
    await conc.handle.terminate('measured');
  }, 250_000);

  const unsafeLocal = process.env.S08_UNSAFE_LOCAL === '1' ? it : it.skip;
  unsafeLocal('REJECTED variant: local activity must not write more than the actor accepts', async () => {
    const CEILING_CENTS = 500;
    const AMOUNT_CENTS = 10;
    const seq = await startActor('local-seq', 1_000_000, 'local', true);
    for (let i = 0; i < 200; i++) expect((await seq.call({ op: 'reserve', amountCents: 1 })).answer.accepted).toBe(true);
    await seq.handle.terminate('observed');

    const conc = await startActor('local-conc', CEILING_CENTS, 'local', true);
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => conc.call({ op: 'reserve', amountCents: AMOUNT_CENTS })));
    const answered = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ answer: BudgetAnswer }>[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    const reasons = new Set(
      rejected.map((r) => {
        const reason = r.reason as { cause?: { type?: string }; name?: string };
        return reason.cause?.type ?? reason.name ?? 'unknown';
      }),
    );
    const accepted = answered.filter((r) => r.value.answer.accepted).length;
    const log = await replayLog(pool, 'local-conc');
    console.log(
      `[budget-actor:local] 100 concurrent Updates, local-activity write: answered=${answered.length} (accepted ${accepted}) rejected=${rejected.length} (${[...reasons].join(',') || 'none'}); ` +
        `highest running balance in the durable log=${log.maxRunningCents} (ceilingCents ${CEILING_CENTS}); workflow balance=${(await conc.balance()).reservedCents}`,
    );
    // This correctness assertion replaces the previous tautological green observation.
    expect(answered.length + rejected.length).toBe(100);
    expect(log.maxRunningCents, 'external effects must respect the ceiling even across workflow task replay').toBeLessThanOrEqual(CEILING_CENTS);
    expect(log.finalBalanceCents).toBe((await conc.balance()).reservedCents);
    await conc.handle.terminate('observed');
  }, 200_000);

  it('NEGATIVE CONTROL: without the workflow lock the same actor overspends', async () => {
    const key = 'control';
    const CEILING_CENTS = 500;
    // Each durable write takes an extra 90-300 ms (random), so requests overlap: later ones pass the ceiling check
    // while earlier ones have not recorded their change yet. (The server lets at most 10 Updates be in flight per workflow.)
    const control = await startActor(key, CEILING_CENTS, 'activity', false, 300);
    const outcomes = await Promise.all(Array.from({ length: 100 }, () => control.call({ op: 'reserve', amountCents: 10 })));
    const accepted = outcomes.filter((o) => o.answer.accepted).length;
    const log = await replayLog(pool, key);
    console.log(`[budget-actor:control] without the lock: accepted=${accepted} (limit 50), highest running balance in the log=${log.maxRunningCents} (ceilingCents ${CEILING_CENTS})`);
    expect(accepted, 'interleaved Update handlers must accept more than fit, otherwise the lock proves nothing').toBeGreaterThan(CEILING_CENTS / 10);
    expect(log.maxRunningCents).toBeGreaterThan(CEILING_CENTS);
    await control.handle.terminate('measured');
  }, 120_000);
});
