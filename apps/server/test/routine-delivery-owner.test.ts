import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { BudgetActor } from '@opencrane/models';
import { bindRoutineBudgetOwner, routineBudgetOwnerMatches }
  from '../src/routine-delivery-owner.ts';

function current() {
  return Promise.resolve();
}

async function refusesWrongOwner() {
  const fixture = await natsFixture();
  try {
    const store = fixture.store;
    const actor = new BudgetActor(store, 'silo');
    const otherActor = new BudgetActor(store, 'silo');
    const stop = new AbortController();
    const owner = bindRoutineBudgetOwner(actor, store, 'silo', stop.signal, current);
    expect(routineBudgetOwnerMatches(owner, actor, store, 'silo')).toBe(true);
    expect(routineBudgetOwnerMatches(owner, otherActor, store, 'silo')).toBe(false);
    expect(routineBudgetOwnerMatches(owner, actor, store, 'other-silo')).toBe(false);
    expect(() => bindRoutineBudgetOwner(otherActor, store, 'silo', stop.signal, current))
      .toThrow('Routine budget owner unavailable');
    stop.abort();
    expect(await owner.checkCurrent(performance.now() + 1000)).toBe(false);
    const restart = new AbortController();
    const replacement = bindRoutineBudgetOwner(otherActor, store, 'silo',
      restart.signal, current);
    expect(routineBudgetOwnerMatches(owner, actor, store, 'silo')).toBe(false);
    expect(routineBudgetOwnerMatches(replacement, otherActor, store, 'silo')).toBe(true);
  } finally {
    await fixture.close();
  }
}
it('refuses a wrong silo, another actor and an expired owner', refusesWrongOwner);
