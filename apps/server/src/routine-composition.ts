import { loadRoutinePreparation } from './routine-session.ts';
import { prepareRoutineComputer } from './routine-computer.ts';
import { createRoutineSender } from './routine-sender.ts';
import { bindRoutineBudgetOwner, routineBudgetOwnerMatches }
  from './routine-delivery-owner.ts';

type Preparation = Parameters<typeof prepareRoutineComputer>;
type Ready = { link: Preparation[5]; generation: number };
type Wake = (assistantId: string, signal?: AbortSignal) => Promise<Ready>;
type DeliveryWorker = Pick<Preparation[2], 'silo' | 'binding' | 'workerId' | 'now'>;
type Leadership = { signal: AbortSignal; checkCurrent: (deadline: number) => Promise<boolean> };
type CheckedDue = { status: 'confirmed'; executionAvailable: false; routineId: string;
  occurrenceId: string; turnId: string };

/** Carry the claimed occurrence into the saved preparation and one sender attempt. */
export function createRoutineDelivery(store: Preparation[0], keys: Preparation[1],
  identity: DeliveryWorker, actor: Preparation[4], wake: Wake,
  owner: ReturnType<typeof bindRoutineBudgetOwner>) {
  async function receive(due: CheckedDue, leadership: Leadership) {
    if (due.status !== 'confirmed' || due.executionAvailable !== false ||
        leadership.signal.aborted || identity.silo !== identity.binding.silo ||
        !routineBudgetOwnerMatches(owner, actor, store, identity.silo)) {
      return { status: 'unknown' as const };
    }
    async function checkCurrent(deadline: number) {
      if (leadership.signal.aborted) return false;
      const budgetCurrent = await owner.checkCurrent(deadline);
      if (!budgetCurrent || leadership.signal.aborted) return false;
      const schedulerCurrent = await leadership.checkCurrent(deadline);
      if (!schedulerCurrent || leadership.signal.aborted) return false;
      return owner.checkCurrent(deadline);
    }
    if (!await checkCurrent(performance.now() + 2000)) {
      return { status: 'unknown' as const };
    }
    const worker = { ...identity, signal: leadership.signal, checkCurrent };
    const input = { routineId: due.routineId, occurrenceId: due.occurrenceId };
    const composition = createRoutineComposition({ enabled: true }, store, keys, worker,
      input, actor, due.turnId);
    return composition.send(wake);
  }
  return receive;
}

// Keep this internal entry disabled until company calls and Ask are connected.
export function createRoutineComposition(options: { enabled?: boolean; replay?: boolean },
  store: Preparation[0], keys: Preparation[1],
  suppliedWorker: Preparation[2] & { signal?: AbortSignal }, raw: unknown,
  actor: Preparation[4], senderAttemptId: string) {
  const enabled = options.enabled === true && options.replay !== true;
  const worker = { ...suppliedWorker };
  let used = false;

  async function send(wake: Wake) {
    const unknown = { status: 'unknown' as const };
    if (!enabled || used) {
      return unknown;
    }
    used = true;
    try {
      const input = structuredClone(raw);
      const prepared = await loadRoutinePreparation(store, keys, worker, input);
      await prepared.checkAccess();
      const ready = await wake(prepared.run.definition.assistantId, worker.signal);
      // Reload history and access after wake; its wait may exceed the earlier write deadline.
      const selection = await prepareRoutineComputer(store, keys, worker, input, actor,
        ready.link, ready.generation);
      const sender = createRoutineSender(options, store, keys, worker, input,
        selection, senderAttemptId);
      function connected() {
        return Promise.resolve(ready.link);
      }
      return await sender.send(connected, worker.signal);
    } catch {
      // Keep private failures hidden and never infer that an uncertain operation was unsent.
      return unknown;
    }
  }
  return { send };
}
