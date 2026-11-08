import type { EventStore } from '@opencrane/event-store';
import type { BudgetActor } from '@opencrane/models';

interface RoutineBudgetOwner {
  actor: BudgetActor;
  store: EventStore;
  silo: string;
  signal: AbortSignal;
  requireCurrent: (deadline: number) => Promise<void>;
  checkCurrent: (deadline: number) => Promise<boolean>;
}

const owners = new WeakMap<EventStore, Map<string, RoutineBudgetOwner>>();
const boundOwners = new WeakSet<RoutineBudgetOwner>();

/** Bind routine money to the actor already held by the budget leader. */
export function bindRoutineBudgetOwner(actor: BudgetActor, store: EventStore, silo: string,
  signal: AbortSignal, requireLeader: (deadline: number) => Promise<void>): RoutineBudgetOwner {
  if (actor.store !== store || actor.silo !== silo || signal.aborted) {
    throw new Error('Routine budget owner unavailable');
  }
  let bySilo = owners.get(store);
  if (!bySilo) {
    bySilo = new Map();
    owners.set(store, bySilo);
  }
  const previous = bySilo.get(silo);
  if (previous && !previous.signal.aborted) {
    throw new Error('Routine budget owner unavailable');
  }
  async function requireCurrent(deadline: number) {
    if (signal.aborted || performance.now() >= deadline) {
      throw new Error('Routine budget owner unavailable');
    }
    await requireLeader(deadline);
    if (signal.aborted || performance.now() >= deadline) {
      throw new Error('Routine budget owner unavailable');
    }
  }
  async function checkCurrent(deadline: number) {
    try {
      await requireCurrent(deadline);
      return true;
    } catch {
      return false;
    }
  }
  const owner = { actor, store, silo, signal, requireCurrent, checkCurrent };
  bySilo.set(silo, owner);
  boundOwners.add(owner);
  return owner;
}

export function routineBudgetOwnerMatches(owner: RoutineBudgetOwner,
  actor: BudgetActor, store: EventStore, silo: string) {
  const currentOwner = owners.get(store)?.get(silo);
  return boundOwners.has(owner) && owner.actor === actor && owner.store === store &&
    owner.silo === silo && !owner.signal.aborted && currentOwner === owner;
}
