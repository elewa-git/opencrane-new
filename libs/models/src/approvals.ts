import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toolApprovalRequestedDataSchema, toolDispatchRecordedDataSchema,
  approvalDecidedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { AppendCommand, EventStore, StoredEvent } from '@opencrane/event-store';
import { isToolPolicyAvailable, readEvents } from '@opencrane/projections';
import { approvalReviewSchema, type ApprovalCard } from '@opencrane/protocol';
import { envelope, history } from './actor.ts';
import { readToolPolicy } from './tool-policy.ts';
import type { JsonValue } from '@opencrane/events/lossless-json';
import type { mcpPolicy } from './mcp.ts';

export interface ReviewKeys {
  encrypt(silo: string, conversation: string, text: string): { ciphertext: string; keyId: string };
  decrypt(silo: string, conversation: string, value: unknown): string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const approvalDecisionStates = { approved: 'approved', rejected: 'denied' } as const;
type Request = z.infer<typeof toolApprovalRequestedDataSchema>;
type Policy = Awaited<ReturnType<typeof mcpPolicy>> & { dispatchBinding?: string };
type Binding = Pick<Request, 'requesterId' | 'conversationId' | 'turnId' | 'assistantId' | 'serverId' | 'connectionId'>;
type FreshAuthority = (() => Promise<void>) & { deadline?: number };
interface ApprovalReadOptions {
  requesterOnly?: boolean;
  fromSequence?: number;
  approvalRows?: StoredEvent[];
  now?: Date;
  deadline?: number;
  conversationRows?: StoredEvent[] | undefined;
}

// Build the id before writing so a mismatched retry cannot create another card.
function prepareApproval(silo: string, bound: Binding,
  policy: Policy) {
  const args = policy.args.value;
  const review = policy.review;
  if (!review || !(args instanceof Map) || !policy.revision) {
    throw new Error('Review unavailable');
  }
  const reviewedFields = new Set(review.fields);
  if (reviewedFields.size !== review.fields.length || !reviewedFields.has(review.targetArgument)) {
    throw new Error('Unreviewed arguments');
  }
  for (const field of args.keys()) {
    if (!reviewedFields.has(field)) throw new Error('Unreviewed arguments');
  }
  const missingFields: string[] = [];
  for (const field of review.fields) {
    const argument = args.get(field);
    if (!argument) {
      missingFields.push(field);
      continue;
    }
    if (argument.kind === 'object' || argument.kind === 'array') {
      throw new Error('Unreviewed arguments');
    }
  }
  const targetText = reviewTarget(args, review.targetArgument, missingFields);
  const reviewDetails = {
    action: review.action,
    tool: policy.name,
    target: targetText,
    data: policy.args.canonical,
    destination: policy.destination,
    account: 'No account · profile: none (credential-free connection)',
    consequence: review.consequence,
  };
  const details = approvalReviewSchema.parse(reviewDetails);
  const binding = {
    ...bound,
    tool: policy.name,
    toolRevision: policy.revision,
    schemaDigest: policy.schemaDigest,
    connectionId: bound.connectionId,
    profile: 'none',
    policySequence: policy.policy.policyRevision,
    ...(policy.dispatchBinding ? { dispatchBinding: policy.dispatchBinding } : {}),
    digestVersion: 'lossless-json-v1' as const,
    argumentsDigest: hash(policy.args.canonical),
  };
  const text = JSON.stringify(details);
  const reviewDigest = hash(text);
  const approvalId = hash(JSON.stringify([silo, binding, reviewDigest]));
  return { binding, text, reviewDigest, approvalId, stepUp: review.stepUp, missingFields };
}

function reviewTarget(args: Map<string, JsonValue>, targetArgument: string, missingFields: string[]) {
  const target = args.get(targetArgument);
  let targetText: unknown = target?.canonical ?? '';
  if (target?.kind === 'string') targetText = target.value;
  if (targetText === '' && !missingFields.includes(targetArgument)) {
    missingFields.push(targetArgument);
  }
  return targetText;
}

// Reuse the same request so a retry cannot reopen an ended approval.
async function askApproval(store: EventStore, silo: string, bound: Binding,
  policy: Policy, keys: ReviewKeys,
  now: Date, deadline: number, prepared: ReturnType<typeof prepareApproval>,
  conversationRows?: StoredEvent[]) {
  const { binding, text, reviewDigest, approvalId, stepUp, missingFields } = prepared;
  const subject = `approval-${approvalId}`;
  if (!(await history(store, subject, silo, deadline)).length) {
    const lifetime = approvalLifetime(policy.waitLimited);
    const expiresAt = new Date(now.getTime() + lifetime).toISOString();
    const encrypted = keys.encrypt(silo, bound.conversationId, text);
    const request = { ...binding, approvalId, missingFields, expiresAt, stepUp,
      ...encrypted, reviewDigest };
    const result = await store.append({ event: envelope(silo, subject, 'tool.approval_requested', request, `request-${approvalId}`), expectedSequence: 0 });
    if (result.status !== 'appended' && result.status !== 'conflict') throw new Error('Approval persistence unavailable');
  }
  const readOptions = { now, deadline, conversationRows };
  const current = await readApproval(store, silo, approvalId, readOptions);
  if (hash(keys.decrypt(silo, bound.conversationId, current.request)) !== reviewDigest) throw new Error('Review unavailable');
  return current;
}

export async function readApproval(store: EventStore, silo: string, approvalId: string,
  options: ApprovalReadOptions = {}):
  Promise<{ request: Request; state: ApprovalCard['state']; sequence: number;
    requestPosition: number; conversationPosition: number; canRetry: boolean }> {
  const now = options.now ?? new Date();
  const deadline = options.deadline ?? Infinity;
  const rows = await history(store, `approval-${approvalId}`, silo, deadline);
  const request = toolApprovalRequestedDataSchema.parse(rows[0]?.event.data);
  let state: ApprovalCard['state'] = 'requested';
  let permitId: string | undefined;
  for (const { event } of rows.slice(1)) {
    if (event.type === 'approval.decided') {
      const { decision } = approvalDecidedDataSchema.parse(event.data);
      state = approvalDecisionStates[decision];
    }
    if (event.type === 'approval.used') {
      state = 'outcome_unknown';
      permitId = z.object({ permitId: z.string() }).parse(event.data).permitId;
    }
    if (event.type === 'approval.retry_requested') state = 'approved';
    if (event.type === 'approval.expired') state = 'expired';
    if (event.type === 'approval.cancelled') state = 'cancelled';
  }
  const sequence = rows.at(-1)!.sequence;
  let conversationPosition = 0;
  const canRetry = await verifiedRetry(store, silo, approvalId, permitId, deadline, state);
  const needsCurrentChecks = canRetry || ['requested', 'approved'].includes(state);
  if (needsCurrentChecks) {
    const checked = await invalidated(store, silo, request, deadline, options.conversationRows);
    conversationPosition = checked.conversationPosition;
    const terminal = approvalTerminalState(checked.closed, request.expiresAt, now);
    if (terminal) {
      const result = await store.append({ event: envelope(silo, `approval-${approvalId}`, `approval.${terminal}`, { approvalId }), expectedSequence: sequence });
      if (result.status === 'unavailable') throw new Error('Approval persistence unavailable');
      const readOptions = { now, deadline, conversationRows: options.conversationRows };
      return readApproval(store, silo, approvalId, readOptions);
    }
  }
  return { request, state, sequence, requestPosition: rows[0]!.sequence, conversationPosition, canRetry };
}

async function verifiedRetry(store: EventStore, silo: string, approvalId: string,
  permitId: string | undefined, deadline: number, state: ApprovalCard['state']) {
  let canRetry = false;
  if (state === 'outcome_unknown' && permitId) {
    const dispatchRows = await history(store, `decision-${permitId}`, silo, deadline);
    const observation = dispatchRows.at(-1)?.event;
    if (observation?.type === 'tool.dispatch_recorded') {
      const dispatch = toolDispatchRecordedDataSchema.parse(observation.data);
      canRetry = dispatch.approvalId === approvalId && dispatch.requestId === permitId &&
        dispatch.outcome === 'not_dispatched' && dispatch.evidence === 'connection_refused';
    }
  }
  return canRetry;
}

function approvalTerminalState(closed: boolean, expiresAt: string, now: Date) {
  if (closed) {
    return 'cancelled' as const;
  }
  if (Date.parse(expiresAt) <= now.getTime()) {
    return 'expired' as const;
  }
  return undefined;
}

export function invalidatesApproval(event: EventEnvelope, turnId: string) {
  if (['conversation.closed', 'message.posted', 'agent.turn_started'].includes(event.type)) {
    return true;
  }
  return closesDecisionTurn(event, turnId);
}

export function closesDecisionTurn(event: EventEnvelope, turnId: string) {
  const closesTurn = [
    'agent.turn_completed', 'agent.turn_failed', 'agent.turn_stop_requested',
  ].includes(event.type);
  return closesTurn && z.object({ turnId: z.string() }).parse(event.data).turnId === turnId;
}

async function invalidated(store: EventStore, silo: string, request: Request, deadline: number,
  conversationRows?: StoredEvent[]) {
  const rows = conversationRows ?? await history(
    store, `conversation-${request.conversationId}`, silo, deadline);
  function startsBoundTurn(row: StoredEvent) {
    return row.event.type === 'agent.turn_started' &&
      z.object({ turnId: z.string() }).parse(row.event.data).turnId === request.turnId;
  }
  function invalidatesBoundApproval(row: StoredEvent) {
    return invalidatesApproval(row.event, request.turnId);
  }
  const start = rows.findIndex(startsBoundTurn);
  const later = rows.slice(start + 1);
  const conversationPosition = rows.at(-1)?.sequence ?? 0;
  let closed = start < 0 || later.some(invalidatesBoundApproval);
  if (!closed) closed = await approvalPolicyChanged(store, silo, request, deadline);
  return { closed, conversationPosition };
}

async function approvalPolicyChanged(store: EventStore, silo: string, request: Request,
  deadline: number) {
  const policy = await readToolPolicy(store, silo, request.serverId, deadline);
  let published = policy.published;
  if (policy.publication) published = policy.configurationObservation !== undefined;
  // Keep consent tied to the reviewed publication, without requiring a running gateway.
  const currentPublication = { ...policy, published };
  const available = isToolPolicyAvailable(currentPublication);
  return !available || policy.policyRevision !== request.policySequence ||
    policy.connectionId !== request.connectionId;
}

async function approvalChangedSinceRead(store: EventStore, silo: string,
  current: Awaited<ReturnType<typeof readApproval>>, deadline: number) {
  const request = current.request;
  const subjects = [`conversation-${request.conversationId}`,
    `participation-${request.conversationId}`];
  // Resume both streams from the saved global position. Do not reread messages.
  const fromSequence = current.conversationPosition + 1;
  for (const subject of subjects) {
    for await (const row of store.readStream(subject, fromSequence, deadline)) {
      if (row.event.silo !== silo) throw new Error('Wrong silo');
      if (invalidatesApproval(row.event, request.turnId)) return true;
    }
  }
  return approvalPolicyChanged(store, silo, request, deadline);
}

function approvalActionRefusal(current: Awaited<ReturnType<typeof readApproval>>,
  decision: 'approved' | 'rejected' | 'retry', recentAuth: boolean) {
  const retry = decision === 'retry';
  if (retry && !current.canRetry) return 'conflict' as const;
  if (!retry && current.state !== 'requested') return 'conflict' as const;
  if (decision !== 'rejected' && current.request.missingFields?.length) {
    return 'conflict' as const;
  }
  if (decision !== 'rejected' && current.request.stepUp && !recentAuth) {
    return 'step_up_required' as const;
  }
  return undefined;
}

// Reuse checked command facts and read only later conversation changes during the short check.
export async function decideApproval(store: EventStore, silo: string, approvalId: string,
  memberId: string, decision: 'approved' | 'rejected' | 'retry', recentAuth: boolean,
  fresh: FreshAuthority, current: Awaited<ReturnType<typeof readApproval>>, now = new Date()) {
  const beganAt = performance.now();
  if (current.request.approvalId !== approvalId || current.request.requesterId !== memberId) {
    throw new Error('Requester only');
  }
  const retry = decision === 'retry';
  const refusal = approvalActionRefusal(current, decision, recentAuth);
  if (refusal) return { status: refusal };
  const deadline = fresh.deadline ?? Infinity;
  if (await approvalChangedSinceRead(store, silo, current, deadline)) {
    return { status: 'conflict' } as const;
  }
  await fresh();
  if (await approvalChangedSinceRead(store, silo, current, deadline)) {
    return { status: 'conflict' } as const;
  }
  const checkedAt = new Date(now.getTime() + performance.now() - beganAt);
  if (Date.parse(current.request.expiresAt) <= checkedAt.getTime()) {
    const event = envelope(silo, `approval-${approvalId}`, 'approval.expired', { approvalId });
    const command: AppendCommand = { event, expectedSequence: current.sequence };
    if (Number.isFinite(deadline)) command.deadline = deadline;
    const result = await store.append(command);
    if (result.status === 'unavailable') throw new Error('Approval persistence unavailable');
    return { status: 'conflict' } as const;
  }
  let type = 'approval.decided';
  let data: unknown = { approvalId, decidedBy: memberId, decision };
  if (retry) {
    type = 'approval.retry_requested';
    data = { approvalId };
  }
  const event = {
    ...envelope(silo, `approval-${approvalId}`, type, data),
    principal: { kind: 'human', id: memberId }, source: 'opencrane-server',
  };
  const command: AppendCommand = { event, expectedSequence: current.sequence };
  if (Number.isFinite(deadline)) command.deadline = deadline;
  return store.append(command);
}

async function consumeApproval(store: EventStore, silo: string, current: Awaited<ReturnType<typeof readApproval>>, permitId: string, fresh: () => Promise<void>, now: () => Date) {
  if (current.state !== 'approved' || current.request.missingFields?.length) return false;
  await fresh(); // Fence first; the single-use append is the last authority acquisition.
  if (Date.parse(current.request.expiresAt) <= now().getTime()) return false;
  const approvalId = current.request.approvalId;
  return (await store.append({ event: envelope(silo, `approval-${approvalId}`, 'approval.used', { approvalId, permitId }), expectedSequence: current.sequence })).status === 'appended';
}

export async function approvalCards(store: EventStore, silo: string, conversationId: string,
  memberId: string, keys: ReviewKeys, options: ApprovalReadOptions = {}): Promise<ApprovalCard[]> {
  const now = options.now ?? new Date();
  const deadline = options.deadline ?? Infinity;
  const readOptions = { now, deadline };
  const ids: string[] = [];
  let rows: Iterable<StoredEvent> | AsyncIterable<StoredEvent>;
  if (options.approvalRows) {
    rows = options.approvalRows;
  } else {
    // Capture one head so new requests cannot change this read while it is running.
    const head = await store.head(undefined, deadline);
    let signal: AbortSignal | undefined;
    if (Number.isFinite(deadline)) {
      const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
      signal = AbortSignal.timeout(remaining);
    }
    rows = readEvents(store, options.fromSequence ?? 1, head, signal);
  }
  for await (const { event } of rows) {
    if (event.silo !== silo || event.type !== 'tool.approval_requested') continue;
    const request = toolApprovalRequestedDataSchema.parse(event.data);
    // Keep other people's reviews encrypted when reading a shared child.
    if (options.requesterOnly && request.requesterId !== memberId) continue;
    if (request.conversationId === conversationId) ids.push(request.approvalId);
  }
  const cards: ApprovalCard[] = [];
  for (const id of ids) {
    const { request, state, canRetry } = await readApproval(store, silo, id, readOptions);
    const text = keys.decrypt(silo, conversationId, request);
    if (hash(text) !== request.reviewDigest) throw new Error('Review digest mismatch');
    const card = approvalCard(request, state, memberId, text, canRetry);
    cards.push(card);
  }
  return cards;
}

function approvalCard(request: Request, state: ApprovalCard['state'], memberId: string,
  text: string, canRetry: boolean): ApprovalCard {
  const canDeny = memberId === request.requesterId && state === 'requested';
  const missingFields = request.missingFields ?? [];
  const canApprove = canDeny && missingFields.length === 0;
  const review = approvalReviewSchema.parse(JSON.parse(text));
  const card = { canApprove, canDeny, canRetry: canRetry && memberId === request.requesterId,
    missingFields, approvalId: request.approvalId, conversationId: request.conversationId,
    requesterId: request.requesterId,
    expiresAt: request.expiresAt, state, stepUp: request.stepUp, canDecide: canApprove, review };
  return card;
}

export async function approvalDecision(store: EventStore, silo: string, bound: Binding,
  policy: Policy, keys: ReviewKeys | undefined,
  now: () => Date, fresh: FreshAuthority, requestId: string, conversationRows?: StoredEvent[]) {
  if (policy.expectedApproval && policy.outcome !== 'ask') {
    return { outcome: 'deny' as const, reason: 'approval_mismatch', approvalId: undefined };
  }
  if (policy.outcome !== 'ask' || !policy.review || !keys) return { outcome: policy.outcome, reason: policy.reason, approvalId: undefined };
  await fresh();
  const deadline = fresh.deadline ?? Infinity;
  const prepared = prepareApproval(silo, bound, policy);
  if (policy.expectedApproval && policy.expectedApproval !== prepared.approvalId) {
    return { outcome: 'deny' as const, reason: 'approval_mismatch',
      approvalId: undefined };
  }
  const approval = await askApproval(store, silo, bound, policy, keys, now(), deadline,
    prepared, conversationRows);
  const used = await consumeApproval(store, silo, approval, requestId, fresh, now);
  return { outcome: used ? 'allow' as const : 'ask' as const,
    reason: used ? 'approval_used' : `approval_${approval.state}`, approvalId: approval.request.approvalId };
}

function approvalLifetime(waitLimited: boolean) {
  if (waitLimited) return 900_000;
  return 86400_000;
}
