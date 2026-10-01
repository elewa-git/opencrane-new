// Pass condition 1: per-key ordering with parallelism. 100 keys x 100 events,
// random handler delays (the same seeded delays the pg-boss test uses), strict
// order judged from what the handlers themselves observed, and different keys
// measured running in parallel. A negative control (one workflow per event
// instead of one per key) must be caught by the same checker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { activityRuns } from '../../src/temporal-workflows/activities.ts';
import { analyseRuns, handlerDelayMs, keyName } from '../../src/scenario.ts';
import { waitUntil } from '../../src/util.ts';

describe('temporal: per-key FIFO order with real cross-key parallelism', () => {
  let setup: TemporalTestSetup;

  beforeAll(async () => {
    setup = await setupTemporalTest('ordering', 'ordering-tq');
  }, 120_000);

  afterAll(async () => {
    await setup?.stop();
  });

  it('runs 100 keys x 100 events in strict per-key order, in parallel across keys', async () => {
    const KEYS = 100;
    const EVENTS = 100;
    const { client, taskQueue } = setup;
    activityRuns.length = 0;

    // The dispatcher: one sequential chain per key, all chains at once, each
    // event delivered with signalWithStart (start the key's workflow if it is
    // not running, and hand it the event).
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: KEYS }, async (_, k) => {
        for (let seq = 0; seq < EVENTS; seq++) {
          await client.workflow.signalWithStart('keyedEventProcessor', {
            taskQueue,
            workflowId: keyName(k),
            args: [{ key: keyName(k), completeAfter: EVENTS }],
            signal: 'pushEvent',
            signalArgs: [{ eventId: `${keyName(k)}#${seq}`, seq, delayMs: handlerDelayMs(k, seq) }],
          });
        }
      }),
    );
    const dispatchSeconds = (performance.now() - t0) / 1000;

    // Every key's workflow ends after its 100th event.
    await Promise.all(Array.from({ length: KEYS }, (_, k) => client.workflow.getHandle(keyName(k)).result()));
    const totalSeconds = (performance.now() - t0) / 1000;

    const analysis = analyseRuns(activityRuns, KEYS, EVENTS);
    console.log(
      `[ordering] events=${analysis.totalRuns} keys=${analysis.keysSeen} dispatch=${dispatchSeconds.toFixed(1)}s ` +
        `total=${totalSeconds.toFixed(1)}s throughput=${(analysis.totalRuns / totalSeconds).toFixed(0)} events/s ` +
        `max concurrent handlers=${analysis.maxConcurrent} (worker allows 100)`,
    );
    expect(analysis.violations, 'every rule in the delivery contract must hold').toEqual([]);
    expect(analysis.totalRuns).toBe(KEYS * EVENTS);
    expect(analysis.maxConcurrent, 'different keys must run at the same time, not one by one').toBeGreaterThan(1);
  }, 300_000);

  it('NEGATIVE CONTROL: one workflow per event (no single owner per key) breaks the rules', async () => {
    const KEYS = 20;
    const EVENTS = 50;
    const { client, taskQueue } = setup;
    activityRuns.length = 0;

    const starts: Promise<unknown>[] = [];
    for (let k = 0; k < KEYS; k++) {
      for (let seq = 0; seq < EVENTS; seq++) {
        starts.push(
          client.workflow.start('singleEventWorkflow', {
            taskQueue,
            workflowId: `control-${k}-${seq}`,
            args: [{ key: keyName(k), seq, delayMs: handlerDelayMs(k, seq) }],
          }),
        );
      }
    }
    await Promise.all(starts);
    await waitUntil(() => activityRuns.length >= KEYS * EVENTS, 120_000, 100);

    const analysis = analyseRuns(activityRuns, KEYS, EVENTS);
    console.log(`[ordering-control] one workflow per event: ${analysis.violations.length}+ rule breaches, e.g. ${analysis.violations[0]}`);
    expect(analysis.violations.length, 'without a workflow per key the checker must see breaches').toBeGreaterThan(0);
  }, 150_000);
});
