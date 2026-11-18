import { expect, it, onTestFinished, vi } from 'vitest';
import { manualClock, natsFixture } from '@opencrane/event-store/testing';
import { prepareCeilingChange } from '../src/ceiling-command.ts';
import { emptyBudget } from '../src/state.ts';

async function ceilingPreparationBoundary(elapsed: number) {
  const clock = manualClock(1_000_000);
  const nats = await natsFixture({ clock });
  onTestFinished(nats.close.bind(nats));
  const actor = { store: nats.store, silo: 'test', state: emptyBudget() };
  const read = vi.spyOn(nats.store, 'readStream');
  function fresh() {
    clock.advance(elapsed);
    return Promise.resolve();
  }
  const payload = { scope: 'global', ceilingCents: 100, dailyCeilingCents: 100,
    setBy: 'alice' };
  const preparing = prepareCeilingChange(actor, payload, 'ceiling', fresh);
  if (elapsed < 10_000) {
    await expect(preparing).resolves.toMatchObject({ status: 'ready' });
  } else {
    await expect(preparing).rejects.toThrow('Budget append unavailable');
  }
  expect(read).toHaveBeenCalledWith('budget-test', 1, 1_010_000);
}
it.each([9999, 10_000])('keeps ceiling preparation within its original %i ms boundary',
  ceilingPreparationBoundary);
