import {
  conversationCreatedDataSchema, agentToolCallStartedDataSchema, agentToolCallFinishedDataSchema,
  agentNativeConsentRefusedDataSchema, agentNativeRequestRefusedDataSchema,
} from '@opencrane/events';
import { computerSummary, type ComputerSummary, type TurnSummary } from '@opencrane/auth';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readEventAt, readStreamSummary, type AppendCommand, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { readChatFacts, type ChatFacts } from './chat-summary.ts';
import type { conversationKeys } from './keys.ts';
import { chatWrite } from './write-priority.ts';

// Permanent refusals need operator attention; reconnecting cannot repair them.
export class ReportRejected extends Error {}

const existingReportSchema = z.object({ sequence: z.int().positive(), previousSequence: z.int().nonnegative().optional(), conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string(), assistantId: z.string(), requesterId: z.string().optional(), threadId: z.string().optional(), messageId: z.string().optional(), text: z.string().max(128_000).optional(),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), exitCode: z.int().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(),
  sharingClass: z.literal('shared_only').optional(),
  reason: z.enum(['bridge_interrupted', 'restricted_tool_refused']).optional(),
  type: z.enum(['agent.output_lost', 'agent.command_ran', 'agent.reasoning_summarised', 'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed', 'agent.message_delta', 'agent.message_completed']),
}).strict();
const toolReportFields = {
  sequence: z.int().positive(), previousSequence: z.int().nonnegative().optional(),
  assistantId: z.string(), requesterId: z.string().optional(),
};
const toolStartedReportSchema = agentToolCallStartedDataSchema.extend({
  ...toolReportFields, type: z.literal('agent.tool_call_started'),
});
const toolFinishedReportSchema = agentToolCallFinishedDataSchema.extend({
  ...toolReportFields, type: z.literal('agent.tool_call_finished'),
});
const nativeConsentReportSchema = agentNativeConsentRefusedDataSchema.extend({
  ...toolReportFields, type: z.literal('agent.native_consent_refused'),
});
const nativeRequestReportSchema = agentNativeRequestRefusedDataSchema.extend({
  ...toolReportFields, type: z.literal('agent.native_request_refused'),
});
const reportSchema = z.union([
  nativeRequestReportSchema,
  nativeConsentReportSchema,
  existingReportSchema, toolStartedReportSchema, toolFinishedReportSchema,
]);
type Report = z.infer<typeof reportSchema>;
type ReportContext = { silo: string; computerId: string; assistantId: string };
function reportDigest(report: Report) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(report));
  return hash.digest('hex');
}

export function canCombineReports(first: unknown, next: unknown, textLength: number) {
  const left = reportSchema.parse(first);
  const right = reportSchema.parse(next);
  if (left.type !== 'agent.message_delta' || right.type !== left.type ||
      left.previousSequence === undefined || right.previousSequence !== left.sequence ||
      right.sequence <= left.sequence || typeof left.text !== 'string' ||
      typeof right.text !== 'string' || textLength + right.text.length > 128_000) return false;
  // Compare every other field so additional report details cannot be mixed silently.
  const { sequence: leftSequence, previousSequence: leftPrevious, text: leftText,
    ...leftIdentity } = left;
  const { sequence: rightSequence, previousSequence: rightPrevious, text: rightText,
    ...rightIdentity } = right;
  void leftSequence;
  void leftPrevious;
  void leftText;
  void rightSequence;
  void rightPrevious;
  void rightText;
  return JSON.stringify(leftIdentity) === JSON.stringify(rightIdentity);
}

export async function recordReports(store: EventStore, keys: ReturnType<typeof conversationKeys>,
  context: ReportContext, values: unknown[]) {
  const reports: Report[] = [];
  let text = '';
  for (const value of values) {
    const report = reportSchema.parse(value);
    const previous = reports.at(-1);
    if (previous && !canCombineReports(previous, report, text.length)) {
      throw new ReportRejected('Report batch mismatch');
    }
    text += 'text' in report ? report.text ?? '' : '';
    reports.push(report);
  }
  const last = reports.at(-1);
  if (!last || reports.length > 64) throw new ReportRejected('Invalid report batch');
  if (reports.length === 1) return recordReport(store, keys, context, last);
  const combined = { ...last, text };
  return recordReport(store, keys, context, combined, reports);
}

