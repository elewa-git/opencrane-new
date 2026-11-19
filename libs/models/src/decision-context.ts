import { sha256HexOfJson } from '@opencrane/events/digest';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { sessionConfiguration } from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { BudgetActor } from './actor.ts';
import { AuthorityRefused, authorityHistoryReader, currentAuthority,
  type authorityFence } from './authority.ts';
import type { DecisionGrants } from './decision-grants.ts';
import { legacyTurnSchema, parseTurnToken } from './decision-turn-token.ts';
import { groupMembership } from './paying-group.ts';
import { ModelRequestRefused as RequestRefused, data, priceTableId,
  type ModelCall } from './state.ts';

const id = legacyTurnSchema.shape.assistant;
const computerSchema = z.object({ silo: id, assistant: id, exp: z.int(), iat: z.int(),
  typ: z.literal('computer'), computer: id, generation: z.int().nonnegative() });

export type CheckedDecisionCredentials = { computer: unknown; turn: unknown; sequence: number };
export function decisionIdentity(checked: CheckedDecisionCredentials) {
  const computer = computerSchema.parse(checked.computer);
  const turnToken = parseTurnToken(checked.turn);
  return { computer, turnToken, liveSequence: checked.sequence };
}
export type DecisionIdentity = ReturnType<typeof decisionIdentity>;

export type DecisionContextAccess = {
  resourceType: string;
  resourceId: string;
  fresh: Awaited<ReturnType<typeof authorityFence>>;
  conversation: StoredEvent[];
  turn: StoredEvent;
  grants?: DecisionGrants | undefined;
};

export async function decisionContext(actor: BudgetActor, binding: Binding,
  identity: DecisionIdentity, access: DecisionContextAccess): Promise<ModelCall> {
  const { computer, turnToken, liveSequence } = identity;
  const { fresh, conversation, turn, resourceType, resourceId, grants } = access;
  const permission = await memberAuthorisation(binding).check(turnToken.requester, 'member');
  if (binding.silo !== actor.silo) throw new AuthorityRefused('Membership unavailable or refused');
  if (permission.status === 'unavailable') throw new Error('Current authority unavailable');
  if (!permission.allowed) throw new AuthorityRefused('Membership unavailable or refused');
  const readAuthorityHistory = authorityHistoryReader(actor.store, fresh);
  const assistantRead = readAuthorityHistory(`assistant-${computer.assistant}`);
  const authorityRead = currentAuthority(actor.store, binding, turnToken.requester,
    computer.assistant, turnToken.conversation, resourceType, resourceId, fresh, conversation,
    grants, undefined, readAuthorityHistory);
  const [assistants, authority] = await Promise.all([assistantRead, authorityRead]);
  const assistant = assistants.find(isAssistantCreated);
  if (!assistant) throw new Error('Assistant refused');
  const created = conversation.find(isConversationCreated);
  if (!created || data(created.event)['assistantId'] !== computer.assistant ||
      conversation.some(isConversationClosed)) throw new Error('Conversation refused');
  const payingGroupId = requirePayingGroupId(turn);
  if (data(assistant.event)['kind'] === 'team') {
    const createdData = data(created.event);
    const sharedChild = createdData['contextKind'] === 'shared_child';
    if (!sharedChild && createdData['createdBy'] !== turnToken.requester) {
      throw new Error('Private requester refused');
    }
    requireSessionPayer(assistant, created, payingGroupId);
    fresh.include(`team-${payingGroupId}`);
    await groupMembership(
      actor.store, actor.silo, turnToken.requester, payingGroupId, binding, fresh.deadline);
  }
  const facts = [computer, turnToken, assistant.sequence, liveSequence,
    turn.sequence, permission.allowed, authority, payingGroupId];
  const contextDigest = digestContext(facts);
  return { model: turnToken.model, payingGroupId, priceTableId,
    computerId: computer.computer, generation: computer.generation,
    assistantId: computer.assistant,
    requesterId: turnToken.requester, conversationId: turnToken.conversation,
    turnId: turnToken.turn, threadId: turnToken.thread, contextDigest };
}

function requirePayingGroupId(turn: StoredEvent) {
  const payingGroupId = data(turn.event)['payingGroupId'];
  if (typeof payingGroupId !== 'string') {
    throw new RequestRefused(
      'Paying group unavailable; ask an Owner or Admin to configure work attribution');
  }
  return payingGroupId;
}

function requireSessionPayer(assistant: StoredEvent, created: StoredEvent, payingGroupId: string) {
  const assistantData = data(assistant.event);
  const createdData = data(created.event);
  const configuration = sessionConfiguration({
    conversation: { payingGroupId: optionalString(createdData['payingGroupId']) },
    assistantKind: optionalString(assistantData['kind']),
    assistantPayingGroupId: optionalString(assistantData['payingGroupId']),
    memoryEnabled: false,
  });
  if (configuration.assistantPayerRequired &&
      (!configuration.payerMatchesAssistant || createdData['payingGroupId'] !== payingGroupId)) {
    throw new RequestRefused('Shared payer binding mismatch');
  }
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : undefined;
}
function isAssistantCreated(row: StoredEvent) {
  return row.event.type === 'assistant.created';
}
function isConversationCreated(row: StoredEvent) {
  return row.event.type === 'conversation.created';
}
function isConversationClosed(row: StoredEvent) {
  return row.event.type === 'conversation.closed';
}

export function digestContext(facts: unknown) {
  return sha256HexOfJson(facts);
}
