import { computerSummary, type ComputerSummary, type TurnSummary,
  type ThreadSummary } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import { optionalProviderTurnBindingSchema, type EventEnvelope } from '@opencrane/events';
import {
  authorityFence,
  turnBudgetStop,
  groupMembership,
  PayingGroupRefused,
  MemberAccessRefused,
  activeMember,
  currentMembership,
  providerTurnAdmission,
} from '@opencrane/models';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readStreamSummary, readEventAt, WrongSiloError, type AppendCommand, type EventStore,
  type StoredEvent, type AppendResult } from '@opencrane/event-store';
import { chatMembership } from './participation.ts';
import { readChatFacts, type ChatFacts } from './chat-summary.ts';
import { creationEvent } from './private-session.ts';
import { agentSessionData, ReportRejected } from './reports.ts';

const bindingFields = optionalProviderTurnBindingSchema.safeExtend({
  conversationId: z.string(), turnId: z.string(), threadId: z.string().optional(),
  requesterId: z.string(), task: z.literal('chat_turn'), payingGroupId: z.string().optional(),
  messageId: z.string().optional(), rootId: z.string().optional(),
  model: z.string().optional(), sharingClass: z.literal('shared_only').optional(),
});
const binding = bindingFields.strip();
const assistantDetails = z.object({
  kind: z.enum(['personal', 'team']), ownerId: z.string(),
  payingGroupId: z.string().optional(),
});
const sessionDetails = z.object({
  createdBy: z.string(), payingGroupId: z.string().optional(),
  contextKind: z.literal('shared_child').optional(),
});

type TurnBinding = z.infer<typeof binding>;
export type ExecutionMode = 'restricted' | 'memory_free';
export type ContextClass = 'shared_only';
export function requiredExecutionMode(assistantKind: string, requested: unknown): ExecutionMode {
  if (assistantKind !== 'team' || requested === 'memory_free') return 'memory_free';
  return 'restricted';
}

type TurnInput = {
  nativeTermination?: 'turn_completed' | undefined;
  executionMode?: ExecutionMode | undefined;
  messageId?: string | undefined; rootId?: string | undefined;
  senderAttemptId?: string | undefined;
  conversationId: string; turnId: string; threadId?: string | undefined;
  status: 'started' | 'completed' | 'failed'; replay?: boolean;
};
type TurnContext = {
  silo: string; computerId: string; assistantId: string; binding?: Binding;
  routineStart?: ((input: TurnInput) => Promise<{ payer: string; fresh: WriteAuthority;
    deadline: number; confirmStarted: (saved: StoredEvent | undefined) => Promise<void>;
    provider: Awaited<ReturnType<typeof providerTurnAdmission>> }>) | undefined;
};
export class TurnAdmissionRejected extends ReportRejected {}
export class BudgetAdmissionRejected extends TurnAdmissionRejected {
  readonly stopId: string;

  constructor(stopId: string) {
    super('Turn stopped by a spending cap');
    this.stopId = stopId;
  }
}

type WriteAuthority = () => Promise<void>;

