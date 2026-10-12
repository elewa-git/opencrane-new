import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { computerSummary, type ComputerSummary, type tokenVerifier } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import { computerTurnStartedDataSchema, computerTurnClosedDataSchema, conversationCreatedDataSchema,
  parseEventByType }
  from '@opencrane/events';
import { readEventAt, readStreamSummary, type EventStore, type StoredEvent, type SummaryKind }
  from '@opencrane/event-store';
import { closesDecisionTurn } from './approvals.ts';
import { decisionActivity } from './decision-activity.ts';
import { decisionAuthorityFence, currentAuthority } from './authority.ts';
import { readDecisionGrants } from './decision-grants.ts';
import { groupMembership } from './paying-group.ts';

type Start = z.infer<typeof computerTurnStartedDataSchema>;
type Descendant = Extract<Start, { task: 'native_descendant' }>;
type AdmissionSummary = { computer: ComputerSummary;
  descendants: Map<string, { start: StoredEvent; binding: Descendant; closed: boolean }> };
const decisionSchema = z.object({ typ: z.literal('descendant-admission'), silo: z.string(),
  binding: computerTurnStartedDataSchema });

export function descendantId(silo: string, binding: Pick<Descendant,
  'rootId' | 'computerId' | 'generation' | 'spawnItemId' | 'threadId'>) {
  const identity = [silo, binding.rootId, binding.computerId, binding.generation,
    binding.spawnItemId, binding.threadId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  return hash.digest('hex');
}
function emptyAdmissions(): AdmissionSummary {
  return { computer: computerSummary.empty(), descendants: new Map() };
}
function addAdmission(summary: AdmissionSummary, row: StoredEvent) {
  computerSummary.add(summary.computer, row);
  const type = row.event.type;
  if (type !== 'computer.turn_started' && type !== 'computer.turn_closed') {
    return;
  }
  const fields = computerTurnStartedDataSchema.safeParse(row.event.data);
  if (type === 'computer.turn_started' && fields.success &&
      fields.data.task === 'native_descendant') {
    if (!parseEventByType(row.event).success) {
      throw new Error('Invalid descendant record');
    }
    const previous = summary.descendants.get(fields.data.delegationId);
    if (previous) {
      if (!isDeepStrictEqual(previous.binding, fields.data)) {
        throw new Error('Admission conflict');
      }
      return;
    }
    const descendant = { start: row, binding: fields.data, closed: false };
    summary.descendants.set(fields.data.delegationId, descendant);
    return;
  }
  if (type !== 'computer.turn_closed') {
    return;
  }
  const closed = computerTurnClosedDataSchema.parse(row.event.data);
  if (closed.task !== 'native_descendant') {
    return;
  }
  if (!parseEventByType(row.event).success) {
    throw new Error('Invalid descendant record');
  }
  const { status, ...binding } = closed;
  const previous = summary.descendants.get(binding.delegationId);
  if (!previous || !isDeepStrictEqual(previous.binding, binding)) {
    throw new Error('Descendant close binding mismatch');
  }
  previous.closed = true;
}
function admissionSize(summary: AdmissionSummary) {
  return summary.computer.turns.size * 4096 + summary.descendants.size * 8192;
}
const admissions: SummaryKind<AdmissionSummary> = { name: 'descendant-admission', keep: 64,
  empty: emptyAdmissions, add: addAdmission,
  budget: { limit: 48 * 1024 * 1024, size: admissionSize } };

/** Save the computer admission without granting call or spending authority. */
export async function admitDescendant(store: EventStore, access: Binding,
  verifier: ReturnType<typeof tokenVerifier>, signedDecision: string) {
  const deadline = performance.now() + 10_000;
  const claims = await verifier.verify(signedDecision, 'delegation-admission');
  const decision = decisionSchema.parse(claims);
  const binding = decision.binding;
  if (decision.silo !== access.silo || binding.task !== 'native_descendant' ||
      claims.exp! - claims.iat! > 120 ||
      claims.jti !== descendantId(access.silo, binding) || claims.jti !== binding.delegationId) {
    throw new Error('Descendant decision refused');
  }
  const subject = `computer-${binding.assistantId}`;
  for (let attempt = 0; attempt < 10 && performance.now() < deadline; attempt++) {
    function take(summary: AdmissionSummary, sequence: number) {
      return { summary: structuredClone(summary), sequence };
    }
    const facts = await readStreamSummary(store, access.silo, subject, admissions, deadline, take);
    const existing = facts.summary.descendants.get(binding.delegationId);
    if (existing && !isDeepStrictEqual(existing.binding, binding)) {
      throw new Error('Admission conflict');
    }
    requireRoot(facts.summary, binding);
    if (!existing) {
      requireParentAndLimits(facts.summary, binding);
    }
    const activity = await decisionActivity(store, access.silo, binding.assistantId,
      binding.conversationId, binding.rootTurnId, deadline);
    requirePrivateActivity(activity, binding, facts.summary.computer.lifecycle);
    const grants = await readDecisionGrants(store, access.silo, binding.model!, deadline);
    const subjects = [`member-${binding.requesterId}`, `assistant-${binding.assistantId}`];
    const authority = await decisionAuthorityFence(store, performance.now(), subjects,
      binding.requesterId, binding.assistantId, grants);
    async function confirmAdmission() {
      while (true) {
        const activityChanged = await activity.confirm(authority.deadline, false);
        const authorityChanged = await authority();
        if (!activityChanged && !authorityChanged) {
          return;
        }
      }
    }
    const limits = { include: authority.include, head: authority.head, deadline: authority.deadline };
    const fresh = Object.assign(confirmAdmission, limits);
    await currentAuthority(store, access, binding.requesterId, binding.assistantId,
      binding.conversationId, 'model', binding.model!, fresh, activity.conversation, grants);
    if (binding.payingGroupId !== 'personal-default') {
      fresh.include(`team-${binding.payingGroupId}`);
      await groupMembership(store, access.silo, binding.requesterId, binding.payingGroupId,
        access, fresh.deadline);
    }
    await fresh();
    if (existing) {
      return existing.start;
    }
    const event = { id: binding.delegationId, commandId: binding.delegationId,
      silo: access.silo, subject, type: 'computer.turn_started', source: 'opencrane-server',
      principal: { kind: 'system' as const, id: 'opencrane-server' }, correlation: {},
      time: new Date().toISOString(), data: binding };
    // Check the same computer position on every replica. A conflict repeats every check.
    const command = { event, expectedSequence: facts.sequence, historyChecked: true as const,
      deadline: fresh.deadline };
    const saved = await store.append(command);
    if (saved.status === 'appended') {
      // Read the saved event because duplicate recovery may return another replica's admission.
      const stored = await readEventAt(store, subject, saved.sequence, deadline);
      requireSavedAdmission(stored, event);
      return stored;
    }
    if (saved.status !== 'conflict') {
      throw new Error('Descendant admission unavailable');
    }
  }
  throw new Error('Descendant admission contention or deadline');
}

function requireSavedAdmission(stored: StoredEvent | undefined,
  proposed: StoredEvent['event']): asserts stored is StoredEvent {
  if (!stored) {
    throw new Error('Descendant admission unavailable');
  }
  const saved = stored.event;
  if (!parseEventByType(saved).success || saved.id !== proposed.id ||
      saved.commandId !== proposed.commandId || saved.silo !== proposed.silo ||
      saved.subject !== proposed.subject || saved.type !== proposed.type ||
      saved.source !== proposed.source || !isDeepStrictEqual(saved.principal, proposed.principal) ||
      !isDeepStrictEqual(saved.data, proposed.data)) {
    throw new Error('Admission conflict');
  }
}

function requirePrivateActivity(activity: Awaited<ReturnType<typeof decisionActivity>>,
  binding: Descendant, ready: StoredEvent | undefined) {
  if (activity.computer.firstClose || activity.computer.control ||
      activity.computer.lifecycle?.sequence !== ready?.sequence) {
    throw new Error('Root is not active');
  }
  let privateSession = false;
  for (const row of activity.conversation) {
    if (row.event.type === 'conversation.closed' ||
        closesDecisionTurn(row.event, binding.rootTurnId)) {
      throw new Error('Root is not active');
    }
    if (row.event.type !== 'conversation.created') {
      continue;
    }
    const created = conversationCreatedDataSchema.parse(row.event.data);
    privateSession = created.mode === 'agent_session' && !('contextKind' in created) &&
      created.createdBy === binding.requesterId;
  }
  if (!privateSession) {
    throw new Error('Private root required');
  }
}
function requireComputerGeneration(computer: ComputerSummary, binding: Descendant) {
  const claim = computer.claim;
  const ready = computer.lifecycle;
  if (computer.control || ready?.event.type !== 'computer.ready' || !claim) {
    throw new Error('Computer is not ready');
  }
  const identity = z.object({ computerId: z.string(), generation: z.number() });
  const claimed = identity.parse(claim.event.data);
  const current = identity.parse(ready.event.data);
  if (claimed.computerId !== binding.computerId || current.computerId !== binding.computerId ||
      claimed.generation !== binding.generation || current.generation !== binding.generation) {
    throw new Error('Computer generation refused');
  }
  return claim.sequence;
}
const rootFields = ['assistantId', 'computerId', 'conversationId', 'requesterId',
  'payingGroupId', 'model', 'providerId', 'bindingSequence', 'executionMode'] as const;
function requireRoot(summary: AdmissionSummary, binding: Descendant) {
  const claimPosition = requireComputerGeneration(summary.computer, binding);
  const root = summary.computer.turns.get(binding.rootTurnId);
  const recorded = root?.firstStart;
  if (!recorded || root.firstClose || recorded.sequence < claimPosition ||
      recorded.event.source !== 'opencrane-server') {
    throw new Error('Root is not active');
  }
  const start = computerTurnStartedDataSchema.parse(recorded.event.data);
  if (start.task !== 'chat_turn' || start.threadId !== binding.rootThreadId || !start.model ||
      start.executionMode !== 'memory_free' || binding.dataClass !== 'private') {
    throw new Error('Root binding refused');
  }
  for (const field of rootFields) {
    if (start[field] !== binding[field]) {
      throw new Error('Root binding refused');
    }
  }
  // Require a saved model choice. Older root records cannot supply an immutable maximum.
  const maximum = { models: [start.model], tools: [], resources: [], operations: [],
    destinations: [], connectionIds: [], profileIds: [] };
  requireNarrowScopes(binding.scopes, maximum);
}
const scopeFields = ['models', 'tools', 'resources', 'operations', 'destinations',
  'connectionIds', 'profileIds'] as const;
function requireNarrowScopes(scopes: Descendant['scopes'], maximum: Descendant['scopes']) {
  for (const field of scopeFields) {
    for (const value of scopes[field]) {
      if (!maximum[field].includes(value)) {
        throw new Error('Descendant scope refused');
      }
    }
  }
}
const parentFields = [...rootFields, 'rootId', 'rootTurnId', 'rootThreadId',
  'generation', 'dataClass'] as const;
function requireParent(summary: AdmissionSummary, binding: Descendant) {
  if (!binding.parentDelegationId) {
    if (binding.parentTurnId !== binding.rootTurnId ||
        binding.parentThreadId !== binding.rootThreadId) {
      throw new Error('Parent refused');
    }
    return;
  }
  const parent = summary.descendants.get(binding.parentDelegationId);
  if (!parent || parent.closed || parent.binding.parentDelegationId ||
      parent.binding.turnId !== binding.parentTurnId ||
      parent.binding.threadId !== binding.parentThreadId) {
    throw new Error('Parent refused');
  }
  for (const field of parentFields) {
    if (parent.binding[field] !== binding[field]) {
      throw new Error('Parent refused');
    }
  }
  requireNarrowScopes(binding.scopes, parent.binding.scopes);
}
function requireNewBinding(previous: Descendant, binding: Descendant) {
  if (previous.threadId === binding.threadId || previous.turnId === binding.turnId ||
      previous.spawnItemId === binding.spawnItemId) {
    throw new Error('Thread or spawn already bound');
  }
  if (previous.rootTurnId === binding.rootTurnId && previous.rootId !== binding.rootId) {
    throw new Error('Root identity conflict');
  }
  if (previous.rootId === binding.rootId && previous.rootTurnId !== binding.rootTurnId) {
    throw new Error('Root identity conflict');
  }
}
function requireParentAndLimits(summary: AdmissionSummary, binding: Descendant) {
  requireParent(summary, binding);
  let total = 0;
  let active = 0;
  let siblings = 0;
  if (summary.computer.turns.has(binding.turnId) || summary.computer.threads.has(binding.threadId)) {
    throw new Error('Thread or turn already bound');
  }
  for (const task of summary.descendants.values()) {
    const previous = task.binding;
    requireNewBinding(previous, binding);
    if (previous.rootId !== binding.rootId) {
      continue;
    }
    total++;
    if (!task.closed) {
      active++;
    }
    if (previous.parentTurnId === binding.parentTurnId) {
      siblings++;
    }
  }
  if (total >= 8 || active >= 4 || siblings >= 4) {
    throw new Error('Descendant limit reached');
  }
}
