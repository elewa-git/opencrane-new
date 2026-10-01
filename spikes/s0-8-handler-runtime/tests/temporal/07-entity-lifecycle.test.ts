// How well Temporal fits the dispatcher in events.md, and the cost of
// running one long-lived workflow per stream.
//   1. A re-delivered event is handled once and order holds (the workflow
//      remembers event ids; the workflow itself is the single owner).
//   2. A stream that lives for a long time needs continue-as-new, because a
//      workflow's history is capped. Events keep their order and none are lost
//      or repeated while the workflow restarts underneath a steady stream of
//      signals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { activityRuns } from '../../src/temporal-workflows/activities.ts';
import { analyseRuns, keyName } from '../../src/scenario.ts';
import { waitUntil } from '../../src/util.ts';
import type { KeyedProcessorState } from '../../src/temporal-workflows/workflows.ts';

describe('temporal: one workflow per stream, over time', () => {
  let setup: TemporalTestSetup;

  beforeAll(async () => {
    setup = await setupTemporalTest('lifecycle', 'lifecycle-tq');
  }, 120_000);

  afterAll(async () => {
    await setup?.stop();
  });

  it('repeated deliveries of the whole stream (during and after processing) are handled once and still run in order', async () => {
    const KEYS = 5;
    const EVENTS = 40;
    const { client, taskQueue } = setup;
    activityRuns.length = 0;
    const deliverAll = () =>
      Promise.all(
        Array.from({ length: KEYS }, async (_, k) => {
          for (let seq = 0; seq < EVENTS; seq++) {
            await client.workflow.signalWithStart('keyedEventProcessor', {
              taskQueue,
              workflowId: `dedupe-${keyName(k)}`,
              args: [{ key: keyName(k) }],
              signal: 'pushEvent',
              signalArgs: [{ eventId: `${keyName(k)}#${seq}`, seq, delayMs: 3 }],
            });
          }
        }),
      );
    // Two deliveries at the same time (the consumer restarted and re-sent everything) ...
    await Promise.all([deliverAll(), deliverAll()]);
    const processedAll = async () => {
      const states = await Promise.all(
        Array.from({ length: KEYS }, (_, k) => client.workflow.getHandle(`dedupe-${keyName(k)}`).query<KeyedProcessorState>('state')),
      );
      return states.every((s) => s.processedCount === EVENTS);
    };
    await waitUntil(processedAll, 60_000, 100);
    // ... and a third delivery long after every event was handled.
    await deliverAll();
    await new Promise((r) => setTimeout(r, 1000));

    const analysis = analyseRuns(activityRuns, KEYS, EVENTS); // also fails on a lost or duplicated run
    expect(analysis.violations).toEqual([]);
    const states = await Promise.all(
      Array.from({ length: KEYS }, (_, k) => client.workflow.getHandle(`dedupe-${keyName(k)}`).query<KeyedProcessorState>('state')),
    );
    // Every delivery beyond the first of each event id was recognised and dropped: 2 extra deliveries x 40 events per key.
    expect(states.map((s) => s.duplicatesIgnored)).toEqual(Array.from({ length: KEYS }, () => 2 * EVENTS));
    await Promise.all(Array.from({ length: KEYS }, (_, k) => client.workflow.getHandle(`dedupe-${keyName(k)}`).terminate('done')));
  }, 120_000);

  it('continues as new every 50 events under a steady stream of signals: no event lost, repeated or reordered', async () => {
    const TOTAL = 400;
    const PER_RUN = 50;
    const KEY = 'long-lived-key';
    const { client, taskQueue } = setup;
    activityRuns.length = 0;

    // Signals are sent one after another while the workflow keeps restarting underneath.
    for (let seq = 0; seq < TOTAL; seq++) {
      await client.workflow.signalWithStart('keyedEventProcessor', {
        taskQueue,
        workflowId: KEY,
        args: [{ key: KEY, maxEventsPerRun: PER_RUN, completeAfter: TOTAL }],
        signal: 'pushEvent',
        signalArgs: [{ eventId: `${KEY}#${seq}`, seq, delayMs: 2 }],
      });
    }
    // The chain of runs ends when the last event has been handled.
    await waitUntil(() => activityRuns.filter((r) => r.key === KEY).length >= TOTAL, 120_000, 100);
    await new Promise((r) => setTimeout(r, 1500));

    const analysis = analyseRuns(activityRuns.filter((r) => r.key === KEY), 1, TOTAL);
    expect(analysis.violations, 'order, no loss and no repeat across every restart').toEqual([]);

    // The runs really did restart: one execution per 50 events, each with a short history.
    const runs: { runId: string; historyLength: number; status: string }[] = [];
    for await (const w of client.workflow.list({ query: `WorkflowId = '${KEY}'` })) {
      runs.push({ runId: w.runId, historyLength: w.historyLength ?? 0, status: w.status.name });
    }
    const longest = Math.max(...runs.map((r) => r.historyLength));
    console.log(`[lifecycle] ${TOTAL} events across ${runs.length} runs of workflow ${KEY}; longest history ${longest} events (limit 51,200); statuses ${[...new Set(runs.map((r) => r.status))].join(',')}`);
    expect(runs.length, 'continue-as-new must have produced several runs').toBeGreaterThanOrEqual(TOTAL / PER_RUN);
    expect(longest, 'every run stays far below the history limit').toBeLessThan(2000);
    expect(runs.filter((r) => r.status === 'CONTINUED_AS_NEW').length).toBeGreaterThanOrEqual(TOTAL / PER_RUN - 1);

    const finalState = await client.workflow.getHandle(KEY).query<KeyedProcessorState>('state').catch(() => undefined);
    if (finalState) expect(finalState.runNumber).toBeGreaterThanOrEqual(TOTAL / PER_RUN);
  }, 240_000);
});