/** Append one lifecycle event. Reports cannot reopen a closed turn. */
export async function turnCommand(store: EventStore, context: TurnContext, input: TurnInput) {
  const conversation = await readChatFacts(store, context.silo, input.conversationId, input.turnId);
  const requested = requestedTurn(conversation, context.assistantId);
  const subject = `computer-${context.assistantId}`;
  const facts = await computerFacts(store, context.silo, context.assistantId, input);
  const data = decideTurn(facts, conversation, input, context.computerId,
    requested.requesterId, requested.sharingClass);
  if (!data) return;
  let fresh: WriteAuthority | undefined;
  let routineDeadline: number | undefined;
  let confirmBudget: ((saved: StoredEvent | undefined) => Promise<void>) | undefined;
  let status = input.status;
  let refusal: TurnAdmissionRejected | undefined;
  requireThreadOwner(facts, data);
  let executionMode = facts.turn?.lastStartExecutionMode;
  // Check current membership on repeats before returning the saved turn.
  if (input.status === 'started') {
    try {
      if (conversation.conversationClosed) {
        throw new TurnAdmissionRejected('Conversation is closed');
      }
      executionMode = startExecutionMode(facts, input);
      const admission = await startAuthority(store, context, conversation, facts, data,
        requested.executionMode, executionMode, input);
      routineDeadline = admission.deadline;
      if (admission.payer) data.payingGroupId = admission.payer;
      fresh = admission.fresh;
      confirmBudget = admission.confirmBudget;
    } catch (error) {
      if (!isFinalAdmissionRefusal(error)) throw error;
      refusal = error instanceof TurnAdmissionRejected
        ? error : new TurnAdmissionRejected(error.message, { cause: error });
      status = 'failed';
    }
  }
  const type = status === 'started' ? 'computer.turn_started' : 'computer.turn_closed';
  const hash = createHash('sha256');
  hash.update(`${context.computerId}:${input.turnId}:${type}`);
  const id = hash.digest('hex');
  const eventData: TurnBinding & {
    assistantId: string; computerId: string; status?: 'completed' | 'failed';
    executionMode?: ExecutionMode; sharingClass?: ContextClass | undefined;
    budgetStopId?: string; nativeTermination?: 'turn_completed';
  } = { ...data, assistantId: context.assistantId, computerId: context.computerId };
  if (input.status === 'failed' && input.nativeTermination && facts.turn?.hasStart) {
    eventData.nativeTermination = input.nativeTermination;
  }
  if (refusal instanceof BudgetAdmissionRejected) eventData.budgetStopId = refusal.stopId;
  const event: EventEnvelope = {
    id, commandId: id, type, subject, silo: context.silo, correlation: {},
    source: 'opencrane-server', principal: { kind: 'system' as const, id: 'turn-lifecycle' },
    time: new Date().toISOString(), data: eventData,
  };
  addLifecycleDetails(eventData, status, executionMode);
  await fresh?.();
  const saved = await saveTurn(store, facts, event, data, routineDeadline, fresh);
  if (refusal) throw refusal;
  // Check authority and stops again after the separate computer append finishes.
  await confirmBudget?.(saved);
  if (input.status === 'started') return admittedTurn(data, executionMode);
  return undefined;
}

function admittedTurn(data: TurnBinding, executionMode: ExecutionMode | undefined) {
  return { ...data, threadId: z.string().parse(data.threadId),
    executionMode: executionMode ?? 'memory_free',
    ...(data.sharingClass ? { sharingClass: data.sharingClass } : {}) };
}

function startExecutionMode(facts: ComputerFacts, input: TurnInput) {
  if (facts.turn?.hasStart) return facts.turn.lastStartExecutionMode ?? 'memory_free';
  return input.executionMode ?? 'memory_free';
}

async function startAuthority(store: EventStore, context: TurnContext, conversation: ChatFacts,
  facts: ComputerFacts, data: TurnBinding, requested: unknown, mode: ExecutionMode,
  input: TurnInput) {
  if (conversation.created?.['routinePreparation'] !== undefined) {
    if (!context.routineStart || facts.turn?.hasStart) {
      throw new TurnAdmissionRejected('Routine start unavailable');
    }
    const admission = await context.routineStart(input);
    applyProviderChoice(data, admission.provider);
    return { ...admission, confirmBudget: admission.confirmStarted };
  }
  if (input.messageId !== undefined || input.rootId !== undefined ||
      input.senderAttemptId !== undefined) throw new ReportRejected('Unexpected routine binding');
  const started = facts.turn?.firstStart;
  if (started) {
    const work = { ...data, assistantId: context.assistantId };
    const admittedAt = conversation.message!.position;
    const stop = await turnBudgetStop(store, context.silo, work, admittedAt,
      performance.now() + 10_000);
    const authority = await requireTurnMember(store, context.silo, data.requesterId);
    // Load history before the short access check, but reveal spending only to current members.
    requireNoBudgetStop(stop);
    async function fresh() {
      await authority();
      const currentStop = await turnBudgetStop(store, context.silo, work, admittedAt,
        authority.deadline);
      await authority();
      requireNoBudgetStop(currentStop);
    }
    return { fresh, payer: undefined, confirmBudget: fresh, deadline: undefined };
  }
  const admission = await admitTurn(store, context, conversation, facts, data, requested, mode);
  return { ...admission, deadline: undefined };
}

