import { conversationCreatedDataSchema } from '@opencrane/events';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { chatHistory } from './commands.ts';
import type { conversationKeys } from './keys.ts';

// Permanent refusals need operator attention; reconnecting cannot repair them.
export class ReportRejected extends Error {}

const reportSchema = z.object({ sequence: z.int().positive(), previousSequence: z.int().nonnegative().optional(), conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string(), assistantId: z.string(), requesterId: z.string().optional(), threadId: z.string().optional(), messageId: z.string().optional(), text: z.string().max(128_000).optional(),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), exitCode: z.int().optional(),
  executionMode: z.enum(['restricted', 'memory_free']).optional(),
  reason: z.enum(['bridge_interrupted', 'restricted_tool_refused']).optional(),
  type: z.enum(['agent.output_lost', 'agent.command_ran', 'agent.reasoning_summarised', 'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed', 'agent.message_delta', 'agent.message_completed']),
}).strict();
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
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const rows = await chatHistory(store, context.silo, report.conversationId);
  const created = agentSession(rows);
  if (created.assistantId !== context.assistantId || !rows.some(r => r.event.type === 'message.posted' && r.event.id === report.turnId)) throw new ReportRejected('Unrequested report');
  if (report.requesterId) {
    const message = rows.find(row => row.event.id === report.turnId);
    const author = z.object({ authorId: z.string() }).parse(message?.event.data);
    if (author.authorId !== report.requesterId) throw new ReportRejected('Requester mismatch');
  }
  const previous = rows.find(r => r.event.report?.computerId === context.computerId && r.event.report.sequence === report.sequence);
  if (previous) {
    verifyReportReplay(previous, report, digest);
    return 'duplicate' as const;
  }
  if (report.previousSequence === undefined
    ? report.sequence - 1 !== await reportPosition(store, context.silo, context.computerId)
    : report.previousSequence !== lastReportSequence(rows, context.computerId)) throw new ReportRejected('Report sequence gap');
  const data = reportData(report, context.silo, context.assistantId, keys);
  const id = `bridge-${createHash('sha256').update(`${context.computerId}:${report.sequence}`).digest('hex')}`;
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
    id, commandId: id, type: report.type, silo: context.silo, subject: `conversation-${report.conversationId}`,
    source: 'computer-bridge', principal: { kind: 'agent', id: context.assistantId }, time: new Date().toISOString(),
    report: { computerId: context.computerId, sequence: report.sequence, digest }, data,
  } });
  if (result.status === 'rejected') throw new ReportRejected('Report append rejected');
  if (result.status !== 'appended') throw new Error('Report append unavailable');
  const committed = (await chatHistory(store, context.silo, report.conversationId)).find(row => row.event.id === id);
  verifyDigest(committed, digest);
  return 'recorded' as const;
}
function reportData(report: z.infer<typeof reportSchema>, silo: string, assistantId: string, keys: ReturnType<typeof conversationKeys>) {
  const common = { conversationId: report.conversationId, turnId: report.turnId };
  if (report.type === 'agent.command_ran') {
    return { ...common, commandDigest: z.string().parse(report.commandDigest),
      exitCode: z.number().parse(report.exitCode) };
  } else if (report.type === 'agent.reasoning_summarised') {
    return { ...common, ...keys.encrypt(silo, report.conversationId, z.string().parse(report.text)) };
  } else if (report.type === 'agent.turn_started') {
    const data: typeof common & { assistantId: string; threadId?: string;
      executionMode?: 'restricted' | 'memory_free' } = { ...common, assistantId };
    if (report.threadId) data.threadId = report.threadId;
    if (report.executionMode) data.executionMode = report.executionMode;
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
function lastReportSequence(rows: StoredEvent[], computerId: string) {
  return rows.findLast(r => r.event.report?.computerId === computerId)?.event.report?.sequence ?? 0;
}

export function agentSession(rows: StoredEvent[]) {
  function isCreated(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  const created = conversationCreatedDataSchema.parse(rows.find(isCreated)?.event.data);
  if (created.mode !== 'agent_session') throw new ReportRejected('Human conversation');
  return created;
}

function verifyReportReplay(previous: StoredEvent, report: z.infer<typeof reportSchema>, digest: string) {
  if (!isLostOutputReplay(previous, report)) verifyDigest(previous, digest);
}
