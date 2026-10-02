import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { chatHistory } from './commands.ts';
import type { conversationKeys } from './keys.ts';

const reportSchema = z.object({ sequence: z.int().positive(), conversationId: z.string().regex(/^[\w-]{1,200}$/u),
  turnId: z.string(), assistantId: z.string(), threadId: z.string().optional(), messageId: z.string().optional(), text: z.string().max(128_000).optional(),
  commandDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), exitCode: z.int().optional(),
  type: z.enum(['agent.command_ran', 'agent.reasoning_summarised', 'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed', 'agent.message_delta', 'agent.message_completed']),
}).strict();
export async function reportPosition(store: EventStore, silo: string, computerId: string) {
  let position = 0;
  for await (const { event } of readEvents(store, 1, await store.head())) {
    if (event.silo === silo && event.report?.computerId === computerId) {
      if (event.report.sequence !== position + 1) throw new Error('Stored report sequence gap');
      position = event.report.sequence;
    }
  }
  return position;
}
export async function recordReport(store: EventStore, keys: ReturnType<typeof conversationKeys>, context: { silo: string; computerId: string; assistantId: string }, value: unknown) {
  const report = reportSchema.parse(value);
  if (report.assistantId !== context.assistantId) throw new Error('Assistant mismatch');
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  const rows = await chatHistory(store, context.silo, report.conversationId);
  const created = z.object({ assistantId: z.string() }).parse(rows.find(r => r.event.type === 'conversation.created')?.event.data);
  if (created.assistantId !== context.assistantId || !rows.some(r => r.event.type === 'message.posted' && r.event.id === report.turnId)) throw new Error('Unrequested report');
  const previous = rows.find(r => r.event.report?.computerId === context.computerId && r.event.report.sequence === report.sequence);
  if (previous) { if (previous.event.report?.digest !== digest) throw new Error('Report sequence reused'); return; }
  if (report.sequence !== await reportPosition(store, context.silo, context.computerId) + 1) throw new Error('Report sequence gap');
  const data = reportData(report, context.silo, context.assistantId, keys);
  const id = `bridge-${createHash('sha256').update(`${context.computerId}:${report.sequence}`).digest('hex')}`;
  const result = await store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
    id, commandId: id, type: report.type, silo: context.silo, subject: `conversation-${report.conversationId}`,
    source: 'computer-bridge', principal: { kind: 'agent', id: context.assistantId }, time: new Date().toISOString(),
    report: { computerId: context.computerId, sequence: report.sequence, digest }, data,
  } });
  if (result.status !== 'appended') throw new Error('Report append unavailable');
}
function reportData(report: z.infer<typeof reportSchema>, silo: string, assistantId: string, keys: ReturnType<typeof conversationKeys>) {
  const common = { conversationId: report.conversationId, turnId: report.turnId };
  const data = report.type === 'agent.command_ran' ? { ...common, commandDigest: z.string().parse(report.commandDigest), exitCode: z.number().parse(report.exitCode) }
    : report.type === 'agent.reasoning_summarised' ? { ...common, ...keys.encrypt(silo, report.conversationId, z.string().parse(report.text)) }
    : report.type === 'agent.turn_started' ? { ...common, assistantId: assistantId }
    : report.type === 'agent.turn_failed' ? { ...common, reason: 'bridge_interrupted' }
    : report.type === 'agent.turn_completed' ? common
    : { ...common, messageId: z.string().parse(report.messageId), contentType: 'text', ...keys.encrypt(silo, report.conversationId, z.string().parse(report.text)) };
  return data;
}