export async function reportPosition(store: EventStore, silo: string, computerId: string) {
  const sequences = new Set<number>();
  for await (const { event } of readEvents(store, 1, await store.head())) {
    if (event.silo === silo && event.report?.computerId === computerId) {
      sequences.add(event.report.sequence);
      for (const receipt of event.report.preceding ?? []) sequences.add(receipt.sequence);
    }
  }
  let position = 0;
  while (sequences.has(position + 1)) position++;
  return position;
}
export async function recordReport(store: EventStore, keys: ReturnType<typeof conversationKeys>,
  context: ReportContext, value: unknown, batch?: Report[],
  deadline = performance.now() + 10_000): Promise<'duplicate' | 'recorded'> {
  const report = reportSchema.parse(value);
  if (report.assistantId !== context.assistantId) throw new ReportRejected('Assistant mismatch');
  const digest = reportDigest(batch?.at(-1) ?? report);
  const first = batch?.[0] ?? report;
  const facts = await readChatFacts(store, context.silo, report.conversationId,
    report.turnId, context.computerId, first.sequence, deadline);
  const created = agentSessionData(facts.created);
  const authorId = reportAuthor(report, context.assistantId, created, facts.message);
  const subject = `conversation-${report.conversationId}`;
  if (facts.reportPosition !== undefined) {
    return verifyRecordedReport(store, keys, context, report, batch, facts.reportPosition, digest);
  }
  await requireSharedReportTurn(store, context, report, created, authorId);
  let previousSequence = facts.lastReportSequence;
  let expectedPrevious = first.previousSequence;
  if (expectedPrevious === undefined) {
    previousSequence = await reportPosition(store, context.silo, context.computerId);
    expectedPrevious = report.sequence - 1;
  }
  if (expectedPrevious !== previousSequence) throw new ReportRejected('Report sequence gap');
  const event = reportEvent(report, context, keys, batch, digest);
  const command: AppendCommand = { expectedSequence: facts.sequence, historyChecked: true, event };
  const append = store.append.bind(store, command);
  const result = await chatWrite(store, subject, 'report', append);
  if (result.status === 'conflict' && performance.now() < deadline) {
    // Reload after a competing Stop or message. Never repeat an uncertain append.
    return recordReport(store, keys, context, value, batch, deadline);
  }
  if (result.status === 'rejected') throw new ReportRejected('Report append rejected');
  if (result.status !== 'appended') throw new Error('Report append unavailable');
  const committed = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
  verifyDigest(committed, digest, event.id);
  if (batch) {
    // A concurrent append may save different groups with the same final report.
    // Check every original against its saved receipt before acknowledging the batch.
    await verifyAppendedBatch(store, context, batch, committed!);
  }
  return 'recorded' as const;
}

async function verifyAppendedBatch(store: EventStore, context: ReportContext,
  batch: Report[], committed: StoredEvent) {
  for (const original of batch) {
    function matchesSequence(receipt: { sequence: number }) {
      return receipt.sequence === original.sequence;
    }
    const receipt = committed.event.report;
    let saved: StoredEvent | undefined = committed;
    if (receipt?.sequence !== original.sequence && !receipt?.preceding?.some(matchesSequence)) {
      const deadline = performance.now() + 10_000;
      const facts = await readChatFacts(store, context.silo, original.conversationId,
        original.turnId, context.computerId, original.sequence, deadline);
      saved = undefined;
      if (facts.reportPosition !== undefined) {
        saved = await readEventAt(store, committed.event.subject, facts.reportPosition, deadline);
      }
    }
    if (!saved) throw new ReportRejected('Report sequence reused');
    verifyReportReplay(saved, original, reportDigest(original));
  }
}

function reportAuthor(report: Report, assistantId: string,
  created: ReturnType<typeof agentSessionData>, message: ChatFacts['message']) {
  if (created.assistantId !== assistantId || !message) {
    throw new ReportRejected('Unrequested report');
  }
  validateReportContextClass(report, created);
  if (report.requesterId) {
    const author = z.object({ authorId: z.string() }).parse(message);
    if (author.authorId !== report.requesterId) throw new ReportRejected('Requester mismatch');
  }
  return message.authorId;
}

