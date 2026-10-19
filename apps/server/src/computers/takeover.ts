import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { readEventAt, readStreamSummary, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { takeoverRequestedDataSchema } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { readChatFacts, type ChatFacts } from '../chat/chat-summary.ts';
import { ChatRefused, chatAccess, writeChatAccess, type ChatOptions } from '../chat/access.ts';
import { writePrivateSession } from '../chat/private-session.ts';
import { desktopAccess, viewAccess } from './view-access.ts';

export class RequesterOnly extends ChatRefused {}
export class ControlConflict extends Error {}
class ControlUnavailable extends Error {}

const id = z.string().regex(/^[\w-]{1,200}$/u);
const requestSchema = z.object({
  commandId: id, conversationId: id, requesterEventId: id, generation: z.int().positive(),
}).strict();
type ControlRequest = z.infer<typeof requestSchema>;
const turnOwnerSchema = z.object({ conversationId: id, requesterId: id });
const readySchema = z.object({
  assistantId: id, computerId: id, generation: z.int().positive(), podUid: id,
});
function takeComputer(summary: ComputerSummary, sequence: number) {
  const openTurns = [];
  for (const [turnId, turn] of summary.turns) {
    if (turn.firstStart && !turn.firstClose) {
      const open = { turnId, row: turn.firstStart };
      openTurns.push(open);
    }
  }
  return { control: structuredClone(summary.control), lifecycle: summary.lifecycle,
    openTurns, sequence };
}
// Keep HTTP requests disabled until returning control and recovery are available.
export async function requestControl(options: ChatOptions, memberId: string, raw: unknown) {
  const input = requestSchema.parse(raw);
  const { chat, computer: facts, accessOptions } = await loadControl(
    options, input.conversationId, input.requesterEventId);
  const accessRequest = { memberId, conversationId: input.conversationId };
  await chatAccess(accessOptions, accessRequest);
  if (chat.latestHuman && chat.latestHuman.id !== input.requesterEventId) {
    throw new ControlConflict('Control conflict');
  }
  if (chat.conversationClosed || chat.latestHuman?.authorId !== memberId) {
    throw new RequesterOnly('Requester only');
  }
  if (facts?.lifecycle?.event.type !== 'computer.ready') {
    throw new ControlUnavailable('Computer unavailable');
  }
  const ready = readySchema.parse(facts.lifecycle.event.data);
  if (ready.generation !== input.generation) throw new ControlConflict('Control conflict');
  const affectedTurnIds = affectedTurns(facts, memberId, input.conversationId);
  const fresh = await controlAccess(accessOptions, memberId, input, ready, chat, options.store);
  const previous = facts.control;
  if (previous) {
    return repeatedRequest(previous, memberId, input);
  }
  return saveIntent(options, memberId, input, ready, affectedTurnIds, facts.sequence, fresh.deadline);
}

function affectedTurns(facts: ReturnType<typeof takeComputer>, memberId: string,
  conversationId: string) {
  const affectedTurnIds = [];
  for (const turn of facts.openTurns) {
    const details = turnOwnerSchema.parse(turn.row.event.data);
    if (details.conversationId === conversationId && details.requesterId !== memberId) {
      throw new ChatRefused('Requester changed');
    }
    affectedTurnIds.push(turn.turnId);
  }
  return affectedTurnIds;
}

async function controlAccess(options: ChatOptions, memberId: string, input: ControlRequest,
  ready: z.infer<typeof readySchema>, chat: ChatFacts, store: EventStore) {
  const assistantId = ready.assistantId;
  // Load access history before opening the short write check.
  const accessRequest = { memberId, conversationId: input.conversationId, relation: 'post' as const };
  await viewAccess(options, memberId, input.conversationId);
  const teamFresh = await writePrivateSession(options, memberId, input.conversationId, false);
  const fresh = await writeChatAccess(options, accessRequest);
  fresh.include(`assistant-${assistantId}`, grantStream('shared_desktop', ready.computerId));
  const bounded = { ...options, deadline: fresh.deadline };
  const desktop = await desktopAccess(bounded, memberId, input.conversationId, ready.computerId);
  const auth = memberAuthorisation(options.binding);
  const assistantPermission = await auth.actsFor(memberId, assistantId);
  if (assistantPermission.status === 'unavailable') throw new ControlUnavailable('Control unavailable');
  if (!assistantPermission.allowed) throw new ChatRefused('Assistant refused');
  const desktopPermission = await auth.view(
    memberId, input.conversationId, ready.computerId, desktop.receipts);
  if (desktopPermission.status === 'unavailable') throw new ControlUnavailable('Control unavailable');
  if (!desktopPermission.allowed) {
    throw new ChatRefused('Desktop refused');
  }
  await teamFresh?.();
  await desktop.fresh();
  await fresh();
  await confirmRequest(store, options.silo, input.conversationId, chat.sequence,
    fresh.deadline);
  await desktop.fresh();
  await teamFresh?.();
  await fresh();
  return fresh;
}

async function confirmRequest(store: EventStore, silo: string, conversationId: string,
  sequence: number, deadline: number) {
  const subject = `conversation-${conversationId}`;
  const latest = await store.head(subject, deadline, true);
  if (latest <= sequence) return;
  for await (const row of store.readStream(subject, sequence + 1, deadline, true)) {
    if (row.sequence > latest) break;
    const details = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (row.event.silo !== silo || row.event.type === 'conversation.closed' ||
        (row.event.type === 'message.posted' && details['authorKind'] === 'human')) {
      throw new ControlConflict('Control conflict');
    }
  }
}

function repeatedRequest(previous: NonNullable<ComputerSummary['control']>,
  memberId: string, input: ControlRequest) {
  if (previous.phase !== 'unverified' && previous.commandId === input.commandId &&
      previous.requesterId === memberId && previous.conversationId === input.conversationId &&
      previous.requesterEventId === input.requesterEventId && previous.generation === input.generation) {
    return previous;
  }
  throw new ControlConflict('Control conflict');
}

async function saveIntent(options: ChatOptions, memberId: string, input: ControlRequest,
  ready: z.infer<typeof readySchema>, affectedTurnIds: string[], sequence: number, deadline: number) {
  const assistantId = ready.assistantId;
  const subject = `computer-${assistantId}`;
  const requested = { ...ready, conversationId: input.conversationId,
    requesterId: memberId, requesterEventId: input.requesterEventId, takeoverId: input.commandId,
    leaseId: input.commandId, reason: 'requester_requested', affectedTurnIds };
  const data = takeoverRequestedDataSchema.parse(requested);
  const event = envelope(options.silo, subject, 'takeover.requested', data);
  const hash = createHash('sha256');
  hash.update(JSON.stringify([assistantId, input.commandId]));
  event.id = hash.digest('hex');
  event.commandId = input.commandId;
  event.source = 'opencrane-server';
  event.principal = { kind: 'human', id: memberId };
  const command = { event, expectedSequence: sequence, historyChecked: true as const,
    deadline };
  const result = await options.store.append(command);
  if (result.status === 'unavailable') throw new ControlUnavailable('Control unavailable');
  if (result.status !== 'appended') throw new ControlConflict('Control conflict');
  const saved = await readEventAt(options.store, subject, result.sequence, performance.now() + 10_000);
  if (!isDeepStrictEqual(saved?.event, event)) {
    throw new ControlUnavailable('Control unavailable');
  }
  return { ...data, phase: 'requested' as const, position: result.sequence,
    commandId: input.commandId, requestedAt: event.time };
}

async function loadControl(options: ChatOptions, conversationId: string, turnId: string) {
  const deadline = performance.now() + 10_000;
  const chat = await readChatFacts(options.store, options.silo, conversationId, turnId,
    undefined, undefined, deadline);
  const assistantId = chat.created?.['assistantId'];
  let computer: ReturnType<typeof takeComputer> | undefined;
  if (chat.created?.['mode'] === 'agent_session' && typeof assistantId === 'string') {
    computer = await readStreamSummary(options.store, options.silo, `computer-${assistantId}`,
      computerSummary, deadline, takeComputer);
  }
  const accessOptions = await creationAccess(options, conversationId, deadline);
  return { chat, computer, accessOptions, deadline };
}

export async function controlStatus(options: ChatOptions, memberId: string,
  conversationId: string, requestsEnabled: boolean) {
  const loaded = await loadControl(options, conversationId, '');
  const { chat, computer, accessOptions, deadline } = loaded;
  const control = computer?.control;
  const privateFields = await requesterFields(options, control, memberId, conversationId, deadline);
  const access = { memberId, conversationId };
  await chatAccess(accessOptions, access);
  const eligibleActions = [];
  if (requestsEnabled && canRequest(chat, computer, memberId)) eligibleActions.push('request');
  let status = control?.phase ?? 'none';
  if (chat.created?.['mode'] !== 'agent_session') status = 'not_applicable';
  const sameChat = !control || (control.phase !== 'unverified' &&
    control.conversationId === conversationId);
  const scope = sameChat ? 'this_conversation' : 'other_work';
  let reason = 'none';
  if (control) reason = control.phase === 'unverified' ? 'unverified' : control.reason;
  return { status, controlPosition: control?.position ?? 0, reason, scope, eligibleActions,
    ...privateFields };
}
function canRequest(chat: ChatFacts, computer: ReturnType<typeof takeComputer> | undefined,
  memberId: string) {
  return computer?.lifecycle?.event.type === 'computer.ready' && !computer.control &&
    !chat.conversationClosed && chat.latestHuman?.authorId === memberId;
}
async function requesterFields(options: ChatOptions, control: ComputerSummary['control'],
  memberId: string, conversationId: string, deadline: number) {
  if (!control || control.phase === 'unverified' || control.requesterId !== memberId) return {};
  const affectedTurnIds = [];
  for (const turnId of control.affectedTurnIds) {
    const turn = await readChatFacts(options.store, options.silo, conversationId, turnId,
      undefined, undefined, deadline);
    if (turn.message?.authorId === memberId) affectedTurnIds.push(turnId);
  }
  return { commandId: control.commandId, affectedTurnIds };
}

async function creationAccess(options: ChatOptions, conversationId: string, deadline: number) {
  const subject = `conversation-${conversationId}`;
  let creation: StoredEvent | undefined;
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    creation = row;
    break;
  }
  // Supply only the immutable creation record to access helpers. Load mutable
  // chat facts before checking access and confirm later activity separately.
  async function* readStream(name: string, from = 1, deadline = Infinity, closes = false) {
    if (name === subject) {
      if (from !== 1 || closes) throw new ControlUnavailable('Unexpected history read');
      if (creation) yield creation;
      return;
    }
    yield* options.store.readStream(name, from, deadline, closes);
  }
  function get(target: EventStore, key: string | symbol): unknown {
    if (key === 'readStream') return readStream;
    return Reflect.get(target, key);
  }
  const handler = { get };
  const store = new Proxy(options.store, handler);
  return { ...options, store };
}
