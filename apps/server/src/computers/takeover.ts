import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { readEventAt, readStreamSummary, type EventStore } from '@opencrane/event-store';
import { takeoverRequestedDataSchema } from '@opencrane/events';
import { envelope } from '@opencrane/models';
import { readChatFacts, type ChatFacts } from '../chat/chat-summary.ts';
import { ChatRefused, chatAccess, writeChatAccess, type ChatOptions } from '../chat/access.ts';
import { writePrivateSession } from '../chat/private-session.ts';
import { desktopAccess, viewAccess } from './view-access.ts';

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
// Keep this command internal until local pause and recovery are available.
export async function requestControl(options: ChatOptions, memberId: string, raw: unknown) {
  const input = requestSchema.parse(raw);
  const chat = await readChatFacts(options.store, options.silo,
    input.conversationId, input.requesterEventId);
  if (chat.conversationClosed || chat.latestHuman?.id !== input.requesterEventId ||
      chat.latestHuman.authorId !== memberId) throw new ChatRefused('Requester only');
  const assistantId = z.string().parse(chat.created?.['assistantId']);
  const subject = `computer-${assistantId}`;
  const facts = await readStreamSummary(options.store, options.silo, subject,
    computerSummary, performance.now() + 10_000, takeComputer);
  if (facts.lifecycle?.event.type !== 'computer.ready') throw new Error('Computer unavailable');
  const ready = readySchema.parse(facts.lifecycle.event.data);
  if (ready.generation !== input.generation) throw new Error('Control conflict');
  const affectedTurnIds = affectedTurns(facts, memberId, input.conversationId);
  const fresh = await controlAccess(options, memberId, input, ready, chat);
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
  ready: z.infer<typeof readySchema>, chat: ChatFacts) {
  const assistantId = ready.assistantId;
  // Load access history before opening the short write check.
  const accessRequest = { memberId, conversationId: input.conversationId, relation: 'post' as const };
  await chatAccess(options, accessRequest);
  await viewAccess(options, memberId, input.conversationId);
  const teamFresh = await writePrivateSession(options, memberId, input.conversationId, false);
  const fresh = await writeChatAccess(options, accessRequest);
  fresh.include(`assistant-${assistantId}`, grantStream('shared_desktop', ready.computerId));
  const bounded = { ...options, deadline: fresh.deadline };
  const desktop = await desktopAccess(bounded, memberId, input.conversationId, ready.computerId);
  const auth = memberAuthorisation(options.binding);
  const assistantPermission = await auth.actsFor(memberId, assistantId);
  if (assistantPermission.status === 'unavailable') throw new Error('Control unavailable');
  if (!assistantPermission.allowed) throw new ChatRefused('Assistant refused');
  const desktopPermission = await auth.view(
    memberId, input.conversationId, ready.computerId, desktop.receipts);
  if (desktopPermission.status === 'unavailable') throw new Error('Control unavailable');
  if (!desktopPermission.allowed) {
    throw new ChatRefused('Desktop refused');
  }
  await teamFresh?.();
  await desktop.fresh();
  await fresh();
  await confirmRequest(options.store, options.silo, input.conversationId, chat.sequence,
    fresh.deadline);
  await desktop.fresh();
  await teamFresh?.();
  await fresh();
  return fresh;
}

async function confirmRequest(store: EventStore, silo: string, conversationId: string,
  sequence: number, deadline: number) {
  for await (const row of store.readStream(`conversation-${conversationId}`, sequence + 1, deadline)) {
    const details = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (row.event.silo !== silo || row.event.type === 'conversation.closed' ||
        (row.event.type === 'message.posted' && details['authorKind'] === 'human')) {
      throw new Error('Control conflict');
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
  throw new Error('Control conflict');
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
  if (result.status === 'unavailable') throw new Error('Control unavailable');
  if (result.status !== 'appended') throw new Error('Control conflict');
  const saved = await readEventAt(options.store, subject, result.sequence, performance.now() + 10_000);
  if (!isDeepStrictEqual(saved?.event, event)) {
    throw new Error('Control unavailable');
  }
  return { ...data, phase: 'requested' as const, position: result.sequence,
    commandId: input.commandId, requestedAt: event.time };
}