async function verifyRecordedReport(store: EventStore, keys: ReturnType<typeof conversationKeys>,
  context: ReportContext, report: Report, batch: Report[] | undefined, position: number,
  digest: string) {
  if (batch) {
    // Replay can split a previously saved batch. Check every original digest and position.
    for (const original of batch) await recordReport(store, keys, context, original);
    return 'duplicate' as const;
  }
  const subject = `conversation-${report.conversationId}`;
  const previous = await readEventAt(store, subject, position, performance.now() + 10_000);
  if (previous) verifyReportReplay(previous, report, digest);
  else verifyDigest(undefined, digest);
  return 'duplicate' as const;
}

function reportEvent(report: Report, context: ReportContext,
  keys: ReturnType<typeof conversationKeys>, batch: Report[] | undefined, digest: string) {
  const subject = `conversation-${report.conversationId}`;
  const data = reportData(report, context.silo, context.assistantId, keys);
  const commandHash = createHash('sha256');
  commandHash.update(`${context.computerId}:${report.sequence}`);
  const id = `bridge-${commandHash.digest('hex')}`;
  const earlier = batch?.slice(0, -1);
  const preceding = earlier?.map(receiptFor);
  const event = {
    id, commandId: id, type: report.type, silo: context.silo, subject,
    source: 'computer-bridge', principal: { kind: 'agent' as const, id: context.assistantId },
    time: new Date().toISOString(),
    report: { computerId: context.computerId, sequence: report.sequence, digest,
      ...(preceding ? { preceding } : {}) }, data,
  };
  return event;
}

async function requireSharedReportTurn(store: EventStore,
  context: { silo: string; assistantId: string; computerId: string },
  report: z.infer<typeof reportSchema>, created: ReturnType<typeof agentSessionData>,
  requesterId: unknown) {
  if (report.type === 'agent.turn_started') return;
  if (!('contextKind' in created) || created.contextKind !== 'shared_child') return;
  function take(summary: ComputerSummary) {
    const turn = summary.turns.get(report.turnId);
    if (turn) return { ...turn };
    return undefined;
  }
  // Check saved admission before encrypting output. A computer's claim is not proof.
  const subject = `computer-${context.assistantId}`;
  const turn = await readStreamSummary(store, context.silo, subject,
    computerSummary, performance.now() + 10_000, take);
  let savedTurn = turn?.firstStart;
  if (!savedTurn) {
    savedTurn = await refusedSharedTurn(store, subject, turn, report.type);
  }
  if (!savedTurn || savedTurn.event.source !== 'opencrane-server') {
    throw new ReportRejected('Shared report has no admitted turn');
  }
  verifySharedReportBinding(savedTurn, context, report, requesterId);
}

function verifySharedReportBinding(savedTurn: StoredEvent,
  context: { assistantId: string; computerId: string },
  report: z.infer<typeof reportSchema>, requesterId: unknown) {
  const saved = z.record(z.string(), z.unknown()).parse(savedTurn.event.data);
  const threadId = 'threadId' in report ? report.threadId : undefined;
  const restrictedStart = savedTurn.event.type !== 'computer.turn_started'
    || saved['executionMode'] === 'restricted';
  if (saved['sharingClass'] !== 'shared_only' || !restrictedStart
    || saved['computerId'] !== context.computerId || saved['assistantId'] !== context.assistantId
    || saved['conversationId'] !== report.conversationId || saved['turnId'] !== report.turnId
    || saved['requesterId'] !== requesterId || saved['threadId'] !== threadId) {
    throw new ReportRejected('Shared report turn mismatch');
  }
}

async function refusedSharedTurn(store: EventStore, subject: string,
  turn: TurnSummary | undefined, reportType: string) {
  if (reportType !== 'agent.turn_failed' || !turn || turn.hasStart
    || turn.firstClose?.status !== 'failed') return undefined;
  // Accept only the terminal reply to a saved refusal; it grants no execution or output access.
  const closed = await readEventAt(store, subject, turn.firstClose.sequence,
    performance.now() + 10_000);
  if (closed?.event.type !== 'computer.turn_closed') return undefined;
  return closed;
}

