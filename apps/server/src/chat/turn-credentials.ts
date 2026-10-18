import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import { approvalActivity, confirmDecisionAccess, decisionAuthorityFence,
  LoadedMemoryRefused, prepareLoadedMemory } from '@opencrane/models';
import { modelForTask } from '@opencrane/models/routing';
import { z } from 'zod';
import { chatHistory } from './commands.ts';
import { readChatFacts } from './chat-summary.ts';
import { privateContext } from './private-context.ts';
import { sharedContext } from './shared-context.ts';
import { creationEvent } from './private-session.ts';
import { agentSessionData } from './reports.ts';
import { requireTurnMember, TurnAdmissionRejected, turnCommand } from './turns.ts';
import type { ChatOptions } from './routes.ts';

type BridgeOptions = Pick<ChatOptions, 'silo' | 'store' | 'keys'> &
  Partial<Pick<ChatOptions, 'binding'>>;
type Tokens = Awaited<ReturnType<typeof tokenIssuer>>;
type Report = { conversationId: string; turnId: string; threadId?: string | undefined };
type ChatRows = Awaited<ReturnType<typeof chatHistory>>;

export async function releaseTurnCredentials(options: BridgeOptions,
  context: Parameters<typeof turnCommand>[1],
  tokens: Tokens | undefined, report: Report,
  binding: NonNullable<Awaited<ReturnType<typeof turnCommand>>>,
  acknowledgement: { token?: string; expiresAt?: number; model?: string;
    refused?: string; context?: unknown }) {
  try {
    const history = await turnContextFor(options, report, binding);
    await requireOpenConversation(options, report);
    if (!tokens) throw new Error('Turn issuer unavailable');
    const confirmMemory = await turnMemoryCheck(options, context, binding);
    await confirmMemory();
    await requireTurnMember(options.store, options.silo, binding.requesterId);
    const credentials = computerCredentials(options.store, tokens, options.silo);
    const turn = { ...binding, assistantId: context.assistantId,
      model: binding.model ?? modelForTask(binding.task) };
    const grant = await credentials.turn(turn);
    // Check only new activity after signing; keep full history outside the access deadline.
    await requireTurnMember(options.store, options.silo, binding.requesterId);
    await confirmMemory();
    acknowledgement.model = turn.model;
    acknowledgement.token = grant.value;
    acknowledgement.expiresAt = grant.expiresAt;
    if (history !== undefined) acknowledgement.context = history;
  } catch (error) {
    if (error instanceof TurnAdmissionRejected || error instanceof LoadedMemoryRefused) {
      acknowledgement.refused = error.message;
      return;
    }
    if (!(error instanceof TurnContextUnavailable)) throw error;
    await turnCommand(options.store, context, { ...report, status: 'failed' });
    acknowledgement.refused = error.message;
  }
}

async function requireOpenConversation(options: BridgeOptions,
  report: Report) {
  const facts = await readChatFacts(options.store, options.silo,
    report.conversationId, report.turnId);
  if (facts.conversationClosed) throw new TurnAdmissionRejected('Conversation is closed');
}

class TurnContextUnavailable extends Error {}

async function turnContextFor(options: BridgeOptions,
  report: Report,
  binding: NonNullable<Awaited<ReturnType<typeof turnCommand>>>) {
  function isMessage(row: ChatRows[number]) {
    return row.event.type === 'message.posted' && row.event.id === report.turnId;
  }
  function decrypt(data: unknown) {
    return options.keys.decrypt(options.silo, report.conversationId, data);
  }
  try {
    await requireOpenConversation(options, report);
    // Check the saved creation before choosing either reader, including on retries.
    const event = await creationEvent(options.store, options.silo,
      `conversation-${report.conversationId}`, 'conversation.created');
    const created = agentSessionData(event.data);
    const shared = 'contextKind' in created && created.contextKind === 'shared_child';
    if (shared !== (binding.sharingClass === 'shared_only')
      || (shared && binding.executionMode !== 'restricted')) {
      throw new TurnContextUnavailable('Turn context mismatch');
    }
    if (binding.executionMode !== 'restricted') return undefined;
    // Read history after admission, outside the two-second access check.
    const rows = await chatHistory(options.store, options.silo, report.conversationId);
    const message = rows.find(isMessage);
    if (!message) throw new Error('Requested message unavailable');
    if (shared) return sharedContext(rows, message, decrypt);
    return privateContext(rows, message, binding.requesterId, decrypt);
  } catch (error) {
    if (error instanceof TurnContextUnavailable || error instanceof TurnAdmissionRejected) throw error;
    const reason = binding.sharingClass === 'shared_only'
      ? 'Shared context unavailable' : 'Private context unavailable';
    throw new TurnContextUnavailable(reason, { cause: error });
  }
}

async function turnMemoryCheck(options: BridgeOptions,
  context: Parameters<typeof turnCommand>[1],
  turn: NonNullable<Awaited<ReturnType<typeof turnCommand>>>) {
  try {
    const deadline = performance.now() + 10_000;
    const activity = await approvalActivity(options.store, options.silo, context.assistantId,
      turn.conversationId, turn.turnId, deadline);
    const computerSchema = z.object({ computerId: z.string(), generation: z.int().positive() });
    const computer = computerSchema.parse(activity.computer.lifecycle?.event.data);
    if (computer.computerId !== context.computerId) throw new LoadedMemoryRefused();
    const claims = { silo: options.silo, requester: turn.requesterId,
      assistant: context.assistantId, computer: context.computerId, generation: computer.generation,
      conversation: turn.conversationId, turn: turn.turnId, thread: turn.threadId };
    const memory = await prepareLoadedMemory(options.store, options.binding, claims,
      activity.conversation, deadline);
    const authority = await decisionAuthorityFence(options.store, performance.now(), [],
      turn.requesterId, context.assistantId);
    async function confirmAccess() {
      await confirmDecisionAccess(activity, authority, false, true);
    }
    const snapshot = { include: authority.include, head: authority.head,
      deadline: authority.deadline };
    const fresh = Object.assign(confirmAccess, snapshot);
    async function confirm() {
      try {
        await memory.confirm(fresh);
      } catch {
        // Keep the closed-chat reason after abandoning a failed memory-free check.
        if (!memory.loaded) await requireOpenConversation(options, turn);
        throw new LoadedMemoryRefused();
      }
    }
    return confirm;
  } catch {
    throw new LoadedMemoryRefused();
  }
}
