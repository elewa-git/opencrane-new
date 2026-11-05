import { loadRoutinePreparation } from './routine-session.ts';
import { prepareRoutineComputer } from './routine-computer.ts';
import { createRoutineSender } from './routine-sender.ts';

type Preparation = Parameters<typeof prepareRoutineComputer>;
type Ready = { link: Preparation[5]; generation: number };

// Keep this internal entry disabled until company calls, Ask and lifecycle Stop are connected.
export function createRoutineComposition(options: { enabled?: boolean; replay?: boolean },
  store: Preparation[0], keys: Preparation[1], suppliedWorker: Preparation[2], raw: unknown,
  actor: Preparation[4], senderAttemptId: string) {
  const enabled = options.enabled === true && options.replay !== true;
  const worker = { ...suppliedWorker };
  let used = false;

  async function send(wake: (assistantId: string) => Promise<Ready>) {
    const unknown = { status: 'unknown' as const };
    if (!enabled || used) return unknown;
    used = true;
    try {
      const input = structuredClone(raw);
      const prepared = await loadRoutinePreparation(store, keys, worker, input);
      await prepared.checkAccess();
      const ready = await wake(prepared.run.definition.assistantId);
      // Reload history and access after wake; its wait may exceed the earlier write deadline.
      const selection = await prepareRoutineComputer(store, keys, worker, input, actor,
        ready.link, ready.generation);
      const sender = createRoutineSender(options, store, keys, worker, input,
        selection, senderAttemptId);
      function connected() {
        return Promise.resolve(ready.link);
      }
      return await sender.send(connected);
    } catch {
      // Keep private failures hidden and never infer that an uncertain operation was unsent.
      return unknown;
    }
  }
  return { send };
}
