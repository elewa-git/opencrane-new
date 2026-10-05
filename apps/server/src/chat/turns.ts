import type { Binding } from '@opencrane/authz';
import { authorityFence, history, payingGroupAuthority } from '@opencrane/models';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { chatHistory } from './commands.ts';
import { creationEvent } from './private-session.ts';
import { ReportRejected } from './reports.ts';

const binding = z.object({
  conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(),
  requesterId: z.string(), task: z.literal('chat_turn'), payingGroupId: z.string().optional(),
});
type TurnBinding = z.infer<typeof binding>;
type TurnInput = {
  conversationId: string; turnId: string; threadId?: string | undefined;
  status: 'started' | 'completed' | 'failed'; replay?: boolean;
};
type TurnContext = {
  silo: string; computerId: string; assistantId: string; binding?: Binding;
};
type WriteAuthority = Awaited<ReturnType<typeof authorityFence>>;

/** Append one lifecycle event. Reports cannot reopen a closed turn. */
export async function turnCommand(store: EventStore, context: TurnContext, input: TurnInput) {
  const subjects = [`computer-${context.assistantId}`, `assistant-${context.assistantId}`,
    `conversation-${input.conversationId}`];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const rows = await chatHistory(store, context.silo, input.conversationId, fresh.deadline);
  const requesterId = requestedTurn(rows, context.assistantId, input.turnId);
  const subject = `computer-${context.assistantId}`;
  const events = await computerHistory(store, subject, context.silo, fresh.deadline);
  const data = decideTurn(events, rows, input, context.computerId, requesterId);
  if (!data) return;
  fresh.include(`member-${data.requesterId}`);
  requireThreadOwner(events, data);
  if (newAdmission(input.status, events, input.turnId)) {
    data.payingGroupId = await payingGroup(store, context, rows, data.requesterId, fresh);
  }
  const type = input.status === 'started' ? 'computer.turn_started' : 'computer.turn_closed';
  const hash = createHash('sha256');
  hash.update(`${context.computerId}:${input.turnId}:${type}`);
  const id = hash.digest('hex');
  const eventData: TurnBinding & {
    assistantId: string; computerId: string; status?: 'completed' | 'failed';
  } = { ...data, assistantId: context.assistantId, computerId: context.computerId };
  const event = {
    id, commandId: id, type, subject, silo: context.silo,
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'turn-lifecycle' },
    time: new Date().toISOString(), data: eventData,
  };
  if (input.status !== 'started') {
    eventData.status = input.status;
  }
  await fresh();
  const result = await store.append({ expectedSequence: events.at(-1)?.sequence ?? 0, event });
  if (result.status !== 'appended') throw new Error('Turn append conflict or unavailable');
  const committed = await computerHistory(store, subject, context.silo, fresh.deadline);
  function isSaved(row: StoredEvent) {
    return row.event.id === id;
  }
  verifyBinding(committed.find(isSaved), data);
  if (input.status === 'started') return { ...data, threadId: z.string().parse(data.threadId) };
  return undefined;
}

async function computerHistory(store: EventStore, subject: string, silo: string, deadline: number) {
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== silo) throw new ReportRejected('Computer silo mismatch');
    rows.push(row);
  }
  return rows;
}

