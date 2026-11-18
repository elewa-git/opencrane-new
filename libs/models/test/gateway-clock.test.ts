import { expect, it, onTestFinished, vi } from 'vitest';
import { systemClock } from '@opencrane/event-store';
import { manualClock } from '@opencrane/event-store/testing';
import { gatewayFixture } from './gateway-delivery-fixture.ts';

async function controlledReadinessRetry() {
  const clock = manualClock(1_000_000);
  const sleep = clock.sleep.bind(clock);
  const entered = Promise.withResolvers<void>();
  const sleeping = vi.spyOn(clock, 'sleep');
  function wait(milliseconds: number, signal?: AbortSignal) {
    entered.resolve();
    return sleep(milliseconds, signal);
  }
  sleeping.mockImplementation(wait);
  onTestFinished(sleeping.mockRestore.bind(sleeping));
  const fetchOriginal = globalThis.fetch;
  let delayed = false;
  const fetchWithDelay: typeof fetch = function fetchWithDelay(input, init) {
    const url = input instanceof Request ? input.url : input.toString();
    if (!delayed && url.endsWith('/healthz/ready')) {
      delayed = true;
      const responseOptions = { status: 503 };
      return Promise.resolve(new Response('', responseOptions));
    }
    return fetchOriginal(input, init);
  };
  const fetching = vi.spyOn(globalThis, 'fetch');
  fetching.mockImplementation(fetchWithDelay);
  onTestFinished(fetching.mockRestore.bind(fetching));
  let finished = false;
  function started(setup: Awaited<ReturnType<typeof gatewayFixture>>) {
    finished = true;
    return setup;
  }
  function failed(error: unknown): never {
    finished = true;
    throw new Error('Gateway startup failed', { cause: error });
  }
  function ignoredClock(): never {
    throw new Error('Gateway ignored its injected retry clock');
  }
  const clockOptions = { clock };
  const starting = gatewayFixture(clockOptions);
  const checked = starting.then(started, failed);
  const ignored = checked.then(ignoredClock);
  await Promise.race([entered.promise, ignored]);
  expect(sleeping).toHaveBeenCalledWith(50);
  clock.advance(49);
  await Promise.resolve();
  expect(finished).toBe(false);
  clock.advance(1);
  while (!finished) {
    // Wait for the real gateway process, while advancing only the requested retry sleeps.
    await systemClock.sleep(50);
    clock.advance(50);
  }
  const setup = await checked;
  expect(setup.gateway.healthy()).toBe(true);
}
it('waits for the named manual clock before retrying gateway readiness', controlledReadinessRetry);
