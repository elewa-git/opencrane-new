import type { Binding } from '@opencrane/authz';
import { authorityFence, history, groupMembership, PayingGroupRefused, MemberAccessRefused,
  activeMember } from '@opencrane/models';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { chatHistory } from './commands.ts';
import { creationEvent } from './private-session.ts';
import { agentSession, ReportRejected } from './reports.ts';

const binding = z.object({
  conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(),
  requesterId: z.string(), task: z.literal('chat_turn'), payingGroupId: z.string().optional(),
});
const closedTurnDetails = z.object({ status: z.enum(['completed', 'failed']) });
const assistantDetails = z.object({
  kind: z.enum(['personal', 'team']), ownerId: z.string(),
  payingGroupId: z.string().optional(),
});
const sessionDetails = z.object({
  createdBy: z.string(), payingGroupId: z.string().optional(),
});
const budgetDetails = z.object({
  scope: z.string(), defaultPayingGroupId: z.string().optional(),
});

type TurnBinding = z.infer<typeof binding>;
export type ExecutionMode = 'restricted' | 'memory_free';
export function requiredExecutionMode(assistantKind: string, requested: unknown): ExecutionMode {
  if (assistantKind !== 'team' || requested === 'memory_free') return 'memory_free';
  return 'restricted';
}

type TurnInput = {
  executionMode?: ExecutionMode | undefined;
  conversationId: string; turnId: string; threadId?: string | undefined;
  status: 'started' | 'completed' | 'failed'; replay?: boolean;
};
type TurnContext = {
  silo: string; computerId: string; assistantId: string; binding?: Binding;
};
export class TurnAdmissionRejected extends ReportRejected {}

type WriteAuthority = Awaited<ReturnType<typeof authorityFence>>;

/** Append one lifecycle event. Reports cannot reopen a closed turn. */
export async function turnCommand(store: EventStore, context: TurnContext, input: TurnInput) {
  const rows = await chatHistory(store, context.silo, input.conversationId);
  const requested = requestedTurn(rows, context.assistantId, input.turnId);
  const subject = `computer-${context.assistantId}`;
  const events = await computerHistory(store, subject, context.silo, performance.now() + 10_000);
  const data = decideTurn(events, rows, input, context.computerId, requested.requesterId);
  if (!data) return;
  let fresh: WriteAuthority | undefined;
  let status = input.status;
  let refusal: TurnAdmissionRejected | undefined;
  requireThreadOwner(events, data);
  let executionMode = storedExecutionMode(events, input.turnId);
  if (newAdmission(input.status, events, input.turnId)) {
    try {
      executionMode = input.executionMode ?? 'memory_free';
      const admission = await admitTurn(store, context, rows, events, data, requested.executionMode, executionMode);
      data.payingGroupId = admission.payer;
      fresh = admission.fresh;
    } catch (error) {
      if (!isFinalAdmissionRefusal(error)) throw error;
      refusal = new TurnAdmissionRejected(error.message, { cause: error });
      status = 'failed';
    }
  }
  const type = status === 'started' ? 'computer.turn_started' : 'computer.turn_closed';
  const hash = createHash('sha256');
  hash.update(`${context.computerId}:${input.turnId}:${type}`);
  const id = hash.digest('hex');
  const eventData: TurnBinding & {
    assistantId: string; computerId: string; status?: 'completed' | 'failed';
    executionMode?: ExecutionMode;
  } = { ...data, assistantId: context.assistantId, computerId: context.computerId };
  const event = {
    id, commandId: id, type, subject, silo: context.silo,
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'turn-lifecycle' },
    time: new Date().toISOString(), data: eventData,
  };
  addLifecycleDetails(eventData, status, executionMode);
  await fresh?.();
  const result = await store.append({ expectedSequence: events.at(-1)?.sequence ?? 0, event });
  if (result.status !== 'appended') throw new Error('Turn append conflict or unavailable');
  const committed = await computerHistory(store, subject, context.silo, performance.now() + 10_000);
  function isSaved(row: StoredEvent) {
    return row.event.id === id;
  }
  verifyBinding(committed.find(isSaved), data);
  if (refusal) throw refusal;
  if (input.status === 'started') return { ...data, threadId: z.string().parse(data.threadId),
    executionMode: executionMode ?? 'memory_free' };
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
  const created = agentSession(rows);
  function isRequestedMessage(row: StoredEvent) {
    return row.event.id === turnId && row.event.type === 'message.posted';
  }
  const message = rows.find(isRequestedMessage);
  if (created.assistantId !== assistantId || !message) throw new ReportRejected('Unrequested turn');
  const details = z.object({ authorId: z.string(), executionMode: z.literal('memory_free').optional() })
    .parse(message.event.data);
  return { requesterId: details.authorId, executionMode: details.executionMode };
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
function isRefusedAdmission(closed: StoredEvent | undefined, started: StoredEvent | undefined,
  rows: StoredEvent[], input: TurnInput) {
  if (!closed || started || input.status !== 'started') {
    return false;
  }
  const status = closedTurnDetails.parse(closed.event.data).status;
  return status === 'failed' && !reportedClosed(rows, input.turnId);
}

