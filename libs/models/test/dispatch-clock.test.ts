import { expect, it } from 'vitest';
import { manualClock } from '@opencrane/event-store/testing';
import { fixture } from './fixture.ts';
import { permit, prepare, send } from './support/mcp-dispatch-fixture.ts';

async function dispatchWithClock(expired: boolean) {
  const clock = manualClock(1_000_000);
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false,
    'manual', 'sales', undefined, { clock });
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    if (expired) clock.advance(2001);
    const response = await send(setup, value);
    const text = await response.text();
    expect(response.status, text).toBe(expired ? 403 : 200);
    expect(setup.received()).toBe(expired ? 0 : 1);
  } finally {
    await setup.close();
  }
}
it.each([false, true])('uses manual time through tool admission and send (expired: %s)',
  dispatchWithClock, 40_000);
