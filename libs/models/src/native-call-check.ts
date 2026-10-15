import { isDeepStrictEqual } from 'node:util';
import { readStreamSummary, type EventStore } from '@opencrane/event-store';
import { computerTurnStartedDataSchema } from '@opencrane/events';
import { admissions, readDescendantAgreement, requireParent, requireRoot,
  requireRootActivity, requireSavedAdmission } from './descendant-admission.ts';
import { decisionActivity } from './decision-activity.ts';
import { requireCurrentComputer, requireTurnDelegation } from './turn-binding-check.ts';
import type { parseTurnToken } from './decision-turn-token.ts';

type Computer = { assistant: string; computer: string; generation: number };
type SignedTurn = ReturnType<typeof parseTurnToken>;
type Start = ReturnType<typeof computerTurnStartedDataSchema.parse>;
type Descendant = Extract<Start, { task: 'native_descendant' }>;

export class NativeDelegationDisabled extends Error {
  constructor() {
    super('Native delegation is disabled');
  }
}

function requireClaims(computer: Computer, turn: SignedTurn, binding: Descendant) {
  const expected = { turn: binding.turnId, thread: binding.threadId,
    conversation: binding.conversationId, requester: binding.requesterId,
    assistant: binding.assistantId, task: binding.task, model: binding.model,
    providerId: binding.providerId, bindingSequence: binding.bindingSequence,
    sharingClass: binding.sharingClass };
  const fields = ['turn', 'thread', 'conversation', 'requester', 'assistant', 'task',
    'model', 'providerId', 'bindingSequence', 'sharingClass'] as const;
  for (const field of fields) {
    if (turn[field] !== expected[field]) {
      throw new Error('Descendant claim refused');
    }
  }
  if (computer.assistant !== binding.assistantId || computer.computer !== binding.computerId ||
      computer.generation !== binding.generation) {
    throw new Error('Descendant claim refused');
  }
  if (!binding.scopes.models.includes(turn.model)) {
    throw new Error('Descendant model scope refused');
  }
}

/** Check saved identity and root activity without granting permission or holding money. */
export async function checkNativeCall(store: EventStore, silo: string, computer: Computer,
  turn: SignedTurn, computerSequence: number, deadline: number): Promise<void> {
  requireTurnDelegation(turn);
  if (turn.task !== 'native_descendant') return;
  const delegationId = turn.delegation.at(-1)!;
  const agreement = await readDescendantAgreement(store, silo, computer.assistant,
    delegationId, deadline);
  const binding = computerTurnStartedDataSchema.parse(agreement.admission.event.data);
  if (binding.task !== 'native_descendant') {
    throw new Error('Descendant record refused');
  }
  requireClaims(computer, turn, binding);
  function take(summary: Parameters<typeof requireRoot>[0]) {
    return structuredClone(summary);
  }
  const summary = await readStreamSummary(store, silo, `computer-${computer.assistant}`,
    admissions, deadline, take);
  const saved = summary.descendants.get(delegationId);
  if (!saved || saved.closed) throw new Error('Descendant record refused');
  requireSavedAdmission(agreement.admission, saved.start.event);
  requireRoot(summary, binding);
  requireParent(summary, binding);
  const chain = [binding.requesterId];
  if (binding.parentDelegationId) {
    await readDescendantAgreement(store, silo, computer.assistant,
      binding.parentDelegationId, deadline);
    chain.push(binding.parentDelegationId);
  }
  chain.push(binding.delegationId);
  if (!isDeepStrictEqual(turn.delegation, chain)) {
    throw new Error('Descendant ancestry refused');
  }
  // Read the root's activity, because a child cannot outlive its root turn.
  const activity = await decisionActivity(store, silo, binding.assistantId,
    binding.conversationId, binding.rootTurnId, deadline);
  requireCurrentComputer(activity.computer.lifecycle, computerSequence);
  requireRootActivity(activity, binding, summary.computer.lifecycle);
  await activity.confirm(deadline, false);
  // Keep shared calls refused until their current participation checks are connected.
  if (binding.dataClass !== 'private') throw new Error('Shared descendant calls refused');
  throw new NativeDelegationDisabled();
}