function decideTurn(events: StoredEvent[], rows: StoredEvent[], input: TurnInput,
  computerId: string, requesterId: string) {
  function isMatchingTurn(row: StoredEvent) {
    return row.event.type.startsWith('computer.turn_') &&
      binding.parse(row.event.data).turnId === input.turnId;
  }
  const turns = events.filter(isMatchingTurn);
  const closed = turns.find(isClosedTurn);
  const started = turns.find(isStartedTurn);
  if (isRefusedAdmission(closed, started, rows, input)) {
    throw new TurnAdmissionRejected('Turn admission was refused');
  }
  const recoveringClosed = input.replay && input.status === 'started' &&
    reportedClosed(rows, input.turnId);
  // Accept a verified duplicate without admitting a new turn after its final report.
  if (closed || recoveringClosed) {
    if (input.status === 'started' && !input.replay) throw new ReportRejected('Turn is closed');
    return;
  }
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

async function assistantDetailsFor(store: EventStore, context: TurnContext) {
  const assistant = await creationEvent(store, context.silo,
    `assistant-${context.assistantId}`, 'assistant.created');
  return assistantDetails.parse(assistant.data);
}

async function payingGroup(store: EventStore, context: TurnContext,
  conversation: StoredEvent[], requesterId: string, details: z.infer<typeof assistantDetails>) {
  if (details.kind === 'team') {
    if (!context.binding) throw new ReportRejected('IAM binding required for a new team turn');
    const group = sessionPayer(conversation, requesterId, details.payingGroupId);
    const subjects = [`member-${requesterId}`, `assistant-${context.assistantId}`,
      `team-${group}`, `team-${details.ownerId}`];
    const fresh = await authorityFence(store, performance.now(), subjects);
    const memberAuthority = { requiredRole: 'member' as const, fresh };
    await activeMember(store, context.binding, requesterId, memberAuthority);
    for (const groupId of new Set([group, details.ownerId])) {
      await groupMembership(store, context.silo, requesterId,
        groupId, context.binding, fresh.deadline);
    }
    return { payer: group, fresh };
  }
  const payer = await personalPayer(store, context.silo, performance.now() + 10_000);
  return { payer, fresh: undefined };
}
function sessionPayer(conversation: StoredEvent[], requesterId: string,
  assistantPayer: string | undefined) {
  const creation = conversation.find(isConversationCreated);
  const created = sessionDetails.parse(creation?.event.data);
  if (created.createdBy !== requesterId) throw new ReportRejected('Private requester mismatch');
  const group = created.payingGroupId;
  if (!group) throw new ReportRejected('Paying group unavailable for shared work');
  if (!assistantPayer || group !== assistantPayer) {
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
    const data = budgetDetails.parse(row.event.data);
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

function isFinalAdmissionRefusal(error: unknown): error is Error {
  if (error instanceof TurnAdmissionRejected) return true;
  if (error instanceof MemberAccessRefused) return true;
  return error instanceof PayingGroupRefused &&
    error.message !== 'Paying group authority changed; try again';
}


function requireFreshPrivateThread(events: StoredEvent[], input: TurnBinding, mode: ExecutionMode) {
  for (const row of events) {
    if (row.event.type !== 'computer.turn_started') continue;
    const previous = binding.parse(row.event.data);
    if (previous.turnId === input.turnId || previous.threadId !== input.threadId) continue;
    const previousMode = z.object({ executionMode: z.enum(['restricted', 'memory_free']).optional() })
      .parse(row.event.data).executionMode;
    if (mode === 'restricted' || previousMode === 'restricted') {
      throw new TurnAdmissionRejected('Private thread reused');
    }
  }
}

function storedExecutionMode(events: StoredEvent[], turnId: string) {
  let executionMode: ExecutionMode | undefined;
  for (const row of events) {
    if (row.event.type !== 'computer.turn_started') continue;
    const stored = z.object({ turnId: z.string(),
      executionMode: z.enum(['restricted', 'memory_free']).optional() }).parse(row.event.data);
    if (stored.turnId === turnId) executionMode = stored.executionMode;
  }
  return executionMode;
}

async function admitTurn(store: EventStore, context: TurnContext, rows: StoredEvent[],
  events: StoredEvent[], data: TurnBinding, requested: unknown, mode: ExecutionMode) {
  const details = await assistantDetailsFor(store, context);
  const required = requiredExecutionMode(details.kind, requested);
  if (mode !== required) throw new TurnAdmissionRejected('Execution mode mismatch');
  requireFreshPrivateThread(events, data, mode);
  return payingGroup(store, context, rows, data.requesterId, details);
}


function addLifecycleDetails(data: { executionMode?: ExecutionMode; status?: 'completed' | 'failed' },
  status: TurnInput['status'], executionMode: ExecutionMode | undefined) {
  if (status === 'started') {
    if (executionMode !== undefined) data.executionMode = executionMode;
  } else data.status = status;
}
