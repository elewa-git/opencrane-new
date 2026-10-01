// Pass condition 4, the Web UI part. The production-shaped server runs only
// Temporal's own services; its Web UI is a separate program (a container
// image in a Kubernetes install). The official `temporal` dev server bundles
// the same UI, so this test runs the dev server once to prove the UI exists,
// serves its page, and is backed by an API that shows attempts and errors.
// (The UI's pages are drawn in the browser, so no screenshot is taken; the
// JSON API behind them is read instead.)
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, Client as WorkflowClient } from '@temporalio/client';
import { Worker, NativeConnection } from '@temporalio/worker';
import { startTemporalDev, type TestTemporalDev } from '../../src/temporal.ts';
import { installQuietRuntime, WORKFLOWS_PATH } from '../../src/temporal-test-harness.ts';
import * as activities from '../../src/temporal-workflows/activities.ts';
import { waitUntil } from '../../src/util.ts';

describe('temporal: the Web UI and the API behind it (dev server)', () => {
  let dev: TestTemporalDev;
  let worker: Worker;
  let workerRun: Promise<void>;
  let nativeConnection: NativeConnection;
  let connection: Connection;

  beforeAll(async () => {
    installQuietRuntime();
    dev = await startTemporalDev('ui', { ui: true });
    nativeConnection = await NativeConnection.connect({ address: dev.address });
    worker = await Worker.create({ connection: nativeConnection, namespace: dev.namespace, taskQueue: 'ui-tq', workflowsPath: WORKFLOWS_PATH, activities });
    workerRun = worker.run();
    connection = await Connection.connect({ address: dev.address });
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await connection?.close();
    await nativeConnection?.close();
    await dev?.stop();
  });

  it('serves the Web UI and shows the pending activity, its attempt and its last error', async () => {
    const client = new WorkflowClient({ connection, namespace: dev.namespace });
    const handle = await client.workflow.signalWithStart('keyedEventProcessor', {
      taskQueue: 'ui-tq',
      workflowId: 'ui-key',
      args: [{ key: 'ui-key', slowRetry: true }],
      signal: 'pushEvent',
      signalArgs: [{ eventId: 'ui-key#0', seq: 0, failUntilAttempt: 3 }],
    });

    const ui = `http://${dev.uiAddress}`;
    // The UI is up and serves its single-page app.
    const root = await fetch(ui);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(await root.text()).toContain('/_app/immutable/');
    const settings = (await (await fetch(`${ui}/api/v1/settings`)).json()) as { Version?: string };
    console.log(`[web-ui] Temporal Web UI version ${settings.Version}`);
    expect(settings.Version).toMatch(/^\d+\.\d+\.\d+/);

    // The UI's own backend API, the one the workflow page calls. While the event is retrying
    // it shows the pending activity with its attempt number and the last error.
    let activity: { attempt?: number; lastFailure?: { message?: string } } | undefined;
    await waitUntil(async () => {
      const r = await fetch(`${ui}/api/v1/namespaces/${dev.namespace}/workflows/ui-key`);
      if (!r.ok) return false;
      const body = (await r.json()) as { pendingActivities?: { attempt?: number; lastFailure?: { message?: string } }[] };
      activity = body.pendingActivities?.[0];
      return (activity?.attempt ?? 0) >= 2 && Boolean(activity?.lastFailure?.message);
    }, 30_000, 100);
    console.log(`[web-ui] UI API for workflow ui-key: attempt=${activity?.attempt} lastFailure="${activity?.lastFailure?.message}"`);
    expect(activity?.lastFailure?.message).toContain('deliberate failure');

    // The UI's workflow list and history endpoints answer too.
    const list = (await (await fetch(`${ui}/api/v1/namespaces/${dev.namespace}/workflows?query=${encodeURIComponent("WorkflowId = 'ui-key'")}`)).json()) as { executions?: unknown[] };
    expect(list.executions).toHaveLength(1);
    const history = (await (await fetch(`${ui}/api/v1/namespaces/${dev.namespace}/workflows/ui-key/history`)).json()) as { history?: { events?: unknown[] } };
    expect(history.history?.events?.length ?? 0).toBeGreaterThan(3);
    await handle.terminate('ui test finished');
  }, 90_000);
});
