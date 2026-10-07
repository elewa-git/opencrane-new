import { readStreamSummary, WrongSiloError, type EventStore,
  type StoredEvent, type SummaryKind } from '@opencrane/event-store';
import { z } from 'zod';

type Message = { authorId: unknown; executionMode: unknown };
type ComputerReports = { lastSequence: number; positions: Map<number, number> };
type ChatSummary = {
  created: Record<string, unknown> | undefined;
  messages: Map<string, Message>;
  closedTurnIds: Set<string>;
  reports: Map<string, ComputerReports>;
  reportCount: number;
};
export type ChatFacts = {
  created: Record<string, unknown> | undefined;
  message: Message | undefined;
  closed: boolean;
  lastReportSequence: number;
  reportPosition: number | undefined;
  sequence: number;
};
const closedTurn = z.object({ turnId: z.string() });

function emptyChat(): ChatSummary {
  return { created: undefined, messages: new Map(), closedTurnIds: new Set(),
    reports: new Map(), reportCount: 0 };
}
function addChat(summary: ChatSummary, row: StoredEvent) {
  const event = row.event;
  let data: Record<string, unknown> | undefined;
  if (event.type === 'conversation.created' || event.type === 'message.posted') {
    data = z.record(z.string(), z.unknown()).parse(event.data);
  }
  let closedTurnId: string | undefined;
  if (event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed') {
    closedTurnId = closedTurn.parse(event.data).turnId;
  }
  if (event.type === 'conversation.created' && summary.created === undefined) {
    summary.created = data;
  }
  if (event.type === 'message.posted' && data && !summary.messages.has(event.id)) {
    const message = { authorId: data['authorId'], executionMode: data['executionMode'] };
    summary.messages.set(event.id, message);
  }
  if (closedTurnId !== undefined) summary.closedTurnIds.add(closedTurnId);
  if (event.report) addReport(summary, event.report, row.sequence);
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
  name: 'chat', keep: 64, empty: emptyChat, add: addChat,
  budget: { limit: 32 * 1024 * 1024, size: chatSize },
};
function chatSize(summary: ChatSummary) {
  // Count compact replay positions separately so many reply chunks can stay warm.
  return summary.messages.size * 256 + summary.closedTurnIds.size * 128 +
    summary.reports.size * 256 + summary.reportCount * 64;
}

export async function readChatFacts(store: Pick<EventStore, 'readStream'>, silo: string,
  conversationId: string, turnId: string, computerId?: string, reportSequence?: number) {
  function take(summary: ChatSummary, sequence: number): ChatFacts {
    const message = summary.messages.get(turnId);
    const reports = computerId === undefined ? undefined : summary.reports.get(computerId);
    let reportPosition: number | undefined;
    if (reportSequence !== undefined) reportPosition = reports?.positions.get(reportSequence);
    return {
      created: summary.created === undefined ? undefined : { ...summary.created },
      message: message === undefined ? undefined : { ...message },
      closed: summary.closedTurnIds.has(turnId),
      lastReportSequence: reports?.lastSequence ?? 0,
      reportPosition, sequence,
    };
  }
  try {
    return await readStreamSummary(store, silo, `conversation-${conversationId}`,
      chat, performance.now() + 10_000, take);
  } catch (error) {
    if (error instanceof WrongSiloError) throw new Error('Conversation silo mismatch', { cause: error });
    throw error;
  }
}
