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
  privateStarted: Set<string>;
  closed: Set<string>;
  lostTurns: Set<string>;
  turnComputers: Map<string, string>;
  closedStatuses: Map<string, 'completed' | 'failed'>;
};
type Options = { silo: string; store: EventStore };
type SavedTurns = { ended: Set<string>; cancelled: Set<string>; starts: Set<string>;
  exited: Set<string> };
type CleanupDecision = { pending: boolean; stop: boolean };
type CleanupWriter = { rows: ChatRows; saved: SavedTurns; sequence: number;
  computerStarts?: { turnIds: Set<string>; sequence: number } };
export type CloseCleanupCursor = { index: number; pending: boolean };
const recoveryItemLimit = 32;
const recoveryTimeLimitMs = 1000;
const turnData = z.object({ turnId: z.string() });
const computerData = z.object({ computerId: z.string() });
const postedAuthor = z.object({ authorKind: z.enum(['human', 'agent', 'system']) });

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

function privateExits(rows: ChatRows, turnComputers?: Map<string, string>) {
  const exited = new Set<string>();
  for (const row of rows) {
    if (row.event.type !== 'agent.private_exited' || row.event.source !== 'computer-bridge') {
      continue;
    }
    const turnId = turnData.parse(row.event.data).turnId;
    const originalComputer = turnComputers?.get(turnId);
    if (originalComputer && row.event.report?.computerId === originalComputer) exited.add(turnId);
  }
  return exited;
}

function postedInputs(rows: ChatRows) {
  function isPosted(row: ChatRows[number]) {
    return row.event.type === 'message.posted' &&
      postedAuthor.parse(row.event.data).authorKind === 'human';
  }
  return rows.filter(isPosted);
}

function failureId(conversationId: string, turnId: string) {
  const digest = createHash('sha256');
  digest.update(`conversation-closed:${conversationId}:${turnId}`);
  return digest.digest('hex');
}

function savedTurns(rows: ChatRows, assistant: Assistant): SavedTurns {
  return { ended: terminalTurns(rows), cancelled: cleanupFailures(rows),
    starts: reportedStarts(rows), exited: privateExits(rows, assistant.turnComputers) };
}

function conversationSequence(rows: ChatRows, conversationId: string) {
  const subject = `conversation-${conversationId}`;
  let sequence = 0;
  for (const row of rows) {
    if (row.event.subject === subject) sequence = Math.max(sequence, row.sequence);
  }
  return sequence;
}

async function computerStarts(options: Options, assistantId: string) {
  const started = new Set<string>();
  const rows = await history(options.store, `computer-${assistantId}`);
  let sequence = 0;
  for (const row of rows) {
    sequence = Math.max(sequence, row.sequence);
    if (row.event.type === 'computer.turn_started') {
      started.add(turnData.parse(row.event.data).turnId);
    }
  }
  return { turnIds: started, sequence };
}

