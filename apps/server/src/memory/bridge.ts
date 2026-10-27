import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { memoryContextRecordedEventSchema } from '@opencrane/events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { readChatFacts } from '../chat/chat-summary.ts';
import type { turnCommand } from '../chat/turns.ts';
import { stopInvalidatedMemory } from './stop.ts';

type Admitted = NonNullable<Awaited<ReturnType<typeof turnCommand>>>;
type Report = { type: string; conversationId: string; turnId: string; sequence: number;
  threadId?: string | undefined };
type Options = { silo: string; store: EventStore };
type Computer = { assistantId: string; computerId: string };
const generationData = z.object({ computerId: z.string(), generation: z.int().positive() });

export function memoryBridge(options: Options, computer: Computer, socket: WebSocket) {
  const observed = new Map<string, Pick<Report, 'sequence' | 'turnId' | 'threadId'>>();
  const turns = new Map<string, { turn: Admitted; generation: number }>();
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
      const previous = turns.get(report.conversationId);
      if (previous?.turn.turnId !== report.turnId || previous.turn.threadId !== report.threadId) {
        turns.delete(report.conversationId);
      }
    } else if (report.type === 'agent.turn_completed' || report.type === 'agent.turn_failed') {
      if (observed.get(report.conversationId)?.turnId !== report.turnId) return;
      observed.delete(report.conversationId);
      turns.delete(report.conversationId);
    }
  }
  function readyGeneration(summary: ComputerSummary) {
    if (summary.lifecycle?.event.type !== 'computer.ready') return undefined;
    const current = generationData.parse(summary.lifecycle.event.data);
    if (current.computerId !== computer.computerId) return undefined;
    return current.generation;
  }
  function generation(turnId: string) {
    function take(summary: ComputerSummary) {
      if (summary.turns.get(turnId)?.firstClose) return undefined;
      return readyGeneration(summary);
    }
    return readStreamSummary(options.store, options.silo, `computer-${computer.assistantId}`,
      computerSummary, performance.now() + 10_000, take);
  }
  async function accept(report: Report, turn: Admitted) {
    if (turn.executionMode !== 'restricted' || turn.sharingClass) return;
    const savedGeneration = await generation(turn.turnId);
    if (savedGeneration === undefined || observed.get(report.conversationId)?.sequence !== report.sequence ||
        socket.readyState !== WebSocket.OPEN) return;
    const active = { turn, generation: savedGeneration };
    turns.set(report.conversationId, active);
  }
  async function deliver(conversationId: string) {
    const active = turns.get(conversationId);
    if (!active || socket.readyState !== WebSocket.OPEN) return;
    try {
      const chat = await readChatFacts(options.store, options.silo, conversationId, active.turn.turnId);
      if (chat.memoryContext?.status !== 'invalidated') return;
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
        const turnId = active.turn.turnId;
        let currentGeneration: number | undefined;
        async function refresh() {
          currentGeneration = await generation(turnId);
        }
        function current() {
          if (currentGeneration !== binding.generation) return undefined;
          // Recheck live reports after the reaction's history read, without opening a connection.
          if (turns.get(conversationId) !== active || socket.readyState !== WebSocket.OPEN) {
            return undefined;
          }
          return { silo: options.silo, binding, socket };
        }
        const reaction = { silo: options.silo, store: options.store, current, refresh };
        await stopInvalidatedMemory(reaction, event);
      }
    } catch {
      // Retry on the next poll. Neither a failed read nor a sent frame proves termination.
    }
  }
  function poll(conversationId: string) {
    const pending = checking.get(conversationId);
    if (pending) return pending;
    function finished() { checking.delete(conversationId); }
    const work = deliver(conversationId).finally(finished);
    checking.set(conversationId, work);
    return work;
  }
  return { observe, accept, poll };
}
