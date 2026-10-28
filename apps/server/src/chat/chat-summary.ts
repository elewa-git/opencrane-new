import { foldMemoryContext, type MemoryContextState } from '@opencrane/models';
import { readStreamSummary, WrongSiloError, type EventStore,
  type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { z } from 'zod';
import { memoryContextRecordedEventSchema } from '@opencrane/events';

type Message = { authorId: unknown; executionMode: unknown; position: number };
type ComputerReports = { lastSequence: number; positions: Map<number, number> };
type ChatSummary = {
  contentSequence: number;
  eventPositions: Map<string, number>;
  eventPositionBytes: number;
  stopRows: StoredEvent[];
  latestHuman?: { id: string; authorId: unknown } | undefined;
  created: Record<string, unknown> | undefined;
  conversationClosed: boolean;
  messages: Map<string, Message>;
  closedTurnIds: Set<string>;
  cleanupEndedTurnIds: Set<string>;
  reports: Map<string, ComputerReports>;
  reportCount: number;
  memoryContexts: Map<string, MemoryContextState>;
  memoryFailure: string | undefined;
};
export type ChatFacts = {
  conversationClosed: boolean;
  latestHuman?: { id: string; authorId: unknown } | undefined;
  created: Record<string, unknown> | undefined;
  message: Message | undefined;
  turnEnded: boolean;
  cleanupEnded: boolean;
  lastReportSequence: number;
  reportPosition: number | undefined;
  sequence: number;
  memoryContext: MemoryContextState | undefined;
};
const closedTurn = z.object({ turnId: z.string() });

function emptyChat(): ChatSummary {
  return { contentSequence: 0, eventPositions: new Map(), eventPositionBytes: 0, stopRows: [],
    created: undefined, conversationClosed: false,
    messages: new Map(), closedTurnIds: new Set(), cleanupEndedTurnIds: new Set(),
    reports: new Map(), reportCount: 0, memoryContexts: new Map(), memoryFailure: undefined };
}
function addChat(summary: ChatSummary, row: StoredEvent) {
  const event = row.event;
  addCommandFacts(summary, row);
  if (event.type === 'agent.memory_context_recorded') {
    retainMemoryContext(summary, row);
  }
  let data: Record<string, unknown> | undefined;
  if (event.type === 'conversation.created' || event.type === 'message.posted') {
    data = z.record(z.string(), z.unknown()).parse(event.data);
  }
  let closedTurnId: string | undefined;
  const budgetStopped = event.type === 'agent.turn_stop_requested' &&
    z.object({ reason: z.string().optional() }).parse(event.data).reason === 'budget';
  if (event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed' || budgetStopped) {
    closedTurnId = closedTurn.parse(event.data).turnId;
  }
  if (event.type === 'conversation.created' && summary.created === undefined) {
    summary.created = data;
  }
  if (event.type === 'message.posted' && data && !summary.messages.has(event.id)) {
    const message = { authorId: data['authorId'], executionMode: data['executionMode'],
      position: row.sequence };
    summary.messages.set(event.id, message);
  }
  addConversationFacts(summary, row, data);
  recordClosedTurn(summary, row, closedTurnId);
  closeMemoryContexts(summary, closedTurnId);
  if (event.report) addReport(summary, event.report, row.sequence);
}
function addCommandFacts(summary: ChatSummary, row: StoredEvent) {
  const type = row.event.type;
  // Check every saved id so a command cannot reuse a report id after broker deduplication expires.
  if (!summary.eventPositions.has(row.event.id)) {
    summary.eventPositions.set(row.event.id, row.sequence);
    summary.eventPositionBytes += eventPositionSize(row);
  }
  if (type === 'conversation.created' || type === 'conversation.closed' ||
      type === 'agent.turn_stop_requested' || type === 'agent.turn_completed' ||
      type === 'agent.turn_failed') {
    summary.stopRows.push(row);
  }
}

function eventPositionSize(row: StoredEvent) {
  const type = row.event.type;
  const compactBytes = 64 + row.event.id.length * 2;
  if (type === 'conversation.created' || type === 'message.posted' ||
      type === 'agent.turn_stop_requested') {
    return Math.max(256, compactBytes);
  }
  // Count the id and numeric position without retaining the report or its text.
  return compactBytes;
}

function recordClosedTurn(summary: ChatSummary, row: StoredEvent,
  turnId: string | undefined) {
  if (turnId === undefined) return;
  summary.closedTurnIds.add(turnId);
  const event = row.event;
  if (event.type === 'agent.turn_failed' && event.source === 'opencrane-server' &&
      event.principal?.id === 'close-cleanup') {
    summary.cleanupEndedTurnIds.add(turnId);
  }
}
function retainMemoryContext(summary: ChatSummary, row: StoredEvent) {
  if (summary.memoryFailure !== undefined) return;
  try {
    addMemoryContext(summary, row);
  } catch (error) {
    // Keep chat commands available, but preserve the refusal for every memory reader.
    summary.memoryFailure = 'Memory evidence unavailable';
    if (error instanceof Error) summary.memoryFailure = error.message;
  }
}
function addMemoryContext(summary: ChatSummary, row: StoredEvent) {
  const event = row.event;
  const data = memoryContextRecordedEventSchema.parse(event).data;
  const turnId = data.turnId;
  const lateInitialLoad = summary.conversationClosed && data.delivery === 'initial';
  const withdrawal = data.action === 'invalidated' &&
    (data.reason === 'content_changed' || data.reason === 'expired' ||
      data.reason === 'access_changed');
  if (lateInitialLoad || (summary.closedTurnIds.has(turnId) && !withdrawal)) {
    throw new Error('Memory evidence arrived after the turn closed');
  }
  const previous = summary.memoryContexts.get(turnId);
  const context = foldMemoryContext(previous, event);
  summary.memoryContexts.set(turnId, context);
}
function closeMemoryContexts(summary: ChatSummary, turnId: string | undefined) {
  if (turnId !== undefined) {
    const context = summary.memoryContexts.get(turnId);
    if (context) {
      context.status = 'ended';
      context.reason = 'ended';
    }
  }
}
function memoryContextFacts(summary: ChatSummary, turnId: string) {
  const context = structuredClone(summary.memoryContexts.get(turnId));
  if (context && summary.conversationClosed) {
    // Keep closure separate from evidence: a recall append can finish after the
    // participation stream closes. Retain its accounting, but never reopen the context.
    context.status = 'ended';
    context.reason = 'ended';
  }
  return context;
}
function addConversationFacts(summary: ChatSummary, row: StoredEvent,
  data: Record<string, unknown> | undefined) {
  // Keep the append position on the content stream, even when a legacy close is newer.
  if (row.event.subject.startsWith('conversation-')) summary.contentSequence = row.sequence;
  if (row.event.type === 'message.posted' && data?.['authorKind'] === 'human') {
    summary.latestHuman = { id: row.event.id, authorId: data['authorId'] };
  }
  if (row.event.type === 'conversation.closed') summary.conversationClosed = true;
}
function addReport(summary: ChatSummary, report: NonNullable<StoredEvent['event']['report']>,
  position: number) {
  let reports = summary.reports.get(report.computerId);
  if (!reports) {
    reports = { lastSequence: 0, positions: new Map() };
    summary.reports.set(report.computerId, reports);
  }
  reports.lastSequence = report.sequence;
  const preceding = report.preceding ?? [];
  const receipts = [...preceding, report];
  for (const receipt of receipts) {
    if (!reports.positions.has(receipt.sequence)) {
      reports.positions.set(receipt.sequence, position);
      summary.reportCount++;
    }
  }
}
const chat: SummaryKind<ChatSummary> = {
  name: 'chat', keep: 64, includeConversationCloses: true,
  empty: emptyChat, add: addChat,
  budget: { limit: 32 * 1024 * 1024, size: chatSize },
};
function chatSize(summary: ChatSummary) {
  // Count compact replay positions separately so many reply chunks can stay warm.
  return summary.messages.size * 256 + summary.closedTurnIds.size * 128 +
    summary.cleanupEndedTurnIds.size * 128 + summary.reports.size * 256 +
    summary.reportCount * 64 + summary.eventPositionBytes +
    summary.stopRows.length * 512 + memorySize(summary);
}
function memorySize(summary: ChatSummary) {
  let bytes = (summary.memoryFailure?.length ?? 0) * 2;
  for (const context of summary.memoryContexts.values()) {
    bytes += 2048 + context.references.length * 1024;
    for (const saved of context.events.values()) {
      bytes += saved.length * 2 + 256;
    }
  }
  return bytes;
}

export async function readChatFacts(store: Pick<EventStore, 'readStream'>, silo: string,
  conversationId: string, turnId: string, computerId?: string, reportSequence?: number,
  deadline = performance.now() + 10_000) {
  function take(summary: ChatSummary): ChatFacts {
    if (summary.memoryFailure !== undefined) throw new Error(summary.memoryFailure);
    let messageId = turnId;
    const preparation = summary.created?.['routinePreparation'];
    if (preparation !== undefined) {
      const saved = z.object({ occurrenceId: z.string() }).parse(preparation);
      if (turnId === `routine-turn-${saved.occurrenceId}`) {
        messageId = `routine-input-${saved.occurrenceId}`;
      }
    }
    const message = summary.messages.get(messageId);
    const reports = computerId === undefined ? undefined : summary.reports.get(computerId);
    let reportPosition: number | undefined;
    if (reportSequence !== undefined) reportPosition = reports?.positions.get(reportSequence);
    return {
      created: summary.created === undefined ? undefined : { ...summary.created },
      message: message === undefined ? undefined : { ...message },
      turnEnded: summary.closedTurnIds.has(turnId),
      cleanupEnded: summary.cleanupEndedTurnIds.has(turnId),
      latestHuman: summary.latestHuman,
      conversationClosed: summary.conversationClosed,
      lastReportSequence: reports?.lastSequence ?? 0,
      reportPosition, sequence: summary.contentSequence,
      memoryContext: memoryContextFacts(summary, turnId),
    };
  }
  try {
    return await readStreamSummary(store, silo, `conversation-${conversationId}`,
      chat, deadline, take);
  } catch (error) {
    if (error instanceof WrongSiloError) throw new Error('Conversation silo mismatch', { cause: error });
    throw error;
  }
}

export function readChatCommandFacts(store: Pick<EventStore, 'readStream'>, silo: string,
  conversationId: string, commandId: string, turnId?: string) {
  function isCreation(row: StoredEvent) { return row.event.type === 'conversation.created'; }
  function take(summary: ChatSummary) {
    return {
      created: summary.stopRows.find(isCreation), closed: summary.conversationClosed,
      position: summary.eventPositions.get(commandId), sequence: summary.contentSequence,
      turnPosition: turnId === undefined ? undefined : summary.eventPositions.get(turnId),
    };
  }
  return readStreamSummary(store, silo, `conversation-${conversationId}`, chat,
    performance.now() + 10_000, take);
}

export function readChatStopRows(store: Pick<EventStore, 'readStream'>, silo: string,
  conversationId: string) {
  function take(summary: ChatSummary) { return [...summary.stopRows]; }
  return readStreamSummary(store, silo, `conversation-${conversationId}`, chat,
    performance.now() + 10_000, take);
}
