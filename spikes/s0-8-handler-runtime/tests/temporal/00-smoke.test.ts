import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTemporalTest, type TemporalTestSetup } from '../../src/temporal-test-harness.ts';
import { waitUntil } from '../../src/util.ts';
import type { KeyedProcessorState } from '../../src/temporal-workflows/workflows.ts';

describe('smoke: production-shaped Temporal Server on PostgreSQL, a worker and a client', () => {
  let setup: TemporalTestSetup;

  beforeAll(async () => {
    setup = await setupTemporalTest('smoke', 'smoke-tq');
  }, 120_000);

  afterAll(async () => {
    await setup?.stop();
  });

  it('starts a keyed workflow with a signal and reads its state back', async () => {
    const { client, taskQueue } = setup;
    const info = await client.workflowService.getSystemInfo({});
    expect(info.serverVersion).toBe('1.32.0');

    for (let seq = 0; seq < 2; seq++) {
      await client.workflow.signalWithStart('keyedEventProcessor', {
        taskQueue,
        workflowId: 'smoke-key',
        args: [{ key: 'smoke-key' }],
        signal: 'pushEvent',
        signalArgs: [{ eventId: `smoke-${seq}`, seq }],
      });
    }
    const handle = client.workflow.getHandle('smoke-key');
    await waitUntil(async () => (await handle.query<KeyedProcessorState>('state')).processedCount === 2, 20_000, 100);
    const state = await handle.query<KeyedProcessorState>('state');
    expect(state.processedTail).toEqual([0, 1]);
    await handle.terminate('smoke test finished');
  }, 60_000);
});
