import { foldMemoryContext, type MemoryContextState } from '@opencrane/models';
import { readStreamSummary, WrongSiloError, type EventStore,
  type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { z } from 'zod';
import { memoryContextRecordedEventSchema } from '@opencrane/events';

type Message = { authorId: unknown; executionMode: unknown; position: number };
type ComputerReports = { lastSequence: number; positions: Map<number, number> };
type ChatSummary = {
  contentSequence: number;
  latestHuman?: { id: string; authorId: unknown } | undefined;
  created: Record<string, unknown> | undefined;
  conversationClosed: boolean;
  messages: Map<string, Message>;
  closedTurnIds: Set<string>;
  cleanupEndedTurnIds: Set<string>;
  reports: Map<string, ComputerReports>;
  reportCount: number;
  memoryContexts: Map<string, MemoryContextState>;
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
  return { contentSequence: 0, created: undefined, conversationClosed: false,
    messages: new Map(), closedTurnIds: new Set(), cleanupEndedTurnIds: new Set(),
    reports: new Map(), reportCount: 0, memoryContexts: new Map() };
}
function addChat(summary: ChatSummary, row: StoredEvent) {
  const event = row.event;
  if (event.type === 'agent.memory_context_recorded') {
    addMemoryContext(summary, row);
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
function addMemoryContext(summary: ChatSummary, row: StoredEvent) {
  const event = row.event;
  const data = memoryContextRecordedEventSchema.parse(event).data;
  const turnId = data.turnId;
  const lateInitialLoad = summary.conversationClosed && data.delivery === 'initial';
  if (lateInitialLoad || summary.closedTurnIds.has(turnId)) {
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
  if (!reports.positions.has(report.sequence)) {
    reports.positions.set(report.sequence, position);
    summary.reportCount++;
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
    summary.reportCount * 64 + memorySize(summary);
}
function memorySize(summary: ChatSummary) {
  let bytes = 0;
  for (const context of summary.memoryContexts.values()) {
    bytes += 2048 + context.references.length * 1024;
    for (const saved of context.events.values()) {
      bytes += saved.length * 2 + 256;
    }
  }
  return bytes;
}

export async function readChatFacts(store: Pick<EventStore, 'readStream'>, silo: string,
  conversationId: string, turnId: string, computerId?: string, reportSequence?: number) {
  function take(summary: ChatSummary): ChatFacts {
    const message = summary.messages.get(turnId);
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
    const deadline = performance.now() + 10_000;
    return await readStreamSummary(store, silo, `conversation-${conversationId}`,
      chat, deadline, take);
  } catch (error) {
    if (error instanceof WrongSiloError) throw new Error('Conversation silo mismatch', { cause: error });
    throw error;
  }
}
