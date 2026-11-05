import type { Binding } from '@opencrane/authz';
import { invalidateMemoryAccess } from './invalidation.ts';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { agentTurnStopRequestedDataSchema, memoryContextRecordedEventSchema,
  type MemoryContextRecord } from '@opencrane/events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { readChatFacts, readChatStopRows, type ChatFacts } from '../chat/chat-summary.ts';
import type { turnCommand } from '../chat/turns.ts';
import { memoryChanges } from './changes.ts';
import { stopInvalidatedMemory } from './stop.ts';

type Admitted = NonNullable<Awaited<ReturnType<typeof turnCommand>>>;
type Report = { type: string; conversationId: string; turnId: string; sequence: number;
  threadId?: string | undefined };
type Options = { silo: string; store: EventStore; binding?: Binding };
type Computer = { assistantId: string; computerId: string };
type TrackedTurn = { turn: Admitted; generation: number; cleared: boolean;
  detect: ReturnType<typeof memoryChanges> };
const clearedData = z.strictObject({ type: z.literal('private_output_cleared'),
  conversationId: z.string(), turnId: z.string(), threadId: z.string() });
const generationData = z.object({ computerId: z.string(), generation: z.int().positive() });

function matchesPreparation(saved: MemoryContextRecord, active: TrackedTurn, computer: Computer) {
  return saved.conversationId === active.turn.conversationId && saved.turnId === active.turn.turnId &&
    saved.requesterId === active.turn.requesterId && saved.assistantId === computer.assistantId &&
    saved.computerId === computer.computerId && saved.generation === active.generation &&
    saved.threadId === active.turn.threadId;
}

async function hasSavedStop(options: Options, binding: MemoryContextRecord) {
  const rows = await readChatStopRows(options.store, options.silo, binding.conversationId);
  for (const row of rows) {
    if (row.event.type !== 'agent.turn_stop_requested') continue;
    const stop = agentTurnStopRequestedDataSchema.parse(row.event.data);
    if (stop.conversationId === binding.conversationId && stop.turnId === binding.turnId) {
      return true;
    }
  }
  return false;
}

function savedPreparation(chat: ChatFacts) {
  if (!chat.memoryContext) return undefined;
  const events = chat.memoryContext.events.values();
  const encoded = events.next().value;
  if (!encoded) return undefined;
  const decoded: unknown = JSON.parse(encoded);
  const binding = memoryContextRecordedEventSchema.parse(decoded).data;
  return { binding, context: chat.memoryContext };
}

