// Pass condition 4: per-handler visibility. Can you see, per handler, the
// runs, attempts, errors and logs, with no screenshots?
//
// One keyed workflow handles three events: one clean, one flaky (fails twice,
// then works) and one poison. Everything is read back through the APIs the
// Web UI itself uses: describe (pending activity with attempt and last
// error), the event history, and the visibility list (SQL on PostgreSQL),
// over gRPC and over the HTTP API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { attemptLog, control } from '../../src/temporal-workflows/activities.ts';
import { waitUntil } from '../../src/util.ts';
import type { KeyedProcessorState } from '../../src/temporal-workflows/workflows.ts';

describe('temporal: per-handler visibility without a screenshot', () => {
  let setup: TemporalTestSetup;

  beforeAll(async () => {
    setup = await setupTemporalTest('visibility', 'visibility-tq');
  }, 120_000);

  afterAll(async () => {
    await setup?.stop();
  });

  it('shows attempts, last error, history and listings for a handler through the APIs', async () => {
    const { client, taskQueue, server } = setup;
    control.poisonFixed = false;
    attemptLog.length = 0;
    const KEY = 'visibility-key';
    const send = (seq: number, extra: Record<string, unknown> = {}) =>
      client.workflow.signalWithStart('keyedEventProcessor', {
        taskQueue,
        workflowId: KEY,
        args: [{ key: KEY, slowRetry: true }],
        signal: 'pushEvent',
        signalArgs: [{ eventId: `${KEY}#${seq}`, seq, ...extra }],
      });
    await send(0);
    await send(1, { failUntilAttempt: 2 });
    await send(2, { poison: true });
    const handle = client.workflow.getHandle(KEY);

    // ---- 1. While the flaky event is between attempts: the pending activity ----
    let pending: { attempt: number; lastFailure: string | undefined; activityType: string | undefined } | undefined;
    await waitUntil(async () => {
      const description = await handle.describe();
      const p = description.raw.pendingActivities?.[0];
      if (p && (p.attempt ?? 0) >= 2 && p.lastFailure?.message) {
        pending = { attempt: p.attempt ?? 0, lastFailure: p.lastFailure.message, activityType: p.activityType?.name ?? undefined };
        return true;
      }
      return false;
    }, 30_000, 50);
    console.log(`[visibility] pending activity while retrying: ${JSON.stringify(pending)}`);
    expect(pending?.activityType).toBe('applyEvent');
    expect(pending?.lastFailure).toContain('deliberate failure');
    expect(pending?.lastFailure).toMatch(/attempt=1/); // the error of the attempt that just failed

    // ---- 2. After the poison event exhausts its attempts ----------------------
    await waitUntil(async () => (await handle.query<KeyedProcessorState>('state')).deadLetter !== null, 40_000, 100);
    const state = await handle.query<KeyedProcessorState>('state');
    expect(state.processedCount).toBe(2);
    expect(state.deadLetter).toMatchObject({ seq: 2 });

    // The activity's own log of every attempt (the application writes this; Temporal does not keep it).
    const flaky = attemptLog.filter((a) => a.seq === 1);
    console.log(`[visibility] application attempt log (volatile): ${JSON.stringify(attemptLog)}`);
    expect(flaky.map((a) => `${a.attempt}:${a.failed ? 'failed' : 'ok'}`)).toEqual(['1:failed', '2:failed', '3:ok']);

    // ---- 3. Event history: what survives a retry ------------------------------
    const history = await handle.fetchHistory();
    const events = history.events ?? [];
    const started = events.filter((e) => e.activityTaskStartedEventAttributes);
    const failed = events.filter((e) => e.activityTaskFailedEventAttributes);
    console.log(`[visibility] history: ${events.length} events; activity starts recorded with attempt numbers ${JSON.stringify(started.map((e) => e.activityTaskStartedEventAttributes?.attempt))}`);
    // The history keeps ONE Started event per activity, carrying the attempt that finally ended it,
    // and one Failed event for the poison event carrying only the LAST error.
    expect(started.map((e) => e.activityTaskStartedEventAttributes?.attempt)).toEqual([1, 3, 4]);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.activityTaskFailedEventAttributes?.failure?.message).toContain('attempt=4');
    const allMessages = JSON.stringify(events.map((e) => e.activityTaskFailedEventAttributes?.failure?.message ?? null));
    expect(allMessages, 'the earlier failed attempts are not in the history').not.toContain('attempt=1');

    // ---- 4. Listing and counting handlers' executions (visibility on PostgreSQL) ----
    const listed: string[] = [];
    for await (const w of client.workflow.list({ query: `WorkflowType = 'keyedEventProcessor' AND ExecutionStatus = 'Running'` })) listed.push(w.workflowId);
    expect(listed).toContain(KEY);
    const count = await client.workflow.count(`WorkflowType = 'keyedEventProcessor'`);
    expect(count.count).toBeGreaterThanOrEqual(1);

    // ---- 5. The same through the HTTP API ------------------------------------
    const base = `http://${server.httpAddress}/api/v1/namespaces/${server.namespace}`;
    const listBody = (await (await fetch(`${base}/workflows?query=${encodeURIComponent(`WorkflowId = '${KEY}'`)}`)).json()) as {
      executions?: { execution?: { workflowId?: string }; status?: string }[];
    };
    expect(listBody.executions?.[0]?.execution?.workflowId).toBe(KEY);
    expect(listBody.executions?.[0]?.status).toBe('WORKFLOW_EXECUTION_STATUS_RUNNING');
    console.log(`[visibility] HTTP API list: ${JSON.stringify(listBody.executions?.[0]?.status)} for ${KEY}`);
    await handle.terminate('visibility test finished');
  }, 120_000);
});