async function appendTerminal(options: Options, conversationId: string, turnId: string,
  assistantId: string, status: 'completed' | 'failed', allowStarted: boolean,
  writer: CleanupWriter, assistant: Assistant) {
  const subject = `conversation-${conversationId}`;
  const id = failureId(conversationId, turnId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (writer.saved.ended.has(turnId)) return;
    if (writer.saved.starts.has(turnId) && !allowStarted) return;
    if (!allowStarted) {
      writer.computerStarts ??= await computerStarts(options, assistantId);
      if (writer.computerStarts.turnIds.has(turnId)) return;
      const currentSequence = await options.store.head(`computer-${assistantId}`, Infinity);
      if (currentSequence !== writer.computerStarts.sequence) {
        // Retry with a fresh computer history before deciding that a turn never started.
        throw new Error('Close cleanup changed; retrying');
      }
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
    const result = await options.store.append({ expectedSequence: writer.sequence,
      historyChecked: true, event });
    if (result.status === 'appended') {
      writer.sequence++;
      writer.saved.ended.add(turnId);
      if (status === 'failed') writer.saved.cancelled.add(turnId);
      return;
    }
    if (result.status !== 'rejected') throw new Error('Close cleanup unavailable');
    // Read fresh history after a concurrent append before another conditional write.
    writer.rows = await chatHistory(options.store, options.silo, conversationId);
    writer.saved = savedTurns(writer.rows, assistant);
    writer.sequence = conversationSequence(writer.rows, conversationId);
    delete writer.computerStarts;
  }
  throw new Error('Close cleanup changed; retrying');
}

function recoverableTerminal(row: ChatRows[number], started: Set<string> | undefined,
  lostTurns: Set<string> | undefined, privateStarted: Set<string> | undefined,
  exited: Set<string>) {
  if (row.event.type !== 'agent.turn_completed' && row.event.type !== 'agent.turn_failed') {
    return false;
  }
  const turnId = turnData.parse(row.event.data).turnId;
  if (started && !started.has(turnId)) return false;
  if (privateStarted?.has(turnId) && !exited.has(turnId) && !lostTurns?.has(turnId)) {
    return false;
  }
  if (row.event.principal?.id === 'close-cleanup'
    && !lostTurns?.has(turnId) && !exited.has(turnId)) return false;
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
  started?: Set<string>, turnComputers?: Map<string, string>, lostTurns?: Set<string>,
  privateStarted?: Set<string>, maxActions = Infinity, deadline = Infinity) {
  // Recover a server crash between the agent report and the separate computer event.
  let refreshed = false;
  let actions = 0;
  const exited = privateExits(rows, turnComputers);
  for (const row of rows) {
    if (!recoverableTerminal(row, started, lostTurns, privateStarted, exited)) continue;
    const terminal = turnData.parse(row.event.data);
    if (closed.has(terminal.turnId)) continue;
    if (actions >= maxActions || performance.now() >= deadline) return false;
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
    actions++;
  }
  return true;
}

async function settleClosedInput(options: Options, conversationId: string, assistantId: string,
  turnId: string, assistant: Assistant, writer: CleanupWriter): Promise<CleanupDecision> {
  const saved = writer.saved;
  const admitted = saved.starts.has(turnId) || assistant.started.has(turnId);
  if (!admitted) {
    if (!saved.ended.has(turnId)) {
      await appendTerminal(options, conversationId, turnId, assistantId, 'failed', false,
        writer, assistant);
    }
    return { pending: false, stop: false };
  }
  // Keep cleanup open until the supervisor confirms exit or this computer is known lost.
  const waitingForPrivateExit = assistant.privateStarted.has(turnId)
    && !saved.exited.has(turnId) && !assistant.lostTurns.has(turnId);
  if (waitingForPrivateExit) return { pending: true, stop: true };
  const unsettledCancellation = saved.cancelled.has(turnId) &&
    assistant.started.has(turnId) && !assistant.closed.has(turnId);
  if (saved.ended.has(turnId) && !unsettledCancellation) {
    return { pending: !assistant.closed.has(turnId), stop: false };
  }
  const savedStatus = assistant.closedStatuses.get(turnId);
  if (savedStatus) {
    await appendTerminal(options, conversationId, turnId, assistantId, savedStatus, true,
      writer, assistant);
    return { pending: !assistant.closed.has(turnId), stop: false };
  }
  if (assistant.lostTurns.has(turnId) || saved.exited.has(turnId)) {
    await appendTerminal(options, conversationId, turnId, assistantId, 'failed', true,
      writer, assistant);
    return { pending: !assistant.closed.has(turnId), stop: false };
  }
  return { pending: true, stop: true };
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
  readyLink.socket.send(JSON.stringify({ type: 'stop', turnId, conversationId,
    reason: 'conversation_closed' }));
  return readyLink;
}

type InputBatch = {
  options: Options;
  conversationId: string;
  assistantId: string;
  assistant: Assistant;
  refused: Set<string>;
  connection: (computerId: string, assistantId: string) => Promise<Link>;
  writer: CleanupWriter;
  cursor: CloseCleanupCursor | undefined;
  deadline: number;
};

async function visitClosedInputs(batch: InputBatch) {
  const inputs = postedInputs(batch.writer.rows);
  let inputPending = batch.cursor?.pending ?? false;
  let link: Link | undefined;
  let visited = 0;
  let nextIndex = batch.cursor?.index ?? 0;
  if (nextIndex >= inputs.length) nextIndex = 0;
  // Leave one action in every pass for a missing computer ending.
  while (nextIndex < inputs.length && visited < recoveryItemLimit - 1
    && performance.now() < batch.deadline) {
    const input = inputs[nextIndex];
    if (!input) break;
    const turnId = input.event.id;
    const decision = await settleClosedInput(batch.options, batch.conversationId,
      batch.assistantId, turnId, batch.assistant, batch.writer);
    if (decision.pending) inputPending = true;
    if (decision.stop) {
      link = await sendCloseStop(batch.conversationId, batch.assistantId, turnId,
        batch.assistant, batch.refused, link, batch.connection);
    }
    visited++;
    nextIndex++;
  }
  return { inputPending, link, visited, nextIndex, moreInputs: nextIndex < inputs.length };
}

export async function cleanClosedConversation(options: Options, conversationId: string,
  assistantId: string, rows: ChatRows, assistant: Assistant, refused: Set<string>,
  connection: (computerId: string, assistantId: string) => Promise<Link>,
  cursor?: CloseCleanupCursor) {
  const writer: CleanupWriter = { rows, saved: savedTurns(rows, assistant),
    sequence: conversationSequence(rows, conversationId) };
  const currentComputer = assistant.current
    ? computerData.parse(assistant.current.data).computerId : undefined;
  const deadline = performance.now() + recoveryTimeLimitMs;
  const batch = { options, conversationId, assistantId, assistant, refused, connection,
    writer, cursor, deadline };
  const progress = await visitClosedInputs(batch);
  const remainingActions = recoveryItemLimit - progress.visited;
  const recovered = await recoverTerminalTurns(options, currentComputer ?? '', assistantId,
    conversationId, writer.rows, assistant.closed, assistant.started,
    assistant.turnComputers, assistant.lostTurns, assistant.privateStarted,
    remainingActions, deadline);
  const pending = progress.inputPending || progress.moreInputs || !recovered;
  const nextCursor = { index: progress.moreInputs ? progress.nextIndex : 0,
    pending: progress.moreInputs ? progress.inputPending : false };
  const result = { pending, retry: pending, cursor: nextCursor };
  if (progress.link) return { ...result, connectionId: progress.link.connectionId };
  return result;
}