function isConversationCreated(row: StoredEvent) {
  return row.event.type === 'conversation.created';
}
function requestedTurn(rows: StoredEvent[], assistantId: string, turnId: string) {
  const creation = rows.find(isConversationCreated);
  const created = z.object({ assistantId: z.string() }).parse(creation?.event.data);
  function isRequestedMessage(row: StoredEvent) {
    return row.event.id === turnId && row.event.type === 'message.posted';
  }
  const message = rows.find(isRequestedMessage);
  if (created.assistantId !== assistantId || !message) throw new ReportRejected('Unrequested turn');
  return z.object({ authorId: z.string() }).parse(message.event.data).authorId;
}
function isComputerLifecycle(row: StoredEvent) {
  return !row.event.type.startsWith('computer.turn_');
}
function reportedClosed(rows: StoredEvent[], turnId: string) {
  function isClosedReport(row: StoredEvent) {
    if (!['agent.turn_completed', 'agent.turn_failed'].includes(row.event.type)) return false;
    return z.object({ turnId: z.string() }).parse(row.event.data).turnId === turnId;
  }
  return rows.some(isClosedReport);
}
function checkStart(events: StoredEvent[], rows: StoredEvent[], computerId: string, turnId: string) {
  const current = events.findLast(isComputerLifecycle);
  const computer = z.object({ computerId: z.string() });
  if (current?.event.type !== 'computer.ready' ||
      computer.parse(current.event.data).computerId !== computerId) {
    throw new Error('Computer is not ready');
  }
  if (reportedClosed(rows, turnId)) throw new ReportRejected('Turn is closed');
}
function isClosedTurn(row: StoredEvent) {
  return row.event.type === 'computer.turn_closed';
}
function isStartedTurn(row: StoredEvent) {
  return row.event.type === 'computer.turn_started';
}
function decideTurn(events: StoredEvent[], rows: StoredEvent[], input: TurnInput,
  computerId: string, requesterId: string) {
  function isMatchingTurn(row: StoredEvent) {
    return row.event.type.startsWith('computer.turn_') &&
      binding.parse(row.event.data).turnId === input.turnId;
  }
  const turns = events.filter(isMatchingTurn);
  const closed = turns.find(isClosedTurn);
  const recoveringClosed = input.replay && input.status === 'started' &&
    reportedClosed(rows, input.turnId);
  // Accept a verified duplicate without admitting a new turn after its final report.
  if (closed || recoveringClosed) {
    if (input.status === 'started' && !input.replay) throw new ReportRejected('Turn is closed');
    return;
  }
  const started = turns.find(isStartedTurn);
  let data: TurnBinding;
  if (started) {
    data = binding.parse(started.event.data);
  } else {
    data = binding.parse({ ...input, requesterId, task: 'chat_turn' });
  }
  if (input.status === 'started') {
    if (!input.threadId || input.threadId !== data.threadId) {
      throw new ReportRejected('Thread mismatch');
    }
    if (started) return data;
    checkStart(events, rows, computerId, input.turnId);
  }
  return data;
}
function verifyBinding(saved: StoredEvent | undefined, expected: TurnBinding) {
  const stored = saved && binding.parse(saved.event.data);
  if (!saved || JSON.stringify(stored) !== JSON.stringify(expected)) {
    throw new ReportRejected('Turn binding conflict');
  }
}

async function payingGroup(store: EventStore, context: TurnContext,
  conversation: StoredEvent[], requesterId: string, fresh: WriteAuthority) {
  const assistant = await creationEvent(store, context.silo,
    `assistant-${context.assistantId}`, 'assistant.created', fresh.deadline);
  const details = z.object({ kind: z.enum(['personal', 'team']), ownerId: z.string(),
    payingGroupId: z.string().optional() }).parse(assistant.data);
  if (details.kind === 'team') {
    if (!context.binding) throw new ReportRejected('IAM binding required for a new team turn');
    const group = sessionPayer(conversation, requesterId, details.payingGroupId);
    fresh.include(`team-${group}`, `team-${details.ownerId}`);
    for (const groupId of new Set([group, details.ownerId])) {
      const groupAuthority = await payingGroupAuthority(store, context.silo, requesterId,
        groupId, context.binding, fresh.deadline);
      await groupAuthority();
    }
    return group;
  }
  return personalPayer(store, context.silo, fresh.deadline);
}
function sessionPayer(conversation: StoredEvent[], requesterId: string,
  assistantPayer: string | undefined) {
  const creation = conversation.find(isConversationCreated);
  const created = z.object({ createdBy: z.string(), payingGroupId: z.string().optional() })
    .parse(creation?.event.data);
  if (created.createdBy !== requesterId) throw new ReportRejected('Private requester mismatch');
  const group = created.payingGroupId;
  if (!group) throw new ReportRejected('Paying group unavailable for shared work');
  if (assistantPayer && group !== assistantPayer) {
    throw new ReportRejected('Paying group does not match the assistant');
  }
  return group;
}
function isBudgetCeiling(row: StoredEvent) {
  return row.event.type === 'budget.ceiling_set';
}
async function personalPayer(store: EventStore, silo: string, deadline: number) {
  const budgets = await history(store, `budget-${silo}`, silo, deadline);
  const ceilings = budgets.filter(isBudgetCeiling);
  for (const row of ceilings.reverse()) {
    const data = z.object({ scope: z.string(), defaultPayingGroupId: z.string().optional() })
      .parse(row.event.data);
    if (data.scope === 'global' && data.defaultPayingGroupId) return data.defaultPayingGroupId;
  }
  throw new ReportRejected('Paying group unavailable; configure the installation default');
}
function newAdmission(status: string, events: StoredEvent[], turnId: string) {
  function isPreviousStart(row: StoredEvent) {
    return row.event.type === 'computer.turn_started' &&
      binding.parse(row.event.data).turnId === turnId;
  }
  return status === 'started' && !events.some(isPreviousStart);
}
function requireThreadOwner(events: StoredEvent[], input: TurnBinding) {
  for (const row of events) {
    if (row.event.type !== 'computer.turn_started') continue;
    const previous = binding.parse(row.event.data);
    if (previous.threadId !== input.threadId) continue;
    if (previous.requesterId !== input.requesterId ||
        previous.conversationId !== input.conversationId) {
      throw new ReportRejected('Thread belongs to another requester or conversation');
    }
  }
}
