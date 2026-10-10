import { computerSummary, type ComputerSummary, type TurnSummary,
  type ThreadSummary } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import { optionalProviderTurnBindingSchema, type EventEnvelope } from '@opencrane/events';
import { authorityFence, groupMembership, PayingGroupRefused, MemberAccessRefused,
  activeMember, currentMembership } from '@opencrane/models';
  activeMember, providerTurnAdmission, managedProviderCallsEnabled } from '@opencrane/models';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readStreamSummary, readEventAt, WrongSiloError, type AppendCommand, type EventStore,
  type StoredEvent } from '@opencrane/event-store';
import { readChatFacts, type ChatFacts } from './chat-summary.ts';
import { creationEvent } from './private-session.ts';
import { agentSessionData, ReportRejected } from './reports.ts';

const bindingFields = optionalProviderTurnBindingSchema.safeExtend({
  conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(),
  requesterId: z.string(), task: z.literal('chat_turn'), payingGroupId: z.string().optional(),
  model: z.string().optional(),
});
const binding = bindingFields.strip();
const assistantDetails = z.object({
  kind: z.enum(['personal', 'team']), ownerId: z.string(),
  payingGroupId: z.string().optional(),
});
const sessionDetails = z.object({
  createdBy: z.string(), payingGroupId: z.string().optional(),
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

type WriteAuthority = () => Promise<void>;

/** Append one lifecycle event. Reports cannot reopen a closed turn. */
export async function turnCommand(store: EventStore, context: TurnContext, input: TurnInput) {
  const conversation = await readChatFacts(store, context.silo, input.conversationId, input.turnId);
  const requested = requestedTurn(conversation, context.assistantId);
  const subject = `computer-${context.assistantId}`;
  const facts = await computerFacts(store, context.silo, context.assistantId, input);
  const data = decideTurn(facts, conversation, input, context.computerId, requested.requesterId);
  if (!data) return;
  let fresh: WriteAuthority | undefined;
  let status = input.status;
  let refusal: TurnAdmissionRejected | undefined;
  requireThreadOwner(facts, data);
  let executionMode = facts.turn?.lastStartExecutionMode;
  if (input.status === 'started' && !facts.turn?.hasStart) {
    try {
      executionMode = input.executionMode ?? 'memory_free';
      const admission = await admitTurn(store, context, conversation, facts, data,
        requested.executionMode, executionMode);
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
  const event: EventEnvelope = {
    id, commandId: id, type, subject, silo: context.silo, correlation: {},
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'turn-lifecycle' },
    time: new Date().toISOString(), data: eventData,
  };
  addLifecycleDetails(eventData, status, executionMode);
  await fresh?.();
  await saveTurn(store, facts, event, data);
  if (refusal) throw refusal;
  if (input.status === 'started') return { ...data, threadId: z.string().parse(data.threadId),
    executionMode: executionMode ?? 'memory_free' };
  return undefined;
}

async function saveTurn(store: EventStore, facts: ComputerFacts,
  event: EventEnvelope, data: TurnBinding) {
  const id = event.id;
  const subject = event.subject;
  // Check repeats before skipping the store's search, even after NATS dedupe expires.
  const commandKey = JSON.stringify(['system', 'turn-lifecycle', id]);
  if (!facts.turn?.startCommandKeys?.has(commandKey)) {
    const command: AppendCommand = {
      expectedSequence: facts.sequence, historyChecked: true, event,
    };
    const result = await store.append(command);
    if (result.status !== 'appended') throw new Error('Turn append conflict or unavailable');
    const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
    verifyBinding(saved?.event.id === id ? saved : undefined, data);
  }
}

type ComputerFacts = {
  lifecycle: StoredEvent | undefined;
  turn: TurnSummary | undefined;
  threads: Map<string, ThreadSummary>;
  sequence: number;
};
function copyThread(thread: ThreadSummary): ThreadSummary {
  return { owners: new Set(thread.owners), startedTurnIds: new Set(thread.startedTurnIds),
    restrictedTurnIds: new Set(thread.restrictedTurnIds) };
}
async function computerFacts(store: EventStore, silo: string, assistantId: string, input: TurnInput) {
  function take(summary: ComputerSummary, sequence: number): ComputerFacts {
    const storedTurn = summary.turns.get(input.turnId);
    let turn: TurnSummary | undefined;
    if (storedTurn) {
      turn = { ...storedTurn };
      if (storedTurn.startCommandKeys) turn.startCommandKeys = new Set(storedTurn.startCommandKeys);
      if (storedTurn.firstClose) turn.firstClose = { ...storedTurn.firstClose };
    }
    const threads = new Map<string, ThreadSummary>();
    const firstThread = turn?.firstStart && binding.parse(turn.firstStart.event.data).threadId;
    for (const threadId of [input.threadId, firstThread]) {
      if (threadId === undefined) continue;
      const thread = summary.threads.get(threadId);
      if (thread) threads.set(threadId, copyThread(thread));
    }
    return { lifecycle: summary.lifecycle, turn, threads, sequence };
  }
  try {
    return await readStreamSummary(store, silo, `computer-${assistantId}`,
      computerSummary, performance.now() + 10_000, take);
  } catch (error) {
    if (error instanceof WrongSiloError) {
      throw new ReportRejected('Computer silo mismatch', { cause: error });
    }
    throw error;
  }
}
function requestedTurn(conversation: ChatFacts, assistantId: string) {
  const created = agentSessionData(conversation.created);
  if (created.assistantId !== assistantId || !conversation.message) {
    throw new ReportRejected('Unrequested turn');
  }
  const details = z.object({ authorId: z.string(), executionMode: z.literal('memory_free').optional() })
    .parse(conversation.message);
  return { requesterId: details.authorId, executionMode: details.executionMode };
}
function checkStart(facts: ComputerFacts, conversation: ChatFacts, computerId: string) {
  const current = facts.lifecycle;
  const computer = z.object({ computerId: z.string() });
  if (current?.event.type !== 'computer.ready' ||
      computer.parse(current.event.data).computerId !== computerId) {
    throw new Error('Computer is not ready');
  }
  if (conversation.closed) throw new ReportRejected('Turn is closed');
}
function isRefusedAdmission(turn: TurnSummary | undefined,
  conversation: ChatFacts, input: TurnInput) {
  return turn?.firstClose?.status === 'failed' && !turn.hasStart &&
    input.status === 'started' && !conversation.closed;
}

function decideTurn(facts: ComputerFacts, conversation: ChatFacts, input: TurnInput,
  computerId: string, requesterId: string) {
  const turn = facts.turn;
  const closed = turn?.firstClose;
  const started = turn?.firstStart;
  if (isRefusedAdmission(turn, conversation, input)) {
    throw new TurnAdmissionRejected('Turn admission was refused');
  }
  const recoveringClosed = input.replay && input.status === 'started' &&
    conversation.closed;
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
    checkStart(facts, conversation, computerId);
  }
  return data;
}
function verifyBinding(saved: StoredEvent | undefined, expected: TurnBinding) {
  const stored = saved && binding.parse(saved.event.data);
  const expectedBinding = binding.parse(expected);
  if (!saved || JSON.stringify(stored) !== JSON.stringify(expectedBinding)) {
    throw new ReportRejected('Turn binding conflict');
  }
}

async function assistantDetailsFor(store: EventStore, context: TurnContext) {
  const assistant = await creationEvent(store, context.silo,
    `assistant-${context.assistantId}`, 'assistant.created');
  return assistantDetails.parse(assistant.data);
}

async function payingGroup(store: EventStore, context: TurnContext,
  conversation: ChatFacts, requesterId: string, details: z.infer<typeof assistantDetails>,
  defaultPayingGroupId: string | undefined) {
  if (details.kind === 'team') {
    if (!context.binding) throw new ReportRejected('IAM binding required for a new team turn');
    const group = sessionPayer(conversation, requesterId, details.payingGroupId);
    const subjects = [`member-${requesterId}`, `assistant-${context.assistantId}`,
      `team-${group}`, `team-${details.ownerId}`];
    const membership = await currentMembership(store, context.silo, requesterId,
      undefined, performance.now() + 10_000);
    const fresh = await authorityFence(store, performance.now(), subjects);
    const memberAuthority = { requiredRole: 'member' as const, fresh, membership };
    await activeMember(store, context.binding, requesterId, memberAuthority);
    for (const groupId of new Set([group, details.ownerId])) {
      await groupMembership(store, context.silo, requesterId,
        groupId, context.binding, fresh.deadline);
    }
    return { payer: group, fresh };
  }
  if (!defaultPayingGroupId) {
    throw new ReportRejected('Paying group unavailable; configure the installation default');
  }
  return { payer: defaultPayingGroupId, fresh: undefined };
}
function sessionPayer(conversation: ChatFacts, requesterId: string,
  assistantPayer: string | undefined) {
  const created = sessionDetails.parse(conversation.created);
  if (created.createdBy !== requesterId) throw new ReportRejected('Private requester mismatch');
  const group = created.payingGroupId;
  if (!group) throw new ReportRejected('Paying group unavailable for shared work');
  if (!assistantPayer || group !== assistantPayer) {
    throw new ReportRejected('Paying group does not match the assistant');
  }
  return group;
}
function requireThreadOwner(facts: ComputerFacts, input: TurnBinding) {
  if (input.threadId === undefined) return;
  const thread = facts.threads.get(input.threadId);
  const owner = JSON.stringify([input.requesterId, input.conversationId]);
  if (thread && hasOtherValue(thread.owners, owner)) {
    throw new ReportRejected('Thread belongs to another requester or conversation');
  }
}
function hasOtherValue(values: Set<string>, current: string) {
  for (const value of values) {
    if (value !== current) return true;
  }
  return false;
}

function isFinalAdmissionRefusal(error: unknown): error is Error {
  if (error instanceof TurnAdmissionRejected) return true;
  if (error instanceof MemberAccessRefused) return true;
  return error instanceof PayingGroupRefused &&
    error.message !== 'Paying group authority changed; try again';
}


function requireFreshPrivateThread(facts: ComputerFacts, input: TurnBinding, mode: ExecutionMode) {
  if (input.threadId === undefined) return;
  const thread = facts.threads.get(input.threadId);
  if (!thread) return;
  const otherStarted = hasOtherValue(thread.startedTurnIds, input.turnId);
  const otherRestricted = hasOtherValue(thread.restrictedTurnIds, input.turnId);
  if ((mode === 'restricted' && otherStarted) || otherRestricted) {
    throw new TurnAdmissionRejected('Private thread reused');
  }
}

async function admitTurn(store: EventStore, context: TurnContext, conversation: ChatFacts,
  facts: ComputerFacts, data: TurnBinding, requested: unknown, mode: ExecutionMode) {
  const details = await assistantDetailsFor(store, context);
  const required = requiredExecutionMode(details.kind, requested);
  if (mode !== required) throw new TurnAdmissionRejected('Execution mode mismatch');
  requireFreshPrivateThread(facts, data, mode);
  // Read provider configuration before starting the short access check.
  const admission = await providerTurnAdmission(store, context.silo,
    context.assistantId, performance.now() + 10_000);
  applyProviderChoice(data, admission);
  const payer = await payingGroup(store, context, conversation, data.requesterId, details,
    admission.defaultPayingGroupId);
  const deadline = payer.fresh?.deadline ?? performance.now() + 2000;
  async function confirmAdmission() {
    const enabled = await managedProviderCallsEnabled(store, context.silo, deadline);
    if (enabled !== admission.enabled) {
      throw new TurnAdmissionRejected('Provider setup changed; try again');
    }
    await payer.fresh?.();
  }
  return { payer: payer.payer, fresh: confirmAdmission };
}


function addLifecycleDetails(data: { executionMode?: ExecutionMode; status?: 'completed' | 'failed' },
  status: TurnInput['status'], executionMode: ExecutionMode | undefined) {
  if (status === 'started') {
    if (executionMode !== undefined) data.executionMode = executionMode;
  } else {
    data.status = status;
  }
}

function applyProviderChoice(data: TurnBinding,
  admission: Awaited<ReturnType<typeof providerTurnAdmission>>) {
  if (!admission.enabled) {
    return;
  }
  const choice = admission.choice;
  if (!choice) {
    throw new TurnAdmissionRejected('Choose a provider and model before starting model work');
  }
  if (choice.state === 'paused') {
    throw new TurnAdmissionRejected('Model work is paused by an administrator');
  }
  data.providerId = choice.providerId;
  data.bindingSequence = choice.bindingSequence;
  data.model = choice.model;
}
