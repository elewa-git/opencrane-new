import { createHash } from 'node:crypto';
import { routineActivationSchema } from '@opencrane/events';
import { stopUnconfirmedRoutine } from './routine-delivery-stop.ts';
import type { connectBridge } from './chat/bridge.ts';
import { cancelRoutineThread } from './chat/routine-thread.ts';
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
type SenderOptions = { enabled?: boolean; replay?: boolean;
  confirmCompany?: () => Promise<void> };

function companyCheckedWorker(worker: Arguments[2], confirmCompany?: () => Promise<void>) {
  if (!confirmCompany) return worker;
  const checkCompany: () => Promise<void> = confirmCompany;
  async function checkCurrent(deadline: number) {
    const current = await worker.checkCurrent(deadline);
    if (!current) return false;
    // Check company access in the same admission callback as the other write checks.
    await checkCompany();
    return true;
  }
  return { ...worker, checkCurrent };
}

function routineTurnBytes(checked: Awaited<ReturnType<typeof readRoutineActivation>>,
  selection: Arguments[4], keys: Arguments[1], silo: string) {
  const run = checked.run;
  const instructions = keys.decrypt(silo, `routine-${run.routineId}`,
    run.definition.instructions);
  const frame = { type: 'turn', id: checked.turnId, messageId: checked.messageId,
    threadId: selection.threadId,
    rootId: checked.rootId, senderAttemptId: checked.senderAttemptId,
    conversationId: run.conversationId, assistantId: run.definition.assistantId,
    requesterId: run.definition.ownerId, executionMode: 'restricted',
    text: `Routine instructions (user data):\n\n${instructions}`,
    token: 'preparing', expiresAt: Date.now() + 120_000 };
  return JSON.stringify(frame);
}

async function authoriseRoutineSend(store: Arguments[0], worker: Arguments[2],
  checked: Awaited<ReturnType<typeof readRoutineActivation>>,
  confirmCompany: () => Promise<void>) {
  const run = checked.run;
  const subject = `routine-${run.routineId}`;
  const activation = await store.readEvent(checked.receipt.position, checked.deadline);
  if (activation.event.id !== checked.receipt.eventId ||
      activation.event.type !== 'routine.run_activation_admitted' ||
      activation.event.subject !== subject) {
    throw new Error('Routine send unavailable');
  }
  const data = routineActivationSchema.parse(activation.event.data);
  const expectedSequence = await store.head(subject, checked.deadline);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([worker.silo, run.occurrenceId, checked.senderAttemptId]));
  const id = hash.digest('hex');
  const event = { id, commandId: id, silo: worker.silo, subject, data,
    type: 'routine.run_send_authorised', source: 'opencrane-server',
    principal: { kind: 'system' as const, id: 'opencrane-server' },
    time: new Date().toISOString(), correlation: {} };
  async function checkAccess() {
    await checked.fresh();
    await confirmCompany();
  }
  // Make the saved authorisation depend on the same company facts as the send.
  const command = { event, expectedSequence, historyChecked: true as const,
    deadline: checked.deadline, checkAccess };
  const result = await store.append(command);
  if (result.status !== 'appended' || result.outcome?.kind !== 'appended') {
    throw new Error('Routine send unavailable');
  }
  await checked.fresh();
}

// Keep this internal switch off until company calls, lifecycle Stop and Ask are connected.
export function createRoutineSender(options: SenderOptions,
  ...supplied: Arguments) {
  const [store, keys, worker, raw, selection, senderAttemptId] = supplied;
  const confirmCompany = options.confirmCompany;
  const checkedWorker = companyCheckedWorker(worker, confirmCompany);
  const args: Arguments = [store, keys, checkedWorker, raw,
    { ...selection }, senderAttemptId];
  const enabled = options.enabled === true && options.replay !== true;
  let used = false;
  let awaitingStart = false;
  async function send(wake: () => Promise<Link>, signal?: AbortSignal) {
    const unknown = { status: 'unknown' as const };
    if (!enabled || used) return unknown;
    used = true;
    let link: Link | undefined;
    let admitted: Awaited<ReturnType<typeof claimRoutineActivation>> | undefined;
    let sent = false;
    try {
      args[3] = structuredClone(raw);
      admitted = await claimRoutineActivation(...args);
      if (!admitted.published) return unknown;
      link = await wake();
      const checked = await readRoutineActivation(...args);
      const run = checked.run;
      if (link.computerId !== args[4].computerId ||
          link.assistantId !== run.definition.assistantId) return unknown;
      const bytes = routineTurnBytes(checked, args[4], keys, worker.silo);
      await checked.fresh();
      if (confirmCompany) {
        await authoriseRoutineSend(store, checkedWorker, checked, confirmCompany);
      }
      if (link.socket.readyState !== link.socket.OPEN) return unknown;
      // Consume this live authority before the transport can lose its reply.
      awaitingStart = true;
      // Treat a missing transport reply as a possible delivery.
      sent = true;
      const accepted = await sendRoutineTurn(link, bytes, checked.turnId, checkStart,
        args[2], signal);
      if (!accepted) {
        return await unconfirmedDelivery(store, worker.silo, admitted, sent);
      }
      return { status: 'sent' as const };
    } catch {
      return await unconfirmedDelivery(store, worker.silo, admitted, sent);
    } finally {
      awaitingStart = false;
      if (link && admitted && !sent) {
        cancelRoutineThread(link.socket, admitted.turnId, admitted.run.conversationId);
      }
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
      await confirmCompany?.();
      async function fresh() {
        await checked.fresh();
        await confirmCompany?.();
      }
      async function confirmStarted(started: Parameters<typeof checked.confirmStarted>[0]) {
        await checked.confirmStarted(started);
        await confirmCompany?.();
      }
      return { payer: checked.run.definition.payingGroupId, fresh,
        deadline: checked.deadline, provider: checked.provider, confirmStarted };
    } catch {
      throw new Error('Routine start unavailable');
    }
  }
  return { send };
}

async function sendRoutineTurn(link: Link, bytes: string, turnId: string,
  check: Parameters<Link['bindRoutineStart']>[1], worker: Arguments[2], signal?: AbortSignal) {
  if (signal?.aborted) {
    return false;
  }
  const completion = link.bindRoutineStart(turnId, check, worker.checkCurrent, signal);
  try {
    link.socket.send(bytes);
    const accepted = await completion.pending;
    if (!accepted || signal?.aborted) {
      return false;
    }
    const current = await worker.checkCurrent(performance.now() + 1000);
    return current && !signal?.aborted && link.socket.readyState === link.socket.OPEN;
  } finally {
    completion.cancel();
  }
}

async function unconfirmedDelivery(store: Arguments[0], silo: string,
  admitted: Awaited<ReturnType<typeof claimRoutineActivation>> | undefined, sent: boolean) {
  const unknown = { status: 'unknown' as const };
  if (admitted && sent) {
    const admission = { routineId: admitted.run.routineId,
      eventId: admitted.receipt.eventId, position: admitted.receipt.position };
    try {
      await stopUnconfirmedRoutine(store, silo, admission);
    } catch {
      // Retain admission and the occupied run when saving Stop is unavailable.
      return unknown;
    }
  }
  return unknown;
}
