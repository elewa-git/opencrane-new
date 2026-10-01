// Pass condition 2: retries with backoff and a dead letter after N attempts;
// a poison event holds back ONLY its own key and is never skipped; other keys
// keep flowing; once the operator fixes the cause, the held event runs first
// and its successors follow in order.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPg, type TestPg } from '../../src/pg.ts';
import { startBoss, startStaggeredWorkers, stopBoss, type TestBoss } from '../../src/pgboss-util.ts';
import { queryJobs } from '../../src/pgboss-query.ts';
import { waitUntil } from '../../src/util.ts';

const QUEUE = 'retry-test';
const DLQ = 'retry-test-dlq';
const GOOD_KEYS = 9;
const EVENTS_PER_GOOD_KEY = 5;
const POISON_KEY = 'key-poison';
const RETRY_LIMIT = 3; // 1 first attempt + 3 retries = 4 attempts

interface EventData {
  key: string;
  seq: number;
}

describe('pg-boss: retry with backoff, dead letter, poison blocks only its own key', () => {
  let tpg: TestPg;
  let t: TestBoss;

  beforeAll(async () => {
    tpg = await startPg('retry');
    t = await startBoss(tpg.connectionString);
    await t.boss.createQueue(DLQ, { retryLimit: 0 });
    await t.boss.createQueue(QUEUE, {
      policy: 'key_strict_fifo',
      retryLimit: RETRY_LIMIT,
      retryBackoff: true,
      retryDelay: 1,
      retryDelayMax: 3,
      deadLetter: DLQ,
    });
  }, 90_000);

  afterAll(async () => {
    await stopBoss(t);
    await tpg?.stop();
  });

  it('good keys flow while the poison key retries; it dead-letters, stays held, and resumes in order once fixed', async () => {
    let poisonFixed = false;
    const goodDone: { key: string; seq: number }[] = [];
    const poisonAttempts: { seq: number; at: number }[] = [];
    const poisonCompleted: number[] = [];

    await startStaggeredWorkers<EventData>(t.boss, QUEUE, 10, { pollingIntervalSeconds: 0.5 }, async (job) => {
      const { key, seq } = job.data;
      if (key === POISON_KEY) {
        poisonAttempts.push({ seq, at: performance.now() });
        if (seq === 0 && !poisonFixed) throw new Error('boom: the poison event always fails');
        poisonCompleted.push(seq);
        return;
      }
      goodDone.push({ key, seq });
    });

    // The poison key's events arrive first, then the good keys' events.
    for (let seq = 0; seq < 3; seq++) {
      await t.boss.send(QUEUE, { key: POISON_KEY, seq } satisfies EventData, { singletonKey: POISON_KEY });
    }
    for (let seq = 0; seq < EVENTS_PER_GOOD_KEY; seq++) {
      for (let k = 0; k < GOOD_KEYS; k++) {
        await t.boss.send(QUEUE, { key: `good-${k}`, seq } satisfies EventData, { singletonKey: `good-${k}` });
      }
    }

    // 1. Every good-key event finishes while the poison key is still retrying.
    await waitUntil(() => goodDone.length === GOOD_KEYS * EVENTS_PER_GOOD_KEY, 30_000, 100);
    const goodDoneAt = performance.now();
    const poisonRetriesFinishedBeforeGood = poisonAttempts.length > RETRY_LIMIT;
    expect(poisonRetriesFinishedBeforeGood, 'good keys must not wait for the poison key to give up').toBe(false);

    // 2. The poison event uses all its attempts, then is dead-lettered.
    await waitUntil(async () => {
      const [head] = await queryJobs(tpg.connectionString, QUEUE, { singletonKey: POISON_KEY });
      return head?.state === 'failed';
    }, 40_000, 200);
    expect(poisonAttempts.length).toBe(RETRY_LIMIT + 1);
    expect(goodDoneAt).toBeLessThan(poisonAttempts[poisonAttempts.length - 1]!.at);

    // Backoff is real. With a fixed 1 s delay the three gaps could not add up
    // to more than about 4.5 s (3 x 1 s plus up to 0.5 s of polling each).
    // Exponential backoff with a 3 s cap gives clearly more, and no gap may
    // be shorter than the one before it (allowing for polling jitter).
    const gaps = poisonAttempts.slice(1).map((a, i) => (a.at - poisonAttempts[i]!.at) / 1000);
    console.log(`[retry] gaps between attempts (s): ${gaps.map((g) => g.toFixed(2)).join(', ')}`);
    expect(gaps).toHaveLength(RETRY_LIMIT);
    expect(
      gaps.reduce((sum, g) => sum + g, 0),
      'total retry wait must exceed what a fixed 1 s delay could give',
    ).toBeGreaterThan(5);
    expect(gaps[RETRY_LIMIT - 1]!, 'later gaps must not shrink').toBeGreaterThanOrEqual(gaps[0]! - 0.6);

    const dlq = await queryJobs(tpg.connectionString, DLQ);
    expect(dlq.map((j) => (j.data as unknown as EventData).key), 'the failed event must be in the dead-letter queue').toEqual([
      POISON_KEY,
    ]);
    expect(dlq[0]?.sourceName).toBe(QUEUE);

    // 3. Strict FIFO: seq 1 and seq 2 of the poison key are held, not skipped, not lost.
    const poisonRows = await queryJobs(tpg.connectionString, QUEUE, { singletonKey: POISON_KEY });
    expect(poisonRows.map((j) => `${(j.data as unknown as EventData).seq}:${j.state}`)).toEqual([
      '0:failed',
      '1:created',
      '2:created',
    ]);
    expect(poisonCompleted, 'no successor may run while the head is unresolved').toEqual([]);
    // The runtime reports which streams are held by a failure (the "streams held" alert metric).
    expect(await t.boss.getBlockedKeys(QUEUE)).toEqual([POISON_KEY]);

    // 4. The operator fixes the cause and retries the held event IN PLACE.
    // It must run first, then seq 1, then seq 2: nothing skipped, order kept.
    poisonFixed = true;
    const [headRow] = poisonRows;
    await t.boss.retry(QUEUE, headRow!.id);
    await waitUntil(() => poisonCompleted.length === 3, 30_000, 100);
    expect(poisonCompleted, 'the held event runs first, then its successors, in order').toEqual([0, 1, 2]);
    expect(await t.boss.getBlockedKeys(QUEUE)).toEqual([]);
    expect(t.errors).toEqual([]);
    await t.boss.offWork(QUEUE);
  }, 120_000);

  it('redrive is the wrong operator tool for a strict FIFO queue: the copy goes to the back and the key stays held', async () => {
    const Q = 'redrive-test';
    const DLQ2 = 'redrive-test-dlq';
    await t.boss.createQueue(DLQ2, { retryLimit: 0 });
    await t.boss.createQueue(Q, { policy: 'key_strict_fifo', retryLimit: 0, deadLetter: DLQ2 });
    let fixed = false;
    const ran: number[] = [];
    await startStaggeredWorkers<EventData>(t.boss, Q, 4, { pollingIntervalSeconds: 0.5 }, async (job) => {
      if (job.data.seq === 0 && !fixed) throw new Error('boom');
      ran.push(job.data.seq);
    });
    await t.boss.send(Q, { key: 'k', seq: 0 } satisfies EventData, { singletonKey: 'k' });
    await t.boss.send(Q, { key: 'k', seq: 1 } satisfies EventData, { singletonKey: 'k' });
    await waitUntil(async () => (await queryJobs(tpg.connectionString, DLQ2)).length === 1, 20_000, 100);

    fixed = true;
    expect(await t.boss.redrive(DLQ2)).toBe(1);
    await new Promise((r) => setTimeout(r, 2500));
    const states = (await queryJobs(tpg.connectionString, Q)).map((j) => `${(j.data as unknown as EventData).seq}:${j.state}`);
    console.log(`[retry] after redrive the queue holds ${JSON.stringify(states)}; handlers ran ${JSON.stringify(ran)}`);
    expect(states, 'the redriven copy is queued behind seq 1, and the failed head still holds the key').toEqual(['0:failed', '1:created', '0:created']);
    expect(ran, 'nothing runs: redrive did not release the key').toEqual([]);
    expect(await t.boss.getBlockedKeys(Q)).toEqual(['k']);

    // Releasing the real head now runs seq 0, seq 1, and then the redriven copy of seq 0 again: a repeat, out of order.
    const [head] = await queryJobs(tpg.connectionString, Q, { singletonKey: 'k' });
    await t.boss.retry(Q, head!.id);
    await waitUntil(() => ran.length === 3, 20_000, 100);
    expect(ran).toEqual([0, 1, 0]);
    await t.boss.offWork(Q);
  }, 90_000);
});
