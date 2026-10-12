import {
  conversationCreatedDataSchema, agentToolCallStartedDataSchema, agentToolCallFinishedDataSchema,
  agentNativeConsentRefusedDataSchema,
} from '@opencrane/events';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readEventAt, readStreamSummary, type AppendCommand, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { readChatFacts } from './chat-summary.ts';
import type { conversationKeys } from './keys.ts';

// Permanent refusals need operator attention; reconnecting cannot repair them.
export class ReportRejected extends Error {}

const existingReportSchema = z.object({ sequence: z.int().positive(), previousSequence: z.int().nonnegative().optional(), conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string(), assistantId: z.string(), requesterId: z.string().optional(), threadId: z.string().optional(), messageId: z.string().optional(), text: z.string().max(128_000).optional(),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), exitCode: z.int().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(),
  contextClass: z.literal('shared_only').optional(),
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
const reportSchema = z.union([
  nativeConsentReportSchema,
  existingReportSchema, toolStartedReportSchema, toolFinishedReportSchema,
]);
export async function reportPosition(store: EventStore, silo: string, computerId: string) {
  const sequences = new Set<number>();
  for await (const { event } of readEvents(store, 1, await store.head())) {
    if (event.silo === silo && event.report?.computerId === computerId) sequences.add(event.report.sequence);
  }
  let position = 0;
  while (sequences.has(position + 1)) position++;
  return position;
}
export async function recordReport(store: EventStore, keys: ReturnType<typeof conversationKeys>, context: { silo: string; computerId: string; assistantId: string }, value: unknown) {
  const report = reportSchema.parse(value);
  if (report.assistantId !== context.assistantId) throw new ReportRejected('Assistant mismatch');
  const digestHash = createHash('sha256');
  digestHash.update(JSON.stringify(report));
  const digest = digestHash.digest('hex');
  const facts = await readChatFacts(store, context.silo, report.conversationId,
    report.turnId, context.computerId, report.sequence);
  const created = agentSessionData(facts.created);
  if (created.assistantId !== context.assistantId || !facts.message) {
    throw new ReportRejected('Unrequested report');
  }
  validateReportContextClass(report, created);
  if (report.requesterId) {
    const author = z.object({ authorId: z.string() }).parse(facts.message);
    if (author.authorId !== report.requesterId) throw new ReportRejected('Requester mismatch');
  }
  const subject = `conversation-${report.conversationId}`;
  if (facts.reportPosition !== undefined) {
    const previous = await readEventAt(store, subject, facts.reportPosition,
      performance.now() + 10_000);
    if (previous) {
      verifyReportReplay(previous, report, digest);
    } else {
      verifyDigest(undefined, digest);
    }
    return 'duplicate' as const;
  }
  if ('contextKind' in created && created.contextKind === 'shared_child'
    && report.type !== 'agent.turn_started') {
    await requireSharedReportTurn(store, context, report, facts.message.authorId);
  }
  let previousSequence = facts.lastReportSequence;
  let expectedPrevious = report.previousSequence;
  if (expectedPrevious === undefined) {
    previousSequence = await reportPosition(store, context.silo, context.computerId);
    expectedPrevious = report.sequence - 1;
  }
  if (expectedPrevious !== previousSequence) throw new ReportRejected('Report sequence gap');
  const data = reportData(report, context.silo, context.assistantId, keys);
  const commandHash = createHash('sha256');
  commandHash.update(`${context.computerId}:${report.sequence}`);
  const id = `bridge-${commandHash.digest('hex')}`;
  const event = {
    id, commandId: id, type: report.type, silo: context.silo, subject,
    source: 'computer-bridge', principal: { kind: 'agent' as const, id: context.assistantId },
    time: new Date().toISOString(),
    report: { computerId: context.computerId, sequence: report.sequence, digest }, data,
  };
  const command: AppendCommand = { expectedSequence: facts.sequence, historyChecked: true, event };
  const result = await store.append(command);
  if (result.status === 'rejected') throw new ReportRejected('Report append rejected');
  if (result.status !== 'appended') throw new Error('Report append unavailable');
  const committed = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
  let saved: StoredEvent | undefined;
  if (committed?.event.id === id) saved = committed;
  verifyDigest(saved, digest);
  return 'recorded' as const;
}

async function requireSharedReportTurn(store: EventStore,
  context: { silo: string; assistantId: string; computerId: string },
  report: z.infer<typeof reportSchema>, requesterId: unknown) {
  function take(summary: ComputerSummary) {
    return summary.turns.get(report.turnId)?.firstStart;
  }
  // Check saved admission before encrypting output. A computer's claim is not proof.
  const start = await readStreamSummary(store, context.silo, `computer-${context.assistantId}`,
    computerSummary, performance.now() + 10_000, take);
  if (!start || start.event.source !== 'opencrane-server') {
    throw new ReportRejected('Shared report has no admitted turn');
  }
  const saved = z.record(z.string(), z.unknown()).parse(start.event.data);
  const threadId = 'threadId' in report ? report.threadId : undefined;
  if (saved['contextClass'] !== 'shared_only' || saved['executionMode'] !== 'restricted'
    || saved['computerId'] !== context.computerId || saved['assistantId'] !== context.assistantId
    || saved['conversationId'] !== report.conversationId || saved['turnId'] !== report.turnId
    || saved['requesterId'] !== requesterId || saved['threadId'] !== threadId) {
    throw new ReportRejected('Shared report turn mismatch');
  }
}

function validateReportContextClass(report: z.infer<typeof reportSchema>,
  created: ReturnType<typeof agentSessionData>) {
  const sharedChild = 'contextKind' in created && created.contextKind === 'shared_child';
  const contextClass = 'contextClass' in report ? report.contextClass : undefined;
  if (report.type !== 'agent.turn_started') {
    if (contextClass !== undefined) throw new ReportRejected('Context class is only valid on a turn start');
    return;
  }
  if (contextClass !== (sharedChild ? 'shared_only' : undefined)
    || (sharedChild && report.executionMode !== 'restricted')) {
    throw new ReportRejected('Turn context class mismatch');
  }
}
function reportData(report: z.infer<typeof reportSchema>, silo: string, assistantId: string, keys: ReturnType<typeof conversationKeys>) {
  const common = { conversationId: report.conversationId, turnId: report.turnId };
  if (report.type === 'agent.native_consent_refused') {
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
      executionMode?: 'restricted' | 'memory_free'; contextClass?: 'shared_only' } = {
      ...common, assistantId,
    };
    if (report.threadId) data.threadId = report.threadId;
    if (report.executionMode) data.executionMode = report.executionMode;
    if (report.contextClass) data.contextClass = report.contextClass;
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

function verifyDigest(row: StoredEvent | undefined, digest: string) {
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
  if (!isLostOutputReplay(previous, report)) verifyDigest(previous, digest);
}
