import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { LoadedMemoryRefused, privateCallers } from '@opencrane/models';
import { preparePersonalRecallLoad, recallReceipt } from './personal-memory-tools.ts';
import type { turnCommand } from './turns.ts';
import type { TurnDelivery } from './turn-tools.ts';

type Input = Parameters<typeof preparePersonalRecallLoad>[0];
type Options = Pick<Input, 'store' | 'silo'> & Partial<Pick<Input, 'binding'>>;
type Computer = { assistantId: string; computerId: string };
type Turn = NonNullable<Awaited<ReturnType<typeof turnCommand>>>;
type Receipt = z.infer<typeof recallReceipt>;
type Pending = { receipt: Receipt; delivery: TurnDelivery; started: boolean;
  timer: NodeJS.Timeout; reply?: ReturnType<typeof Promise.withResolvers<unknown>> };
const message = z.object({ type: z.string(),
  turnId: z.string() });

export function recallBridge(options: Options, computer: Computer, socket: WebSocket,
  deliveries: Map<string, TurnDelivery>) {
  const pending = new Map<string, Pending>();
  function ended(turnId: string) {
    const active = pending.get(turnId);
    pending.delete(turnId);
    if (active) {
      clearTimeout(active.timer);
    }
    callers.remove(turnId);
    active?.reply?.reject(new LoadedMemoryRefused());
  }
  const callers = privateCallers(ended);
  function close() {
    for (const turnId of pending.keys()) {
      ended(turnId);
    }
    callers.close();
  }
  socket.once('close', close);
  function requireLive(turnId: string, active: Pending) {
    if (socket.readyState !== socket.OPEN || pending.get(turnId) !== active) {
      throw new LoadedMemoryRefused();
    }
  }
  function receive(value: unknown) {
    const parsed = message.safeParse(value);
    if (!parsed.success) {
      return false;
    }
    const { type, turnId } = parsed.data;
    if (type === 'agent.turn_failed' || type === 'agent.turn_completed') {
      ended(turnId);
      return false;
    }
    if (type === 'recall_refused') {
      ended(turnId);
      return true;
    }
    if (type === 'recall_loaded') {
      const active = pending.get(turnId);
      if (!active?.reply) {
        throw new LoadedMemoryRefused();
      }
      active.reply.resolve(value);
      delete active.reply;
      return true;
    }
    if (type !== 'recall_pending') {
      return false;
    }
    const receipt = recallReceipt.parse(value);
    const delivery = deliveries.get(receipt.conversationId);
    if (pending.has(turnId) || pending.size >= 2) {
      throw new LoadedMemoryRefused();
    }
    const checkedDelivery = requireDelivery(receipt, delivery, options, computer);
    const expire = ended.bind(undefined, turnId);
    const timer = setTimeout(expire, Math.min(10_000, receipt.expiresAt - Date.now()));
    const active: Pending = { receipt, delivery: checkedDelivery, started: false, timer };
    pending.set(turnId, active);
    return true;
  }
  async function prepare(turn: Turn, replay: boolean) {
    const active = pending.get(turn.turnId);
    const delivery = deliveries.get(turn.conversationId);
    if (!active && !delivery?.recall) {
      return undefined;
    }
    if (turn.executionMode !== 'restricted' || turn.sharingClass || turn.rootId) {
      throw new LoadedMemoryRefused();
    }
    if (!active || replay || active.started
      || active.receipt.threadId !== turn.threadId
      || active.receipt.requesterId !== turn.requesterId
      || active.receipt.conversationId !== turn.conversationId) {
      throw new LoadedMemoryRefused();
    }
    active.started = true;
    try {
      const input = recallInput(options, computer, turn, active, callers);
      const check = requireLive.bind(undefined, turn.turnId, active);
      const confirmation = await dispatchRecall(input, active, socket, check);
      clearTimeout(active.timer);
      return confirmation;
    } catch (error) {
      ended(turn.turnId);
      throw error;
    }
  }
  return { receive, prepare };
}

function recallInput(options: Options, computer: Computer, turn: Turn, active: Pending,
  callers: ReturnType<typeof privateCallers>): Input {
  if (!options.binding) {
    throw new LoadedMemoryRefused();
  }
  const receipt = active.receipt;
  const grant = { silo: options.silo, assistantId: computer.assistantId,
    computerId: computer.computerId, requesterId: turn.requesterId, conversation: turn.conversationId,
    turnId: turn.turnId, thread: receipt.threadId, generation: receipt.generation,
    inputGeneration: receipt.inputGeneration, expires: receipt.expiresAt };
  // Keep this server registration local; the computer owns a separate caller credential.
  const registration = callers.register(grant);
  registration.bind(grant.thread);
  const input = { ...options, binding: options.binding, assistantId: computer.assistantId,
    requesterId: turn.requesterId, baseMessageBytes: active.delivery.recall!.baseMessageBytes,
    callers, caller: registration.caller, grant };
  return input;
}

async function dispatchRecall(input: Input, active: Pending, socket: WebSocket,
  check: () => void) {
  const load = await preparePersonalRecallLoad(input, active.receipt);
  check();
  if (!isDeepStrictEqual(load.request.tools, active.delivery.tools)) {
    throw new LoadedMemoryRefused();
  }
  const reply = Promise.withResolvers<unknown>();
  active.reply = reply;
  socket.send(JSON.stringify(load.request));
  const loaded = await reply.promise;
  await load.complete(loaded);
  async function confirm() {
    check();
    await load.confirm();
    check();
  }
  await confirm();
  return { confirm, check, tools: load.request.tools };
}

function requireDelivery(receipt: Receipt, delivery: TurnDelivery | undefined,
  options: Options, computer: Computer) {
  if (!delivery?.recall
    || delivery.turnId !== receipt.turnId || delivery.recall.requesterId !== receipt.requesterId
    || delivery.recall.expiresAt !== receipt.expiresAt
    || receipt.silo !== options.silo || receipt.assistantId !== computer.assistantId
    || receipt.computerId !== computer.computerId) {
    throw new LoadedMemoryRefused();
  }
  return delivery;
}