function requireNoBudgetStop(stop: string | undefined) {
  if (stop !== undefined) throw new BudgetAdmissionRejected(stop);
}

async function saveTurn(store: EventStore, facts: ComputerFacts,
  event: EventEnvelope, data: TurnBinding, deadline?: number, checkAccess?: WriteAuthority) {
  const id = event.id;
  const subject = event.subject;
  // Check repeats before skipping the store's search, even after NATS dedupe expires.
  const commandKey = JSON.stringify(['system', 'turn-lifecycle', id]);
  if (!facts.turn?.startCommandKeys?.has(commandKey)) {
    const command: AppendCommand = {
      expectedSequence: facts.sequence, historyChecked: true, event,
      ...(deadline === undefined || !checkAccess ? {} : { deadline, checkAccess }),
    };
    let result = await store.append(command);
    // Retry only a proven unsaved routine start, within its original access deadline.
    while (deadline !== undefined && performance.now() < deadline && canRetryRoutineStart(result)) {
      let sequence = command.expectedSequence;
      for await (const row of store.readStream(subject, sequence + 1, deadline)) {
        sequence = row.sequence;
      }
      // Validate changes after reading the new position, before retrying publication.
      // The routine check rejects lifecycle changes and activity on the selected thread.
      await checkAccess?.();
      command.expectedSequence = sequence;
      result = await store.append(command);
    }
    if (result.status !== 'appended') throw new Error('Turn append conflict or unavailable');
    const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
    verifyBinding(saved?.event.id === id ? saved : undefined, data);
    return saved;
  }
  return undefined;
}

function canRetryRoutineStart(result: AppendResult) {
  if (result.status !== 'conflict') return false;
  const outcome = result.outcome;
  if (outcome?.kind !== 'conditional_rejection_unchanged' &&
      outcome?.kind !== 'conditional_rejection_changed') return false;
  return !outcome.possiblyPublished;
}

type ComputerFacts = {
  control: ComputerSummary['control'];
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
    return { control: summary.control, lifecycle: summary.lifecycle, turn, threads, sequence };
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
  const sharingClass: ContextClass | undefined =
    'contextKind' in created && created.contextKind === 'shared_child'
    ? 'shared_only' : undefined;
  return { requesterId: details.authorId, executionMode: details.executionMode, sharingClass };
}
function checkStart(facts: ComputerFacts, conversation: ChatFacts, computerId: string) {
  const current = facts.lifecycle;
  const computer = z.object({ computerId: z.string() });
  if (current?.event.type !== 'computer.ready' ||
      computer.parse(current.event.data).computerId !== computerId) {
    throw new Error('Computer is not ready');
  }
  // Save a bound refusal when close cleanup ended a queued turn before its start arrived.
  if (conversation.turnEnded && !conversation.cleanupEnded) {
    throw new ReportRejected('Turn is closed');
  }
}
function isRefusedAdmission(turn: TurnSummary | undefined,
  conversation: ChatFacts, input: TurnInput) {
  return turn?.firstClose?.status === 'failed' && !turn.hasStart &&
    input.status === 'started' && !conversation.turnEnded;
}

function requireNoControl(facts: ComputerFacts) {
  if (facts.control) throw new TurnAdmissionRejected('Computer control is pending');
}

function refuseClosedConversation(turn: TurnSummary | undefined,
  conversation: ChatFacts, input: TurnInput) {
  if (input.status !== 'started' || !conversation.conversationClosed) return;
  // Keep admitted work until termination is confirmed; refusing a pass is not termination.
  if (turn?.firstStart || turn?.firstClose ||
      (conversation.turnEnded && !conversation.cleanupEnded)) {
    throw new TurnAdmissionRejected('Conversation is closed');
  }
}

function refuseSavedBudgetStop(turn: TurnSummary | undefined, input: TurnInput) {
  const stopId = turn?.firstClose?.budgetStopId;
  // Keep the refusal recoverable if its acknowledgement or decision save was lost.
  if (input.status === 'started' && stopId) {
    throw new BudgetAdmissionRejected(stopId);
  }
}

