import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { readChatFacts } from '../chat/chat-summary.ts';
import type { turnCommand } from '../chat/turns.ts';
import { memoryChanges } from './changes.ts';
import { stopInvalidatedMemory } from './stop.ts';

type Admitted = NonNullable<Awaited<ReturnType<typeof turnCommand>>>;
type Report = { type: string; conversationId: string; turnId: string; sequence: number;
  threadId?: string | undefined };
type Options = { silo: string; store: EventStore };
type Computer = { assistantId: string; computerId: string };
type TrackedTurn = { turn: Admitted; generation: number;
  detect: ReturnType<typeof memoryChanges> };
const clearedData = z.object({ type: z.literal('private_output_cleared'),
  conversationId: z.string(), turnId: z.string(), threadId: z.string() });
const generationData = z.object({ computerId: z.string(), generation: z.int().positive() });

export function memoryBridge(options: Options, computer: Computer, socket: WebSocket) {
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
  function receive(value: unknown) {
    const receipt = clearedData.safeParse(value);
    if (!receipt.success) return false;
    const { conversationId, turnId, threadId } = receipt.data;
    const conversation = turns.get(conversationId);
    const tracked = conversation?.get(turnId);
    if (conversation && tracked?.turn.threadId === threadId) {
      conversation.delete(turnId);
      if (conversation.size === 0) turns.delete(conversationId);
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
    const active = { turn, generation: savedGeneration, detect: memoryChanges(options) };
    const conversation = turns.get(report.conversationId) ?? new Map<string, TrackedTurn>();
    conversation.set(turn.turnId, active);
    turns.set(report.conversationId, conversation);
  }
  async function deliverTurn(conversationId: string, active: TrackedTurn) {
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      let chat = await readChatFacts(options.store, options.silo, conversationId, active.turn.turnId);
      if (!chat.memoryContext) return;
      await active.detect(chat.memoryContext);
      chat = await readChatFacts(options.store, options.silo, conversationId, active.turn.turnId);
      if (!chat.memoryContext) return;
      const first = chat.memoryContext.events.values().next().value;
      if (!first) return;
      const initial: unknown = JSON.parse(first);
      const inputGeneration = memoryContextRecordedEventSchema.parse(initial).data.inputGeneration;
      for (const encoded of chat.memoryContext.events.values()) {
        const decoded: unknown = JSON.parse(encoded);
        const event = memoryContextRecordedEventSchema.parse(decoded);
        if (event.data.action !== 'invalidated') continue;
        // Use saved preparation to keep the input generation independent of the invalidation.
        const binding = { conversationId, turnId: active.turn.turnId,
          requesterId: active.turn.requesterId, assistantId: computer.assistantId,
          computerId: computer.computerId, generation: active.generation,
          threadId: active.turn.threadId, inputGeneration };
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
        await stopInvalidatedMemory(reaction, event);
      }
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
