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
import { sharedAdmissionAccess } from './shared-admission-access.ts';
import { history } from './actor.ts';
import { data } from './state.ts';
import { requireDescendantAllowance } from './budget-turn.ts';

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
export const admissions: SummaryKind<AdmissionSummary> = { name: 'descendant-admission', keep: 64,
  empty: emptyAdmissions, add: addAdmission,
  budget: { limit: 48 * 1024 * 1024, size: admissionSize } };

async function verifyAdmissionDecision(access: Binding,
  verifier: ReturnType<typeof tokenVerifier>, signedDecision: string) {
  const claims = await verifier.verify(signedDecision, 'delegation-admission');
  const decision = decisionSchema.parse(claims);
  const binding = decision.binding;
  if (decision.silo !== access.silo || binding.task !== 'native_descendant' ||
      claims.exp! - claims.iat! > 120 ||
      claims.jti !== descendantId(access.silo, binding) || claims.jti !== binding.delegationId) {
    throw new Error('Descendant decision refused');
  }
  return binding;
}

/** Save both admission records without granting call or spending authority. */
export async function admitDescendant(store: EventStore, access: Binding,
  verifier: ReturnType<typeof tokenVerifier>, signedDecision: string) {
  const deadline = performance.now() + 10_000;
  const binding = await verifyAdmissionDecision(access, verifier, signedDecision);
  const subject = `computer-${binding.assistantId}`;
  for (let attempt = 0; attempt < 10 && performance.now() < deadline; attempt++) {
    function take(summary: AdmissionSummary, sequence: number) {
      return { summary: structuredClone(summary), sequence };
    }
    const facts = await readStreamSummary(store, access.silo, subject, admissions, deadline, take);
    const existing = facts.summary.descendants.get(binding.delegationId);
    if (existing?.closed) {
      throw new Error('Descendant is closed');
    }
    const start = await readDelegationStart(store, binding.delegationId, deadline);
    if (existing && !isDeepStrictEqual(existing.binding, binding)) {
      throw new Error('Admission conflict');
    }
    requireRoot(facts.summary, binding);
    if (!existing) {
      requireParentAndLimits(facts.summary, binding);
    }
    const activity = await decisionActivity(store, access.silo, binding.assistantId,
      binding.conversationId, binding.rootTurnId, deadline);
    requireRootActivity(activity, binding, facts.summary.computer.lifecycle);
    const fresh = await descendantAccess(store, access, binding, activity, deadline);
    if (existing) {
      return saveDelegationStart(store, existing.start, start, fresh.deadline);
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
      await fresh();
      return saveDelegationStart(store, stored, start, fresh.deadline);
    }
    if (saved.status !== 'conflict') {
      throw new Error('Descendant admission unavailable');
    }
  }
  throw new Error('Descendant admission contention or deadline');
}

/** Recheck access to the saved model and payer before admission or a native call. */
export async function descendantAccess(store: EventStore, access: Binding, binding: Descendant,
  activity: Awaited<ReturnType<typeof decisionActivity>>, deadline: number, started?: number) {
  // Load spending history before the short access check, then read only later events.
  await requireDescendantAllowance(store, access.silo, binding, deadline);
  let confirmSharedAccess: Awaited<ReturnType<typeof sharedAdmissionAccess>> | undefined;
  if (binding.dataClass === 'shared') {
    confirmSharedAccess = await sharedAdmissionAccess(store, access.silo,
      activity.conversation, binding.requesterId, deadline);
  }
  const grants = await readDecisionGrants(store, access.silo, binding.model!, deadline);
  const subjects = [`member-${binding.requesterId}`, `assistant-${binding.assistantId}`];
  const authority = await decisionAuthorityFence(store, started ?? performance.now(), subjects,
    binding.requesterId, binding.assistantId, grants, deadline);
  async function confirmAccess() {
    while (true) {
      const activityChanged = await activity.confirm(authority.deadline, false);
      const sharedAccessChanged = await confirmSharedAccess?.(authority.deadline);
      await requireDescendantAllowance(store, access.silo, binding, authority.deadline);
      const authorityChanged = await authority();
      if (!activityChanged && !sharedAccessChanged && !authorityChanged) {
        return;
      }
    }
  }
  const limits = { include: authority.include, head: authority.head, deadline: authority.deadline };
  const fresh = Object.assign(confirmAccess, limits);
  await currentAuthority(store, access, binding.requesterId, binding.assistantId,
    binding.conversationId, 'model', binding.model!, fresh, activity.conversation, grants);
  await requireSharedPayer(store, access.silo, binding, fresh.deadline);
  if (binding.payingGroupId !== 'personal-default') {
    fresh.include(`team-${binding.payingGroupId}`);
    await groupMembership(store, access.silo, binding.requesterId, binding.payingGroupId,
      access, fresh.deadline);
  }
  await fresh();
  return fresh;
}

async function readDelegationStart(store: EventStore, delegationId: string, deadline: number,
  requireOpen = false) {
  try {
    let start: StoredEvent | undefined;
    for await (const row of store.readStream(`delegation-${delegationId}`, 1, deadline)) {
      if (!requireOpen) return row;
      // Refuse later records: this stream only starts a delegation and then ends it.
      if (start) throw new Error('Descendant is closed');
      start = row;
    }
    return start;
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid stored event') {
      // eslint-disable-next-line preserve-caught-error -- Keep stored event details out of refusals.
      throw new Error('Admission conflict');
    }
    refuseAgreementRead();
  }
}
function refuseAgreementRead(): never {
  throw new Error('Delegation agreement unavailable');
}

