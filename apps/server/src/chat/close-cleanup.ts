import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { history } from '../../../ops/src/lifecycle.ts';
import { chatHistory } from './commands.ts';
import { turnCommand } from './turns.ts';

type ChatRows = Awaited<ReturnType<typeof chatHistory>>;
type Link = { socket: WebSocket; connectionId: number; sentStops: Map<string, number> };
type Assistant = {
  current: StoredEvent['event'] | undefined;
  started: Set<string>;
  closed: Set<string>;
  lostTurns: Set<string>;
  turnComputers: Map<string, string>;
  closedStatuses: Map<string, 'completed' | 'failed'>;
};
type Options = { silo: string; store: EventStore };
const turnData = z.object({ turnId: z.string() });
const computerData = z.object({ computerId: z.string() });

function terminalTurns(rows: ChatRows) {
  const ended = new Set<string>();
  for (const row of rows) {
    if (row.event.type === 'agent.turn_completed' || row.event.type === 'agent.turn_failed') {
      ended.add(turnData.parse(row.event.data).turnId);
    }
  }
  return ended;
}

function cleanupFailures(rows: ChatRows) {
  const cancelled = new Set<string>();
  for (const row of rows) {
    if (row.event.type !== 'agent.turn_failed' ||
        row.event.principal?.id !== 'close-cleanup') continue;
    cancelled.add(turnData.parse(row.event.data).turnId);
  }
  return cancelled;
}

function reportedStarts(rows: ChatRows) {
  const started = new Set<string>();
  for (const row of rows) {
    if (row.event.type === 'agent.turn_started') {
      started.add(turnData.parse(row.event.data).turnId);
    }
  }
  return started;
}

function postedInputs(rows: ChatRows) {
  function isPosted(row: ChatRows[number]) {
    return row.event.type === 'message.posted';
  }
  return rows.filter(isPosted);
}

function failureId(conversationId: string, turnId: string) {
  const digest = createHash('sha256');
  digest.update(`conversation-closed:${conversationId}:${turnId}`);
  return digest.digest('hex');
}

async function appendTerminal(options: Options, conversationId: string, turnId: string,
  assistantId: string, status: 'completed' | 'failed', allowStarted: boolean) {
  const subject = `conversation-${conversationId}`;
  const id = failureId(conversationId, turnId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await chatHistory(options.store, options.silo, conversationId);
    const ended = terminalTurns(rows);
    if (ended.has(turnId)) return;
    const started = reportedStarts(rows);
    if (started.has(turnId) && !allowStarted) return;
    if (!allowStarted) {
      const computerRows = await history(options.store, `computer-${assistantId}`);
      for (const computerRow of computerRows) {
        if (computerRow.event.type === 'computer.turn_started' &&
            turnData.parse(computerRow.event.data).turnId === turnId) return;
      }
    }
    let sequence = 0;
    for (const row of rows) {
      if (row.event.subject === subject) sequence = Math.max(sequence, row.sequence);
    }
    const data = status === 'completed'
      ? { conversationId, turnId }
      : { conversationId, turnId, reason: 'conversation_closed' };
    const type = status === 'completed' ? 'agent.turn_completed' : 'agent.turn_failed';
    const event = {
      id, commandId: id, type, subject, silo: options.silo,
      source: 'opencrane-server', principal: { kind: 'system' as const, id: 'close-cleanup' },
      time: new Date().toISOString(), correlation: {}, data,
    };
    const result = await options.store.append({ expectedSequence: sequence,
      historyChecked: true, event });
    if (result.status === 'appended') return;
    if (result.status !== 'rejected') throw new Error('Close cleanup unavailable');
  }
  throw new Error('Close cleanup changed; retrying');
}

export async function recoverTerminalTurns(options: Options, computerId: string,
  assistantId: string, conversationId: string, rows: ChatRows, closed: Set<string>,
  started?: Set<string>, turnComputers?: Map<string, string>, lostTurns?: Set<string>) {
  // Recover a server crash between the agent report and the separate computer event.
  let refreshed = false;
  for (const row of rows) {
    if (row.event.type !== 'agent.turn_completed' && row.event.type !== 'agent.turn_failed') {
      continue;
    }
    const terminal = turnData.parse(row.event.data);
    if (started && !started.has(terminal.turnId)) continue;
    if (row.event.principal?.id === 'close-cleanup' &&
        !lostTurns?.has(terminal.turnId)) continue;
    if (closed.has(terminal.turnId)) continue;
    if (!refreshed) {
      const lifecycle = await history(options.store, `computer-${assistantId}`);
      for (const saved of lifecycle) {
        if (saved.event.type === 'computer.turn_closed') {
          closed.add(turnData.parse(saved.event.data).turnId);
        }
      }
      refreshed = true;
    }
    if (closed.has(terminal.turnId)) continue;
    const status = row.event.type === 'agent.turn_completed' ? 'completed' : 'failed';
    const boundComputer = turnComputers?.get(terminal.turnId) ?? computerId;
    await turnCommand(options.store, { silo: options.silo, computerId: boundComputer, assistantId },
      { conversationId, turnId: terminal.turnId, status });
    closed.add(terminal.turnId);
  }
}

export async function cleanClosedConversation(options: Options, conversationId: string,
  assistantId: string, rows: ChatRows, assistant: Assistant, refused: Set<string>,
  connection: (computerId: string, assistantId: string) => Promise<Link>) {
  const ended = terminalTurns(rows);
  const cancelled = cleanupFailures(rows);
  const starts = reportedStarts(rows);
  const current = assistant.current;
  const currentComputer = current ? computerData.parse(current.data).computerId : undefined;
  const inputs = postedInputs(rows);
  let pending = false;
  let link: Link | undefined;

  for (const input of inputs) {
    const turnId = input.event.id;
    const admitted = starts.has(turnId) || assistant.started.has(turnId);
    if (!admitted && !ended.has(turnId)) {
      await appendTerminal(options, conversationId, turnId, assistantId, 'failed', false);
      continue;
    }
    const unsettledCancellation = cancelled.has(turnId) && assistant.started.has(turnId) &&
      !assistant.closed.has(turnId);
    if (ended.has(turnId) && !unsettledCancellation) continue;
    const savedStatus = assistant.closedStatuses.get(turnId);
    if (savedStatus) {
      await appendTerminal(options, conversationId, turnId, assistantId, savedStatus, true);
      continue;
    }
    if (assistant.lostTurns.has(turnId)) {
      await appendTerminal(options, conversationId, turnId, assistantId, 'failed', true);
      continue;
    }
    pending = true;
    // A suspended or replaced computer must never be woken just to deliver Stop.
    const turnComputer = assistant.turnComputers.get(turnId);
    if (current?.type !== 'computer.ready' || !currentComputer ||
        (turnComputer && turnComputer !== currentComputer) || refused.has(currentComputer)) {
      continue;
    }
    link ??= await connection(currentComputer, assistantId);
    const stopKey = `close:${turnId}`;
    const now = performance.now();
    const lastStop = link.sentStops.get(stopKey) ?? -Infinity;
    if (now - lastStop < 1000) continue;
    link.sentStops.set(stopKey, now);
    link.socket.send(JSON.stringify({ type: 'stop', turnId, conversationId }));
  }

  await recoverTerminalTurns(options, currentComputer ?? '', assistantId, conversationId,
    rows, assistant.closed, assistant.started, assistant.turnComputers, assistant.lostTurns);
  if (link) return { pending, retry: pending, connectionId: link.connectionId };
  return { pending, retry: pending };
}
