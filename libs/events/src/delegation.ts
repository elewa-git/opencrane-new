import { z } from 'zod';
import type { EventEnvelope } from './envelope.ts';

const id = z.string().min(1);
const references = z.array(id).max(32);
const eventReference = z.object({ eventId: id, position: z.int().positive() }).strict();
const scopes = z.object({
  models: references, tools: references, resources: references, operations: references,
  destinations: references, connectionIds: references, profileIds: references,
}).strict();

export const nativeDelegationBindingSchema = z.object({
  delegationId: id, rootId: id, rootTurnId: id, rootThreadId: id,
  assistantId: id, computerId: id, generation: z.int().positive(),
  conversationId: id, requesterId: id, payingGroupId: id,
  parentDelegationId: id.optional(), parentTurnId: id, parentThreadId: id,
  turnId: id, threadId: id, spawnItemId: id,
  dataClass: z.enum(['shared', 'private']), sharingClass: z.literal('shared_only').optional(), scopes,
}).strict().refine(hasDistinctDelegationChild, 'A child cannot be its own parent or root');

export function hasDistinctDelegationChild(data: {
  delegationId: string; parentDelegationId?: string | undefined;
  parentTurnId: string; turnId: string; parentThreadId: string; threadId: string;
  rootTurnId: string; rootThreadId: string;
}): boolean {
  return data.parentDelegationId !== data.delegationId && data.parentTurnId !== data.turnId &&
    data.parentThreadId !== data.threadId && data.rootTurnId !== data.turnId &&
    data.rootThreadId !== data.threadId;
}

const modernStarted = nativeDelegationBindingSchema.safeExtend({
  version: z.literal(1), computerAdmission: eventReference,
});
const legacyStarted = z.object({
  delegationId: id, parentComputerId: id, childComputerId: id, rootBudgetId: id,
}).strict();
export const delegationStartedDataSchema = z.union([modernStarted, legacyStarted]);

const modernCompleted = z.object({
  version: z.literal(1), delegationId: id,
  outcome: z.enum(['completed', 'failed', 'cancelled']),
  reason: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u).optional(),
  terminalEvidence: eventReference, resultReference: eventReference.optional(),
}).strict();
const legacyCompleted = z.object({
  delegationId: id, outcome: z.enum(['success', 'failure']),
}).strict();
export const delegationCompletedDataSchema = z.union([modernCompleted, legacyCompleted]);

const versionedIdentity = z.object({ version: z.literal(1), delegationId: id });
const nativeIdentity = z.object({ task: z.literal('native_descendant'), assistantId: id });
export function checkDelegationEvent(event: EventEnvelope, context: z.RefinementCtx): void {
  let expectedSubject: string;
  if (event.type.startsWith('delegation.')) {
    const data = versionedIdentity.safeParse(event.data);
    if (!data.success) return;
    expectedSubject = `delegation-${data.data.delegationId}`;
  } else if (event.type === 'computer.turn_started' || event.type === 'computer.turn_closed') {
    const data = nativeIdentity.safeParse(event.data);
    if (!data.success) return;
    expectedSubject = `computer-${data.data.assistantId}`;
  } else {
    return;
  }
  if (event.subject !== expectedSubject ||
      event.source !== 'opencrane-server' || event.principal?.kind !== 'system' ||
      event.principal.id !== 'opencrane-server') {
    context.addIssue({ code: 'custom', message: 'Modern delegation requires its server stream' });
  }
}

export const modernDelegationExample = {
  version: 1, delegationId: 'child', rootId: 'root', rootTurnId: 'root-turn',
  rootThreadId: 'root-thread', assistantId: 'assistant', computerId: 'computer', generation: 1,
  conversationId: 'chat', requesterId: 'alice', payingGroupId: 'sales',
  parentTurnId: 'root-turn', parentThreadId: 'root-thread', turnId: 'child-turn',
  threadId: 'child-thread', spawnItemId: 'spawn', dataClass: 'private',
  scopes: { models: ['gpt-6-luna'], tools: [], resources: [], operations: [], destinations: [],
    connectionIds: [], profileIds: [] },
  computerAdmission: { eventId: 'admission', position: 1 },
} satisfies z.infer<typeof modernStarted>;