function decideTurn(facts: ComputerFacts, conversation: ChatFacts, input: TurnInput,
  computerId: string, requesterId: string, sharingClass: ContextClass | undefined) {
  const turn = facts.turn;
  const closed = turn?.firstClose;
  const started = turn?.firstStart;
  refuseSavedBudgetStop(turn, input);
  refuseClosedConversation(turn, conversation, input);
  if (isRefusedAdmission(turn, conversation, input)) {
    throw new TurnAdmissionRejected('Turn admission was refused');
  }
  const recoveringClosed = input.replay && input.status === 'started' &&
    conversation.turnEnded;
  // Accept a verified duplicate without admitting a new turn after its final report.
  if (closed || recoveringClosed) {
    if (input.status === 'started' && !input.replay) throw new ReportRejected('Turn is closed');
    return;
  }
  let data: TurnBinding;
  if (started) {
    data = binding.parse(started.event.data);
  } else {
    data = binding.parse({ ...input, requesterId, task: 'chat_turn', sharingClass });
  }
  if (input.status === 'started') {
    requireNoControl(facts);
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
  const fresh = await requireTurnMember(store, context.silo, requesterId);
  return { payer: defaultPayingGroupId, fresh };
}
function sessionPayer(conversation: ChatFacts, requesterId: string,
  assistantPayer: string | undefined) {
  const created = sessionDetails.parse(conversation.created);
  if (created.contextKind !== 'shared_child' && created.createdBy !== requesterId) {
    throw new ReportRejected('Private requester mismatch');
  }
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
  const queued = { conversationId: data.conversationId, turnId: data.turnId,
    position: conversation.message!.position,
    payingGroupId: details.kind === 'team'
      ? sessionDetails.parse(conversation.created).payingGroupId : undefined };
  // Read provider and budget history before starting the short access check.
  const admission = await providerTurnAdmission(store, context.silo,
    context.assistantId, performance.now() + 10_000, queued);
  applyProviderChoice(data, admission);
  const payer = await payingGroup(store, context, conversation, data.requesterId, details,
    admission.defaultPayingGroupId);
  requireNoBudgetStop(admission.stopId);
  const deadline = payer.fresh?.deadline ?? performance.now() + 2000;
  async function confirmAdmission() {
    const current = await providerTurnAdmission(
      store, context.silo, context.assistantId, deadline, queued);
    requireNoBudgetStop(current.stopId);
    if (current.enabled !== admission.enabled || current.draining !== admission.draining) {
      throw new TurnAdmissionRejected('Provider setup changed; try again');
    }
    await payer.fresh?.();
  }
  async function confirmSavedBudget() {
    const current = await providerTurnAdmission(
      store, context.silo, context.assistantId, deadline, queued);
    await payer.fresh?.();
    requireNoBudgetStop(current.stopId);
  }
  // Keep provider switch-on refusal at its existing send gate after a start was saved.
  return { payer: payer.payer, fresh: confirmAdmission, confirmBudget: confirmSavedBudget };
}


function addLifecycleDetails(data: { executionMode?: ExecutionMode; status?: 'completed' | 'failed' },
  status: TurnInput['status'], executionMode: ExecutionMode | undefined) {
  if (status === 'started') {
    if (executionMode !== undefined) data.executionMode = executionMode;
  } else {
    data.status = status;
  }
}

export async function requireTurnMember(store: EventStore, silo: string, requesterId: string) {
  const subjects = [`member-${requesterId}`];
  const fresh = await authorityFence(store, performance.now(), subjects);
  const active = await chatMembership(store, silo, requesterId, fresh.deadline);
  if (!active) throw new TurnAdmissionRejected('Active silo membership required');
  await fresh();
  return fresh;
}

function applyProviderChoice(data: TurnBinding,
  admission: Awaited<ReturnType<typeof providerTurnAdmission>>) {
  if (admission.draining) {
    throw new TurnAdmissionRejected('Model work is draining; try again after the provider change');
  }
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