function delegationStartEvent(admission: StoredEvent) {
  const parsed = computerTurnStartedDataSchema.safeParse(admission.event.data);
  if (!parsed.success || parsed.data.task !== 'native_descendant') {
    throw new Error('Invalid descendant record');
  }
  // Copy only the delegation fields from the saved computer admission.
  const { task, model, providerId, bindingSequence, executionMode, ...binding } = parsed.data;
  const computerAdmission = { eventId: admission.event.id, position: admission.sequence };
  const data = { ...binding, version: 1, computerAdmission };
  const id = `delegation-start:${binding.delegationId}`;
  return { ...admission.event, id, commandId: id, subject: `delegation-${binding.delegationId}`,
    type: 'delegation.started', time: new Date().toISOString(), data };
}

async function saveDelegationStart(store: EventStore, admission: StoredEvent,
  existing: StoredEvent | undefined, deadline: number) {
  const event = delegationStartEvent(admission);
  let start = existing;
  if (!start) {
    // Require an empty stream even after NATS has forgotten a duplicate command.
    const command = { event, expectedSequence: 0, historyChecked: true as const, deadline };
    const saved = await store.append(command);
    if (saved.status !== 'appended' && saved.status !== 'conflict') {
      throw new Error('Delegation start unavailable');
    }
    start = await readDelegationStart(store, event.data.delegationId, deadline);
  }
  requireSavedAdmission(start, event);
  return { admission, start };
}

/** Read matching records only. Callers must still check root, access and spending rules. */
export async function readDescendantAgreement(store: EventStore, silo: string,
  assistantId: string, delegationId: string, deadline = performance.now() + 10_000) {
  function take(summary: AdmissionSummary) {
    return structuredClone(summary.descendants.get(delegationId));
  }
  const recorded = await readStreamSummary(store, silo, `computer-${assistantId}`,
    admissions, deadline, take).catch(refuseAgreementRead);
  if (!recorded || recorded.closed) {
    throw new Error('Descendant admission missing or closed');
  }
  const admission = recorded.start;
  const event = delegationStartEvent(admission);
  const start = await readDelegationStart(store, delegationId, deadline, true);
  requireSavedAdmission(start, event);
  return { admission, start };
}

export function requireSavedAdmission(stored: StoredEvent | undefined,
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

export function requireRootActivity(activity: Awaited<ReturnType<typeof decisionActivity>>,
  binding: Descendant, ready: StoredEvent | undefined) {
  if (activity.computer.firstClose || activity.computer.control ||
      activity.computer.lifecycle?.sequence !== ready?.sequence) {
    throw new Error('Root is not active');
  }
  let matchingSession = false;
  for (const row of activity.conversation) {
    if (row.event.type === 'conversation.closed' ||
        closesDecisionTurn(row.event, binding.rootTurnId)) {
      throw new Error('Root is not active');
    }
    if (row.event.type !== 'conversation.created') {
      continue;
    }
    const created = conversationCreatedDataSchema.parse(row.event.data);
    matchingSession = matchesRootConversation(created, binding);
  }
  if (!matchingSession) {
    throw new Error('Root conversation refused');
  }
}
function matchesRootConversation(created: z.infer<typeof conversationCreatedDataSchema>,
  binding: Descendant) {
  if (binding.dataClass === 'shared') {
    return 'contextKind' in created && created.contextKind === 'shared_child' &&
      created.assistantId === binding.assistantId &&
      created.payingGroupId === binding.payingGroupId;
  }
  return created.mode === 'agent_session' && !('contextKind' in created) &&
    created.createdBy === binding.requesterId;
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
  'payingGroupId', 'model', 'providerId', 'bindingSequence', 'executionMode',
  'sharingClass'] as const;
export function requireRoot(summary: AdmissionSummary, binding: Descendant) {
  const claimPosition = requireComputerGeneration(summary.computer, binding);
  const root = summary.computer.turns.get(binding.rootTurnId);
  const recorded = root?.firstStart;
  if (!recorded || root.firstClose || recorded.sequence < claimPosition ||
      recorded.event.source !== 'opencrane-server') {
    throw new Error('Root is not active');
  }
  const start = computerTurnStartedDataSchema.parse(recorded.event.data);
  if (start.task !== 'chat_turn' || start.threadId !== binding.rootThreadId || !start.model) {
    throw new Error('Root binding refused');
  }
  requireRootClass(start, binding);
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
function requireRootClass(start: Start, binding: Descendant) {
  const sharedRoot = start.sharingClass === 'shared_only' &&
    start.executionMode === 'restricted' && binding.dataClass === 'shared';
  const privateRoot = start.sharingClass === undefined &&
    start.executionMode === 'memory_free' && binding.dataClass === 'private';
  if (!sharedRoot && !privateRoot) {
    throw new Error('Root binding refused');
  }
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
export function requireParent(summary: AdmissionSummary, binding: Descendant) {
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

async function requireSharedPayer(store: EventStore, silo: string,
  binding: Descendant, deadline: number) {
  if (binding.dataClass !== 'shared') {
    return;
  }
  const rows = await history(store, `assistant-${binding.assistantId}`, silo, deadline);
  function isCreation(row: StoredEvent) {
    return row.event.type === 'assistant.created';
  }
  const created = rows.find(isCreation);
  if (!created || data(created.event)['kind'] !== 'team' ||
      data(created.event)['payingGroupId'] !== binding.payingGroupId) {
    throw new Error('Shared payer binding mismatch');
  }
}
