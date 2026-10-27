import type { connectBridge } from './chat/bridge.ts';
import { claimRoutineActivation, readRoutineActivation } from './routine-activation.ts';

// Check saved identity only. Missing delivery evidence never proves that a send is safe.
export async function inspectRoutineSender(...args: Parameters<typeof readRoutineActivation>) {
  try {
    const checked = await readRoutineActivation(...args);
    const { receipt, messageId, turnId, rootId, senderAttemptId } = checked;
    return { status: 'unknown' as const, occurrenceId: receipt.occurrenceId,
      conversationId: receipt.conversationId, messageId, turnId, rootId, senderAttemptId,
      admission: { eventId: receipt.eventId, position: receipt.position },
      executionAvailable: false as const };
  } catch {
    throw new Error('Routine sender unavailable');
  }
}


type Arguments = Parameters<typeof readRoutineActivation>;
type Link = Pick<Awaited<ReturnType<typeof connectBridge>>,
  'socket' | 'bindRoutineStart' | 'computerId' | 'assistantId'>;
type Start = { conversationId: string; turnId: string; threadId?: string | undefined;
  messageId?: string | undefined; rootId?: string | undefined;
  senderAttemptId?: string | undefined; executionMode?: string | undefined };

// Keep this internal switch off until company calls, lifecycle Stop and Ask are connected.
export function createRoutineSender(options: { enabled?: boolean; replay?: boolean },
  ...supplied: Arguments) {
  const [store, keys, worker, raw, selection, senderAttemptId] = supplied;
  const args: Arguments = [store, keys, { ...worker }, raw,
    { ...selection }, senderAttemptId];
  const enabled = options.enabled === true && options.replay !== true;
  let used = false;
  let awaitingStart = false;
  async function send(wake: () => Promise<Link>) {
    const unknown = { status: 'unknown' as const };
    if (!enabled || used) return unknown;
    used = true;
    try {
      args[3] = structuredClone(raw);
      const admitted = await claimRoutineActivation(...args);
      if (!admitted.published) return unknown;
      const link = await wake();
      const checked = await readRoutineActivation(...args);
      const run = checked.run;
      if (link.computerId !== args[4].computerId ||
          link.assistantId !== run.definition.assistantId) return unknown;
      const instructions = keys.decrypt(worker.silo, `routine-${run.routineId}`,
        run.definition.instructions);
      const frame = { type: 'turn', id: checked.turnId, messageId: checked.messageId,
        rootId: checked.rootId, senderAttemptId: checked.senderAttemptId,
        conversationId: run.conversationId, assistantId: run.definition.assistantId,
        requesterId: run.definition.ownerId, executionMode: 'restricted',
        text: `Routine instructions (user data):\n\n${instructions}`,
        token: 'preparing', expiresAt: Date.now() + 120_000 };
      const bytes = JSON.stringify(frame);
      await checked.fresh();
      if (link.socket.readyState !== link.socket.OPEN) return unknown;
      // Consume this live authority before the transport can lose its reply.
      awaitingStart = true;
      link.bindRoutineStart(checked.turnId, checkStart);
      link.socket.send(bytes);
      return { status: 'sent' as const };
    } catch {
      return unknown;
    }
  }
  async function checkStart(report: Start) {
    if (!awaitingStart) throw new Error('Routine start unavailable');
    awaitingStart = false;
    try {
      const checked = await readRoutineActivation(...args);
      if (report.conversationId !== checked.receipt.conversationId ||
          report.turnId !== checked.turnId || report.messageId !== checked.messageId ||
          report.rootId !== checked.rootId || report.senderAttemptId !== checked.senderAttemptId ||
          report.threadId !== args[4].threadId || report.executionMode !== 'restricted') {
        throw new Error('Routine start unavailable');
      }
      return { payer: checked.run.definition.payingGroupId, fresh: checked.fresh,
        deadline: checked.deadline, provider: checked.provider };
    } catch {
      throw new Error('Routine start unavailable');
    }
  }
  return { send };
}
