import { history, payingGroupAuthority } from '@opencrane/models';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computerWorkPaused } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { chatHistory } from './commands.ts';
import { ReportRejected } from './reports.ts';

const binding = z.object({ conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(), requesterId: z.string(), task: z.literal('chat_turn'), payingGroupId: z.string().optional() });
/** Each lifecycle command makes one conditional append. Reports cannot reopen a closed turn. */
export async function turnCommand(store: EventStore, context: { silo: string; computerId: string; assistantId: string },
  input: { conversationId: string; turnId: string; threadId?: string | undefined; status: 'started' | 'completed' | 'failed'; replay?: boolean }) {
  const rows = await chatHistory(store, context.silo, input.conversationId);
  const created = z.object({ assistantId: z.string() }).parse(rows.find(r => r.event.type === 'conversation.created')?.event.data);
  const message = rows.find(r => r.event.id === input.turnId && r.event.type === 'message.posted');
  if (created.assistantId !== context.assistantId || !message) throw new ReportRejected('Unrequested turn');
  const events = [];
  for await (const row of store.readStream(`computer-${context.assistantId}`)) {
    if (row.event.silo !== context.silo) throw new ReportRejected('Computer silo mismatch');
    events.push(row);
  }
  const data = decideTurn(events, rows, input, context.computerId, z.object({ authorId: z.string() }).parse(message.event.data).authorId);
  if (!data) return;
  if (newAdmission(input.status, events, input.turnId)) {
    data.payingGroupId = await payingGroup(store, context.silo, context.assistantId, rows, data.requesterId);
  }
  const type = input.status === 'started' ? 'computer.turn_started' : 'computer.turn_closed';
  const id = createHash('sha256').update(`${context.computerId}:${input.turnId}:${type}`).digest('hex');
  const eventData = { ...data, assistantId: context.assistantId, computerId: context.computerId, ...(input.status === 'started' ? {} : { status: input.status }) };
  const result = await store.append({ expectedSequence: events.at(-1)?.sequence ?? 0, event: {
    id, commandId: id, type, subject: `computer-${context.assistantId}`, silo: context.silo,
    source: 'opencrane-server', principal: { kind: 'system', id: 'turn-lifecycle' }, time: new Date().toISOString(),
    data: eventData,
  } });
  if (result.status !== 'appended') throw new Error('Turn append conflict or unavailable');
  const committed = [];
  for await (const row of store.readStream(`computer-${context.assistantId}`)) committed.push(row);
  const saved = committed.find(r => r.event.id === id);
  verifyBinding(saved, data);
  return input.status === 'started' ? { ...data, threadId: z.string().parse(data.threadId) } : undefined;
}

function checkStart(events: StoredEvent[], rows: StoredEvent[], computerId: string, turnId: string) {
  if (computerWorkPaused(events.map(r => r.event))) throw new Error('Computer paused');
  const current = events.findLast(r => !r.event.type.startsWith('computer.turn_') && !r.event.type.startsWith('takeover.'));
  if (current?.event.type !== 'computer.ready' || z.object({ computerId: z.string() }).parse(current.event.data).computerId !== computerId) throw new Error('Computer is not ready');
  if (rows.some(r => ['agent.turn_completed', 'agent.turn_failed'].includes(r.event.type) && z.object({ turnId: z.string() }).parse(r.event.data).turnId === turnId)) throw new ReportRejected('Turn is closed');
}

function closedTurn(status: string, replay = false) {
  if (status === 'started' && !replay) throw new ReportRejected('Turn is closed');
}

function decideTurn(events: StoredEvent[], rows: StoredEvent[], input: { conversationId: string; turnId: string; threadId?: string | undefined; status: string; replay?: boolean }, computerId: string, requesterId: string) {
  const turns = events.filter(r => r.event.type.startsWith('computer.turn_') && binding.parse(r.event.data).turnId === input.turnId);
  const closed = turns.find(r => r.event.type === 'computer.turn_closed');
  // A verified duplicate needs no new admission, even after terminal report recovery.
  if (closed || (input.replay && input.status === 'started' && rows.some(r => ['agent.turn_completed', 'agent.turn_failed'].includes(r.event.type) && binding.pick({ turnId: true }).parse(r.event.data).turnId === input.turnId))) return closedTurn(input.status, input.replay);
  const started = turns.find(r => r.event.type === 'computer.turn_started');
  const data = started ? binding.parse(started.event.data) : binding.parse({ ...input,
    requesterId, task: 'chat_turn' });
  if (input.status === 'started') {
    if (!input.threadId || input.threadId !== data.threadId) throw new ReportRejected('Thread mismatch');
    if (started) return data;
    checkStart(events, rows, computerId, input.turnId);
  }
  return data;
}

function verifyBinding(saved: StoredEvent | undefined, expected: z.infer<typeof binding>) {
  if (!saved || JSON.stringify(binding.parse(saved.event.data)) !== JSON.stringify(expected)) throw new ReportRejected('Turn binding conflict');
}

async function payingGroup(store: EventStore, silo: string, assistantId: string, conversation: StoredEvent[], requesterId: string) {
  const assistant = (await history(store, `assistant-${assistantId}`, silo)).find(r => r.event.type === 'assistant.created');
  const kind = z.object({ kind: z.enum(['personal', 'team']) }).parse(assistant?.event.data).kind;
  if (kind === 'team') {
    const group = z.object({ payingGroupId: z.string().optional() }).parse(conversation.find(r => r.event.type === 'conversation.created')?.event.data).payingGroupId;
    if (!group) throw new ReportRejected('Paying group unavailable for shared work');
    const fresh = await payingGroupAuthority(store, silo, requesterId, group);
    await fresh();
    return group;
  }
  const ceilings = (await history(store, `budget-${silo}`, silo)).filter(r => r.event.type === 'budget.ceiling_set');
  for (const row of ceilings.reverse()) {
    const d = z.object({ scope: z.string(), defaultPayingGroupId: z.string().optional() }).parse(row.event.data);
    if (d.scope === 'global' && d.defaultPayingGroupId) return d.defaultPayingGroupId;
  }
  throw new ReportRejected('Paying group unavailable; configure the installation default');
}

function newAdmission(status: string, events: StoredEvent[], turnId: string) {
  return status === 'started' && !events.some(r => r.event.type === 'computer.turn_started' && binding.parse(r.event.data).turnId === turnId);
}
