import { expect, it, onTestFinished, vi } from 'vitest';
import { manualClock } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { fixture } from './fixture.ts';
import { permit, prepare, send } from './support/mcp-dispatch-fixture.ts';

async function dispatchWithClock(expired: boolean) {
  const clock = manualClock(1_000_000);
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false,
    'manual', 'sales', undefined, { clock });
  try {
    const headers = await prepare(setup);
    const value = await permit(setup, headers);
    const store = setup.nats.store;
    const append = store.append.bind(store);
    let admitted = false;
    let finalChecks = 0;
    async function appendAdmission(command: Parameters<typeof append>[0]) {
      const result = await append(command);
      const parsed = parseEventByType(command.event);
      if (!parsed.success) throw new Error('Invalid fixture event');
      if (parsed.event.type === 'mcp.dispatch_admitted' && result.status === 'appended') {
        admitted = true;
      }
      return result;
    }
    function checkFinalRoute() {
      if (!admitted) return;
      // Run after the last awaited checks, just before the synchronous send guard.
      finalChecks += 1;
      clock.advance(expired ? 2000 : 1999);
    }
    const admission = vi.spyOn(store, 'append').mockImplementation(appendAdmission);
    onTestFinished(admission.mockRestore.bind(admission));
    setup.dispatchOptions.requireCatalogue = checkFinalRoute;
    const response = await send(setup, value);
    const text = await response.text();
    admission.mockRestore();
    expect(admitted).toBe(true);
    expect(finalChecks).toBe(1);
    expect(response.status, text).toBe(expired ? 403 : 200);
    expect(setup.received()).toBe(expired ? 0 : 1);
  } finally {
    await setup.close();
  }
}
it.each([false, true])('uses manual time through tool admission and send (expired: %s)',
  dispatchWithClock, 40_000);
