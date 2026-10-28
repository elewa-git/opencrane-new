import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { budgetRootAllowanceSetDataSchema, computerTurnStartedDataSchema,
  conversationCreatedDataSchema, routineControlSchema, routineStopSchema } from '@opencrane/events';
import { history, readRootStopEvidence } from '@opencrane/models';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { readChatFacts } from './chat/chat-summary.ts';
import type { turnCommand } from './chat/turns.ts';

type Turn = NonNullable<Awaited<ReturnType<typeof turnCommand>>>;
type Root = z.infer<typeof budgetRootAllowanceSetDataSchema>;
type Options = { store: EventStore; silo: string };
type Computer = { computerId: string; assistantId: string };
const identityFields = ['rootId', 'conversationId', 'turnId', 'threadId',
  'requesterId', 'payingGroupId'] as const;
const readyData = z.object({ computerId: z.string(), generation: z.int().positive() });

function sameTurn(root: Root, turn: Pick<Turn, typeof identityFields[number]>) {
  for (const field of identityFields) {
    if (root[field] !== turn[field]) {
      return false;
    }
  }
  return true;
}

async function allocatedRoot(options: Options, computer: Computer, turn: Turn) {
  const rows = await history(options.store, `budget-${options.silo}`, options.silo,
    performance.now() + 10_000);
  for (const row of rows) {
    if (row.event.type !== 'budget.root_allowance_set') {
      continue;
    }
    const root = budgetRootAllowanceSetDataSchema.parse(row.event.data);
    if (root.rootId !== turn.rootId) {
      continue;
    }
    if (!sameTurn(root, turn)) {
      return undefined;
    }
    if (root.computerId !== computer.computerId || root.assistantId !== computer.assistantId) {
      return undefined;
    }
    return root;
  }
  return undefined;
}

function currentTurn(summary: ComputerSummary, root: Root) {
  if (summary.lifecycle?.event.type !== 'computer.ready') {
    return false;
  }
  const ready = readyData.parse(summary.lifecycle.event.data);
  const turn = summary.turns.get(root.turnId);
  if (ready.computerId !== root.computerId || ready.generation !== root.generation ||
      !turn?.firstStart || turn.firstClose) {
    return false;
  }
  const thread = summary.threads.get(root.threadId);
  if (thread?.startedTurnIds.size !== 1 || !thread.startedTurnIds.has(root.turnId)) {
    return false;
  }
  const started = computerTurnStartedDataSchema.parse(turn.firstStart.event.data);
  if (started.task !== 'chat_turn' || started.executionMode !== 'restricted') {
    return false;
  }
  if (!sameTurn(root, started)) {
    return false;
  }
  return started.computerId === root.computerId && started.assistantId === root.assistantId;
}

function affectedOccurrence(type: string, value: unknown) {
  if (type === 'routine.run_stop_requested') {
    return routineStopSchema.parse(value).occurrenceId;
  }
  if (type === 'routine.paused' || type === 'routine.retired') {
    return routineControlSchema.parse(value).affectedRun;
  }
  return undefined;
}

function matchesSource(source: Awaited<ReturnType<typeof readRootStopEvidence>>,
  root: Root, silo: string, eventId: string) {
  const run = source.routine?.activeRun;
  if (!run || source.event.silo !== silo || source.event.id !== eventId) {
    return false;
  }
  return run.conversationId === root.conversationId && run.turnId === root.turnId &&
    run.definition.ownerId === root.requesterId &&
    run.definition.assistantId === root.assistantId &&
    run.definition.payingGroupId === root.payingGroupId;
}

export function routineStartRefusal(report: { type: string; senderAttemptId?: string | undefined },
  error: unknown) {
  if (report.type === 'agent.turn_started' && report.senderAttemptId !== undefined) {
    // Refuse only this prepared turn when prohibition wins before admission finishes.
    return 'Routine start unavailable';
  }
  throw error;
}

// Track only starts accepted on this socket. Reading saved history never starts work.
export function routineBridge(options: Options, computer: Computer, socket: WebSocket) {
  const turns = new Map<string, Turn>();
  const checking = new Map<string, Promise<void>>();
  function clear() {
    turns.clear();
  }
  socket.once('close', clear);
  function accept(turn: Turn) {
    if (turn.rootId && turn.executionMode === 'restricted' && !turn.sharingClass) {
      turns.set(turn.turnId, turn);
    }
  }
  function ended(turnId: string) {
    turns.delete(turnId);
  }
  async function deliver(turn: Turn) {
    const chat = await readChatFacts(options.store, options.silo, turn.conversationId, turn.turnId);
    const created = conversationCreatedDataSchema.parse(chat.created);
    if (!('routinePreparation' in created) || !created.routinePreparation) {
      return;
    }
    const preparation = created.routinePreparation;
    const root = await allocatedRoot(options, computer, turn);
    if (!root) {
      return;
    }
    const subject = `routine-${preparation.routineId}`;
    const deadline = performance.now() + 10_000;
    for await (const row of options.store.readStream(subject, preparation.claimPosition, deadline)) {
      const occurrenceId = affectedOccurrence(row.event.type, row.event.data);
      if (occurrenceId !== preparation.occurrenceId) {
        continue;
      }
      // Share the budget Stop's owner, revision and original-run checks, including late completions.
      const source = await readRootStopEvidence(options.store, subject, row.sequence);
      if (!matchesSource(source, root, options.silo, row.event.id)) {
        return;
      }
      const sendBy = performance.now() + 2000;
      function take(summary: ComputerSummary) {
        return currentTurn(summary, root!);
      }
      const current = await readStreamSummary(options.store, options.silo,
        `computer-${computer.assistantId}`, computerSummary, sendBy, take);
      if (!current || performance.now() >= sendBy || turns.get(turn.turnId) !== turn ||
          socket.readyState !== WebSocket.OPEN) {
        return;
      }
      const frame = { type: 'stop', conversationId: turn.conversationId,
        turnId: turn.turnId, threadId: turn.threadId };
      socket.send(JSON.stringify(frame));
      return;
    }
  }
  async function check(conversationId: string) {
    try {
      for (const turn of turns.values()) {
        if (turn.conversationId === conversationId) {
          await deliver(turn);
        }
      }
    } catch {
      // Retry failed reads and sends. Only a saved terminal report removes the accepted turn.
    }
  }
  function poll(conversationId: string) {
    const pending = checking.get(conversationId);
    if (pending) {
      return pending;
    }
    function finished() {
      checking.delete(conversationId);
    }
    const work = check(conversationId).finally(finished);
    checking.set(conversationId, work);
    return work;
  }
  return { accept, ended, poll };
}
