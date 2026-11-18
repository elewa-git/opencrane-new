import { expect, it, onTestFinished, vi } from 'vitest';
import { JetStreamApiError } from '@nats-io/jetstream';
import { manualClock } from '@opencrane/event-store/testing';
import { fixture } from './fixture.ts';
import { authorityFence } from '../src/authority.ts';

async function separateModelTime() {
  const clock = manualClock(1_000_000);
  const setup = await fixture(2000, 20000, false, 'gpt-6-luna', false,
    'manual', 'sales', undefined, { modelClock: clock });
  try {
    expect(setup.actor.store.clock).toBe(clock);
    const request = vi.spyOn(setup.nats.connection, 'request');
    onTestFinished(request.mockRestore.bind(request));
    const unavailable = new JetStreamApiError({ code: 503, err_code: 10008,
      description: 'Fixture storage unavailable' });
    request.mockRejectedValueOnce(unavailable);
    await expect(setup.actor.store.head()).resolves.toBeGreaterThan(0);
    expect(clock.now()).toBe(1_000_000);
    expect(request.mock.calls.length).toBeGreaterThan(1);
    const subjects = ['member-alice'];
    const fresh = await authorityFence(setup.actor.store, clock.now(), subjects);
    clock.advance(2000);
    await expect(fresh()).rejects.toThrow('Authority snapshot expired');
  } finally {
    await setup.close();
  }
}
it('keeps storage retries live while model access time is stopped', separateModelTime, 40_000);