export function memoryBridge(options: Options, computer: Computer, socket: WebSocket,
  clearOutput: (binding: MemoryContextRecord) => void) {
  const observed = new Map<string, Pick<Report, 'sequence' | 'turnId' | 'threadId'>>();
  const turns = new Map<string, Map<string, TrackedTurn>>();
  const checking = new Map<string, Promise<void>>();
  function clear() {
    observed.clear();
    turns.clear();
  }
  socket.once('close', clear);
  function observe(report: Report) {
    if (report.type === 'agent.turn_started') {
      const pending = { sequence: report.sequence, turnId: report.turnId,
        threadId: report.threadId };
      observed.set(report.conversationId, pending);
    }
  }
  function removeTurn(conversationId: string, active: TrackedTurn) {
    const conversation = turns.get(conversationId);
    if (conversation?.get(active.turn.turnId) !== active) return;
    conversation.delete(active.turn.turnId);
    if (conversation?.size === 0) turns.delete(conversationId);
  }
  function receive(value: unknown) {
    const receipt = clearedData.safeParse(value);
    if (!receipt.success) return false;
    const { conversationId, turnId, threadId } = receipt.data;
    const conversation = turns.get(conversationId);
    const tracked = conversation?.get(turnId);
    // Require checked withdrawal before a receipt can release this connection's tracking.
    if (tracked?.cleared && tracked.turn.threadId === threadId) {
      removeTurn(conversationId, tracked);
    }
    return true;
  }
  function readyGeneration(summary: ComputerSummary) {
    if (summary.lifecycle?.event.type !== 'computer.ready') return undefined;
    const current = generationData.parse(summary.lifecycle.event.data);
    if (current.computerId !== computer.computerId) return undefined;
    return current.generation;
  }
  function generation() {
    return readStreamSummary(options.store, options.silo, `computer-${computer.assistantId}`,
      computerSummary, performance.now() + 10_000, readyGeneration);
  }
  async function accept(report: Report, turn: Admitted) {
    if (turn.executionMode !== 'restricted' || turn.sharingClass) return;
    const savedGeneration = await generation();
    if (savedGeneration === undefined || observed.get(report.conversationId)?.sequence !== report.sequence ||
        socket.readyState !== WebSocket.OPEN) return;
    const active = { turn, generation: savedGeneration, cleared: false,
      detect: memoryChanges(options) };
    const conversation = turns.get(report.conversationId) ?? new Map<string, TrackedTurn>();
    conversation.set(turn.turnId, active);
    turns.set(report.conversationId, conversation);
  }
  async function deliverTurn(conversationId: string, active: TrackedTurn) {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      let chat = await readChatFacts(options.store, options.silo, conversationId, active.turn.turnId);
      const preparation = savedPreparation(chat);
      if (!preparation) return;
      const saved = preparation.binding;
      const request = { conversationId: saved.conversationId, turnId: saved.turnId,
        threadId: saved.threadId, inputGeneration: saved.inputGeneration };
      await invalidateMemoryAccess(options, request);
      await active.detect(preparation.context);
      chat = await readChatFacts(options.store, options.silo, conversationId, active.turn.turnId);
      const checkedPreparation = savedPreparation(chat);
      if (!checkedPreparation) return;
      const preparationBinding = checkedPreparation.binding;
      if (!matchesPreparation(preparationBinding, active, computer)) return;
      const stopped = await hasSavedStop(options, preparationBinding);
      if (await generation() !== active.generation) {
        clearOutput(preparationBinding);
        removeTurn(conversationId, active);
        return;
      }
      if (stopped && !active.cleared) {
        // Keep saved Stop decisive even when a late completion arrives before this poll.
        clearOutput(preparationBinding);
        active.cleared = true;
      }
      if (chat.conversationClosed) clearOutput(preparationBinding);
      let hasInvalidation = false;
      for (const encoded of checkedPreparation.context.events.values()) {
        const decoded: unknown = JSON.parse(encoded);
        const event = memoryContextRecordedEventSchema.parse(decoded);
        if (event.data.action !== 'invalidated') continue;
        hasInvalidation = true;
        // Use saved preparation to keep the input generation independent of the invalidation.
        const binding = preparationBinding;
        let currentGeneration: number | undefined;
        async function refresh() {
          currentGeneration = await generation();
        }
        function current() {
          if (currentGeneration !== binding.generation) return undefined;
          // Recheck live reports after the reaction's history read, without opening a connection.
          const tracked = turns.get(conversationId)?.get(active.turn.turnId);
          if (tracked !== active || socket.readyState !== WebSocket.OPEN) {
            return undefined;
          }
          return { silo: options.silo, binding, socket, pendingClearance: true };
        }
        const reaction = { silo: options.silo, store: options.store, current, refresh };
        const result = await stopInvalidatedMemory(reaction, event);
        if (result === 'sent') {
          clearOutput(binding);
          active.cleared = true;
        }
      }
      // Keep a saved withdrawal until the computer also confirms that its buffers are clear.
      if (chat.conversationClosed && !hasInvalidation) removeTurn(conversationId, active);
    } catch {
      // Retry on the next poll. Neither a failed read nor a sent frame proves termination.
    }
  }
  async function deliver(conversationId: string) {
    const conversation = turns.get(conversationId);
    if (!conversation) return;
    // Keep completed replies and replacements separate until their buffers are cleared.
    for (const active of conversation.values()) await deliverTurn(conversationId, active);
  }
  function poll(conversationId: string) {
    const pending = checking.get(conversationId);
    if (pending) return pending;
    function finished() { checking.delete(conversationId); }
    const work = deliver(conversationId).finally(finished);
    checking.set(conversationId, work);
    return work;
  }
  return { observe, accept, poll, receive };
}
