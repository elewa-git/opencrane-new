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
type SavedTurns = { ended: Set<string>; cancelled: Set<string>; starts: Set<string> };
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

function recoverableTerminal(row: ChatRows[number], started: Set<string> | undefined,
  lostTurns: Set<string> | undefined) {
  if (row.event.type !== 'agent.turn_completed' && row.event.type !== 'agent.turn_failed') {
    return false;
  }
  const turnId = turnData.parse(row.event.data).turnId;
  if (started && !started.has(turnId)) return false;
  if (row.event.principal?.id === 'close-cleanup' && !lostTurns?.has(turnId)) return false;
  return true;
}

async function refreshClosedTurns(options: Options, assistantId: string, closed: Set<string>) {
  const lifecycle = await history(options.store, `computer-${assistantId}`);
  for (const saved of lifecycle) {
    if (saved.event.type === 'computer.turn_closed') {
      closed.add(turnData.parse(saved.event.data).turnId);
    }
  }
}

export async function recoverTerminalTurns(options: Options, computerId: string,
  assistantId: string, conversationId: string, rows: ChatRows, closed: Set<string>,
  started?: Set<string>, turnComputers?: Map<string, string>, lostTurns?: Set<string>) {
  // Recover a server crash between the agent report and the separate computer event.
  let refreshed = false;
  for (const row of rows) {
    if (!recoverableTerminal(row, started, lostTurns)) continue;
    const terminal = turnData.parse(row.event.data);
    if (closed.has(terminal.turnId)) continue;
    if (!refreshed) {
      await refreshClosedTurns(options, assistantId, closed);
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

async function settleClosedInput(options: Options, conversationId: string, assistantId: string,
  turnId: string, assistant: Assistant, saved: SavedTurns) {
  const admitted = saved.starts.has(turnId) || assistant.started.has(turnId);
  if (!admitted && !saved.ended.has(turnId)) {
    await appendTerminal(options, conversationId, turnId, assistantId, 'failed', false);
    return false;
  }
  const unsettledCancellation = saved.cancelled.has(turnId) &&
    assistant.started.has(turnId) && !assistant.closed.has(turnId);
  if (saved.ended.has(turnId) && !unsettledCancellation) return false;
  const savedStatus = assistant.closedStatuses.get(turnId);
  if (savedStatus) {
    await appendTerminal(options, conversationId, turnId, assistantId, savedStatus, true);
    return false;
  }
  if (assistant.lostTurns.has(turnId)) {
    await appendTerminal(options, conversationId, turnId, assistantId, 'failed', true);
    return false;
  }
  return true;
}

async function sendCloseStop(conversationId: string, assistantId: string, turnId: string,
  assistant: Assistant, refused: Set<string>, link: Link | undefined,
  connection: (computerId: string, assistantId: string) => Promise<Link>) {
  // A suspended or replaced computer must never be woken just to deliver Stop.
  const current = assistant.current;
  if (current?.type !== 'computer.ready') return link;
  const computerId = computerData.parse(current.data).computerId;
  const turnComputer = assistant.turnComputers.get(turnId);
  if ((turnComputer && turnComputer !== computerId) || refused.has(computerId)) return link;
  const readyLink = link ?? await connection(computerId, assistantId);
  const stopKey = `close:${turnId}`;
  const now = performance.now();
  const lastStop = readyLink.sentStops.get(stopKey) ?? -Infinity;
  if (now - lastStop < 1000) return readyLink;
  readyLink.sentStops.set(stopKey, now);
  readyLink.socket.send(JSON.stringify({ type: 'stop', turnId, conversationId }));
  return readyLink;
}

export async function cleanClosedConversation(options: Options, conversationId: string,
  assistantId: string, rows: ChatRows, assistant: Assistant, refused: Set<string>,
  connection: (computerId: string, assistantId: string) => Promise<Link>) {
  const saved = { ended: terminalTurns(rows), cancelled: cleanupFailures(rows),
    starts: reportedStarts(rows) };
  const currentComputer = assistant.current
    ? computerData.parse(assistant.current.data).computerId : undefined;
  const inputs = postedInputs(rows);
  let pending = false;
  let link: Link | undefined;
  for (const input of inputs) {
    const turnId = input.event.id;
    const needsStop = await settleClosedInput(options, conversationId, assistantId,
      turnId, assistant, saved);
    if (!needsStop) continue;
    pending = true;
    link = await sendCloseStop(conversationId, assistantId, turnId, assistant,
      refused, link, connection);
  }
  await recoverTerminalTurns(options, currentComputer ?? '', assistantId, conversationId,
    rows, assistant.closed, assistant.started, assistant.turnComputers, assistant.lostTurns);
  if (link) return { pending, retry: pending, connectionId: link.connectionId };
  return { pending, retry: pending };
}