function validateReportContextClass(report: z.infer<typeof reportSchema>,
  created: ReturnType<typeof agentSessionData>) {
  const sharedChild = 'contextKind' in created && created.contextKind === 'shared_child';
  const sharingClass = 'sharingClass' in report ? report.sharingClass : undefined;
  if (report.type !== 'agent.turn_started') {
    if (sharingClass !== undefined) throw new ReportRejected('Context class is only valid on a turn start');
    return;
  }
  if (sharingClass !== (sharedChild ? 'shared_only' : undefined)
    || (sharedChild && report.executionMode !== 'restricted')) {
    throw new ReportRejected('Turn context class mismatch');
  }
}
function reportData(report: z.infer<typeof reportSchema>, silo: string, assistantId: string, keys: ReturnType<typeof conversationKeys>) {
  const common = { conversationId: report.conversationId, turnId: report.turnId };
  if (report.type === 'agent.native_request_refused') {
    return { ...common, nativeRequestId: report.nativeRequestId,
      requestKind: report.requestKind, outcome: report.outcome };
  } else if (report.type === 'agent.native_consent_refused') {
    return { ...common, nativeRequestId: report.nativeRequestId, serverName: report.serverName,
      serverId: report.serverId, reason: report.reason };
  } else if (report.type === 'agent.tool_call_started') {
    return { ...common, callId: report.callId, serverId: report.serverId,
      toolName: report.toolName };
  } else if (report.type === 'agent.tool_call_finished') {
    return { ...common, callId: report.callId, serverId: report.serverId,
      toolName: report.toolName, status: report.status, durationMs: report.durationMs };
  } else if (report.type === 'agent.command_ran') {
    return { ...common, commandDigest: z.string().parse(report.commandDigest),
      exitCode: z.number().parse(report.exitCode) };
  } else if (report.type === 'agent.reasoning_summarised') {
    return { ...common, ...keys.encrypt(silo, report.conversationId, z.string().parse(report.text)) };
  } else if (report.type === 'agent.turn_started') {
    const data: typeof common & { assistantId: string; threadId?: string;
      executionMode?: 'restricted' | 'memory_free'; sharingClass?: 'shared_only' } = {
      ...common, assistantId,
    };
    if (report.threadId) data.threadId = report.threadId;
    if (report.executionMode) data.executionMode = report.executionMode;
    if (report.sharingClass) data.sharingClass = report.sharingClass;
    return data;
  } else if (report.type === 'agent.turn_failed') {
    return { ...common, reason: report.reason ?? 'bridge_interrupted' };
  } else if (report.type === 'agent.turn_completed' || report.type === 'agent.output_lost') {
    return common;
  } else {
    return { ...common, messageId: z.string().parse(report.messageId), contentType: 'text',
      ...keys.encrypt(silo, report.conversationId, z.string().parse(report.text)) };
  }
}

function isLostOutputReplay(previous: StoredEvent, report: z.infer<typeof reportSchema>) {
  if (report.type !== 'agent.output_lost') return false;
  const data = z.object({ turnId: z.string().optional() }).parse(previous.event.data);
  return data.turnId === report.turnId && ['agent.message_delta', 'agent.message_completed',
    'agent.reasoning_summarised', 'agent.output_lost'].includes(previous.event.type);
}

function verifyDigest(row: StoredEvent | undefined, digest: string, expectedId?: string) {
  if (expectedId !== undefined && row?.event.id !== expectedId) {
    throw new ReportRejected('Report sequence reused');
  }
  if (row?.event.report?.digest !== digest) throw new ReportRejected('Report sequence reused');
}
export function agentSession(rows: StoredEvent[]) {
  function isCreated(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  return agentSessionData(rows.find(isCreated)?.event.data);
}

export function agentSessionData(data: unknown) {
  const created = conversationCreatedDataSchema.parse(data);
  if (created.mode !== 'agent_session') throw new ReportRejected('Human conversation');
  return created;
}

function verifyReportReplay(previous: StoredEvent, report: z.infer<typeof reportSchema>, digest: string) {
  if (isLostOutputReplay(previous, report)) return;
  const receipt = previous.event.report;
  if (receipt?.sequence === report.sequence) {
    verifyDigest(previous, digest);
    return;
  }
  function matchesSequence(saved: { sequence: number }) {
    return saved.sequence === report.sequence;
  }
  const saved = receipt?.preceding?.find(matchesSequence);
  if (saved?.digest !== digest) throw new ReportRejected('Report sequence reused');
}

function receiptFor(report: Report) {
  return { sequence: report.sequence, digest: reportDigest(report) };
}
