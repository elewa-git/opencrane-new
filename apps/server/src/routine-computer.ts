import type { connectBridge } from './chat/bridge.ts';
import { cancelRoutineThread } from './chat/routine-thread.ts';
import { loadRoutinePreparation, prepareRoutineSession } from './routine-session.ts';
import { prepareRoutineInput } from './routine-input.ts';
import { allocateRoutineRoot } from './routine-root.ts';

type Arguments = Parameters<typeof allocateRoutineRoot>;
type Link = Awaited<ReturnType<typeof connectBridge>>;

// Keep this preparation internal. No worker dispatches automatic routines yet.
export async function prepareRoutineComputer(store: Arguments[0], keys: Arguments[1],
  worker: Arguments[2], raw: unknown, actor: Arguments[4], link: Link, generation: number) {
  let turnId: string | undefined;
  let conversationId: string | undefined;
  try {
    const input = structuredClone(raw);
    const prepared = await loadRoutinePreparation(store, keys, worker, input);
    const run = prepared.run;
    turnId = run.turnId;
    conversationId = run.conversationId;
    if (link.assistantId !== run.definition.assistantId) {
      throw new Error('Routine computer unavailable');
    }
    await prepared.checkAccess();
    const now = worker.now ?? Date.now;
    const remaining = Date.parse(run.startBy) - now();
    const identity = { id: turnId, conversationId, assistantId: run.definition.assistantId,
      requesterId: run.definition.ownerId, expiresAt: Date.now() + Math.min(remaining, 60_000) };
    const threadId = await link.prepareRoutineThread(identity);
    const selection = { threadId, computerId: link.computerId, generation };
    // Record only the returned native identity, with fresh checks after native startup.
    await prepareRoutineSession(store, keys, worker, input);
    await prepareRoutineInput(store, keys, worker, input);
    await allocateRoutineRoot(store, keys, worker, input, actor, selection);
    return selection;
  } catch {
    if (turnId && conversationId) cancelRoutineThread(link.socket, turnId, conversationId);
    throw new Error('Routine computer unavailable');
  }
}
