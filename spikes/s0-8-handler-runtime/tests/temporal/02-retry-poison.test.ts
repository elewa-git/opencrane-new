// Pass condition 2: retries with backoff and a dead letter after N attempts;
// a poison event holds back ONLY its own key and is never skipped; other keys
// keep flowing; once the operator fixes the cause, the held event runs first
// and its successors follow in order.
//
// Temporal has no dead-letter queue as such. The same job is done by the
// workflow: when an activity has used all its attempts, the workflow records
// the failure, stops advancing THAT key, and waits for an operator signal.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { activityRuns, attemptLog, control } from '../../src/temporal-workflows/activities.ts';
import { analyseRuns } from '../../src/scenario.ts';
import { waitUntil } from '../../src/util.ts';
import type { KeyedProcessorState } from '../../src/temporal-workflows/workflows.ts';

const GOOD_KEYS = 9;
const EVENTS_PER_GOOD_KEY = 5;

describe('temporal: retry with backoff, dead letter, poison blocks only its own key', () => {
  let setup: TemporalTestSetup;

  beforeAll(async () => {
    setup = await setupTemporalTest('retry-poison', 'retry-poison-tq');
  }, 120_000);

  afterAll(async () => {
    await setup?.stop();
  });

  const send = (key: string, seq: number, extra: Record<string, unknown> = {}, slowRetry = false) =>
    setup.client.workflow.signalWithStart('keyedEventProcessor', {
      taskQueue: setup.taskQueue,
      workflowId: key,
      args: [{ key, slowRetry }],
      signal: 'pushEvent',
      signalArgs: [{ eventId: `${key}#${seq}`, seq, ...extra }],
    });
  const state = (key: string) => setup.client.workflow.getHandle(key).query<KeyedProcessorState>('state');

  it('good keys flow while the poison key retries; it dead-letters, stays held, and resumes in order once fixed', async () => {
    activityRuns.length = 0;
    attemptLog.length = 0;
    control.poisonFixed = false;
    const POISON = 'poison-key';

    // The poison key's events arrive first, then the good keys' events.
    await send(POISON, 0, { poison: true }, true);
    await send(POISON, 1, {}, true);
    await send(POISON, 2, {}, true);
    for (let seq = 0; seq < EVENTS_PER_GOOD_KEY; seq++) {
      for (let k = 0; k < GOOD_KEYS; k++) await send(`good-${k}`, seq);
    }

    // 1. Every good-key event finishes while the poison event is still retrying.
    await waitUntil(async () => {
      const states = await Promise.all(Array.from({ length: GOOD_KEYS }, (_, k) => state(`good-${k}`)));
      return states.every((s) => s.processedCount === EVENTS_PER_GOOD_KEY);
    }, 30_000, 100);
    const poisonWhileGoodDone = await state(POISON);
    expect(poisonWhileGoodDone.deadLetter, 'the poison event must still be retrying when the good keys finish').toBeNull();

    // 2. The poison event uses all four attempts, then is dead-lettered.
    await waitUntil(async () => (await state(POISON)).deadLetter !== null, 30_000, 100);
    const held = await state(POISON);
    expect(held.deadLetter?.seq).toBe(0);
    expect(held.deadLetter?.message).toContain('deliberate failure');
    const attempts = attemptLog.filter((a) => a.key === POISON && a.seq === 0);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3, 4]);
    const gaps = attempts.slice(1).map((a, i) => (a.at - attempts[i]!.at) / 1000);
    console.log(`[retry] gaps between attempts (s): ${gaps.map((g) => g.toFixed(2)).join(', ')}`);
    // Configured: 1 s, then 2 s and 4 s. A fixed delay would give equal gaps.
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]!, 'a gap must never be shorter than the one before').toBeGreaterThanOrEqual(gaps[i - 1]! - 0.2);
    }
    expect(gaps[gaps.length - 1]!, 'the last gap must be several times the first (exponential backoff)').toBeGreaterThan(gaps[0]! * 3);

    // 3. Never skipped: seq 1 and 2 are still queued behind the held head; nothing of this key ran.
    expect(held.queue.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(activityRuns.filter((r) => r.key === POISON)).toEqual([]);

    // 4. The operator fixes the cause and retries the held event IN PLACE.
    control.poisonFixed = true;
    await setup.client.workflow.getHandle(POISON).signal('retryHead');
    await waitUntil(async () => (await state(POISON)).processedCount === 3, 30_000, 100);
    const poisonRuns = activityRuns.filter((r) => r.key === POISON);
    expect(analyseRuns(poisonRuns, 1, 3).violations, 'the held event runs first, then its successors, in order').toEqual([]);
    const done = await state(POISON);
    expect(done.deadLetter).toBeNull();
    expect(done.skipped).toEqual([]);
  }, 120_000);

  it('the operator can also skip the held event on purpose; the skip is recorded and the successors run', async () => {
    activityRuns.length = 0;
    control.poisonFixed = false;
    const KEY = 'poison-skip-key';
    await send(KEY, 0, { poison: true });
    await send(KEY, 1);
    await waitUntil(async () => (await state(KEY)).deadLetter !== null, 30_000, 100);
    await setup.client.workflow.getHandle(KEY).signal('skipHead');
    await waitUntil(async () => (await state(KEY)).processedCount === 1, 30_000, 100);
    const s = await state(KEY);
    expect(s.skipped.map((x) => x.eventId)).toEqual([`${KEY}#0`]);
    expect(activityRuns.filter((r) => r.key === KEY).map((r) => r.seq)).toEqual([1]);
  }, 60_000);
});
