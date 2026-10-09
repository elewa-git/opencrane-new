import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toolApprovalRequestedDataSchema, type EventEnvelope } from '@opencrane/events';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { readEvents } from '@opencrane/projections';
import { approvalReviewSchema, type ApprovalCard } from '@opencrane/protocol';
import { envelope, history } from './actor.ts';
import { readToolPolicy } from './tool-policy.ts';
import type { mcpPolicy } from './mcp.ts';

export interface ReviewKeys {
  encrypt(silo: string, conversation: string, text: string): { ciphertext: string; keyId: string };
  decrypt(silo: string, conversation: string, value: unknown): string;
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
type Request = z.infer<typeof toolApprovalRequestedDataSchema>;
type Binding = Pick<Request, 'requesterId' | 'conversationId' | 'turnId' | 'assistantId' | 'serverId' | 'connectionId'>;
type FreshAuthority = (() => Promise<void>) & { deadline?: number };
interface ApprovalReadOptions {
  now?: Date;
  deadline?: number;
  conversationRows?: StoredEvent[] | undefined;
}

/** Deterministic request identity prevents a retry from reopening denied, expired or used authority. */
async function askApproval(store: EventStore, silo: string, bound: Binding,
  policy: Awaited<ReturnType<typeof mcpPolicy>>, keys: ReviewKeys | undefined,
  now: Date, deadline: number, conversationRows?: StoredEvent[]) {
  const args = policy.args.value, review = policy.review;
  if (!keys || !review || !(args instanceof Map) || !policy.revision) throw new Error('Review unavailable');
  if (args.size !== review.fields.length || new Set(review.fields).size !== args.size ||
      review.fields.some(k => !args.has(k)) || [...args.values()].some(v => ['object', 'array'].includes(v.kind))) throw new Error('Unreviewed arguments');
  const target = args.get(review.targetArgument);
  if (!target) throw new Error('Review target missing');
  const details = approvalReviewSchema.parse({ action: review.action, tool: policy.name, target: target.kind === 'string' ? target.value : target.canonical,
    data: policy.args.canonical, destination: policy.destination, account: 'No account · profile: none (credential-free connection)', consequence: review.consequence });
  const binding = { ...bound, tool: policy.name, toolRevision: policy.revision, schemaDigest: policy.schemaDigest,
    connectionId: bound.connectionId, profile: 'none', policySequence: policy.policy.sequence,
    digestVersion: 'lossless-json-v1' as const, argumentsDigest: hash(policy.args.canonical) };
  const text = JSON.stringify(details), reviewDigest = hash(text);
  const approvalId = hash(JSON.stringify([silo, binding, reviewDigest]));
  const subject = `approval-${approvalId}`;
  if (!(await history(store, subject, silo, deadline)).length) {
    const lifetime = approvalLifetime(policy.waitLimited);
    const request = { ...binding, approvalId, expiresAt: new Date(now.getTime() + lifetime).toISOString(), stepUp: review.stepUp,
      ...keys.encrypt(silo, bound.conversationId, text), reviewDigest };
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
  Promise<{ request: Request; state: ApprovalCard['state']; sequence: number }> {
  const now = options.now ?? new Date();
  const deadline = options.deadline ?? Infinity;
  const rows = await history(store, `approval-${approvalId}`, silo, deadline);
  const request = toolApprovalRequestedDataSchema.parse(rows[0]?.event.data);
  let state: ApprovalCard['state'] = 'requested';
  for (const { event } of rows.slice(1)) {
    if (event.type === 'approval.decided') state = z.object({ decision: z.enum(['approved', 'rejected']) }).parse(event.data).decision === 'approved' ? 'approved' : 'denied';
    if (event.type === 'approval.used') state = 'outcome_unknown';
    if (event.type === 'approval.expired') state = 'expired';
    if (event.type === 'approval.cancelled') state = 'cancelled';
  }
  const sequence = rows.at(-1)!.sequence;
  if (state === 'requested' || state === 'approved') {
    const closed = await invalidated(store, silo, request, deadline, options.conversationRows);
    const terminal = approvalTerminalState(closed, request.expiresAt, now);
    if (terminal) {
      const result = await store.append({ event: envelope(silo, `approval-${approvalId}`, `approval.${terminal}`, { approvalId }), expectedSequence: sequence });
      if (result.status === 'unavailable') throw new Error('Approval persistence unavailable');
      const readOptions = { now, deadline, conversationRows: options.conversationRows };
      return readApproval(store, silo, approvalId, readOptions);
    }
  }
  return { request, state, sequence };
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
  if (start < 0 || later.some(invalidatesBoundApproval)) return true;
  const policy = await readToolPolicy(store, silo, request.serverId, deadline);
  return !policy.published || policy.sequence !== request.policySequence || policy.connectionId !== request.connectionId;
}

/** One conditional append, with no browser-provided binding, arguments or replacement review. */
export async function decideApproval(store: EventStore, silo: string, approvalId: string, memberId: string,
  decision: 'approved' | 'rejected', recentAuth: boolean,
  fresh: FreshAuthority, now = new Date()) {
  const beganAt = performance.now();
  const readOptions = { now, deadline: fresh.deadline ?? Infinity };
  const current = await readApproval(store, silo, approvalId, readOptions);
  if (current.request.requesterId !== memberId) throw new Error('Requester only');
  if (current.state !== 'requested') return { status: 'conflict' } as const;
  // Sensitive approvals marked for step-up need a recent authentication before approval.
  if (decision === 'approved' && current.request.stepUp && !recentAuth) return { status: 'step_up_required' } as const;
  await fresh();
  const checkedAt = new Date(now.getTime() + performance.now() - beganAt);
  if (Date.parse(current.request.expiresAt) <= checkedAt.getTime()) {
    const event = envelope(silo, `approval-${approvalId}`, 'approval.expired', { approvalId });
    const result = await store.append({ event, expectedSequence: current.sequence });
    if (result.status === 'unavailable') throw new Error('Approval persistence unavailable');
    return { status: 'conflict' } as const;
  }
  return store.append({ event: { ...envelope(silo, `approval-${approvalId}`, 'approval.decided', { approvalId, decidedBy: memberId, decision }),
    principal: { kind: 'human', id: memberId }, source: 'opencrane-server' }, expectedSequence: current.sequence });
}
async function consumeApproval(store: EventStore, silo: string, current: Awaited<ReturnType<typeof readApproval>>, permitId: string, fresh: () => Promise<void>, now: () => Date) {
  if (current.state !== 'approved') return false;
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
  // ponytail: replay the captured head; add an indexed projection when approval history grows.
  const head = await store.head(undefined, deadline);
  let signal: AbortSignal | undefined;
  if (Number.isFinite(deadline)) {
    const remaining = Math.max(0, Math.ceil(deadline - performance.now()));
    signal = AbortSignal.timeout(remaining);
  }
  for await (const { event } of readEvents(store, 1, head, signal)) {
    if (event.silo !== silo || event.type !== 'tool.approval_requested') continue;
    const request = toolApprovalRequestedDataSchema.parse(event.data);
    if (request.conversationId === conversationId) ids.push(request.approvalId);
  }
  const cards: ApprovalCard[] = [];
  for (const id of ids) {
    const { request, state } = await readApproval(store, silo, id, readOptions);
    const text = keys.decrypt(silo, conversationId, request);
    if (hash(text) !== request.reviewDigest) throw new Error('Review digest mismatch');
    cards.push({ approvalId: id, conversationId, requesterId: request.requesterId, expiresAt: request.expiresAt,
      state, stepUp: request.stepUp, canDecide: memberId === request.requesterId && state === 'requested', review: approvalReviewSchema.parse(JSON.parse(text)) });
  }
  return cards;
}

export async function approvalDecision(store: EventStore, silo: string, bound: Binding,
  policy: Awaited<ReturnType<typeof mcpPolicy>>, keys: ReviewKeys | undefined,
  now: () => Date, fresh: FreshAuthority, requestId: string, conversationRows?: StoredEvent[]) {
  if (policy.expectedApproval && policy.outcome !== 'ask') {
    return { outcome: 'deny' as const, reason: 'approval_mismatch', approvalId: undefined };
  }
  if (policy.outcome !== 'ask' || !policy.review || !keys) return { outcome: policy.outcome, reason: policy.reason, approvalId: undefined };
  await fresh();
  const deadline = fresh.deadline ?? Infinity;
  const approval = await askApproval(store, silo, bound, policy, keys, now(), deadline, conversationRows);
  if (policy.expectedApproval && policy.expectedApproval !== approval.request.approvalId) {
    return { outcome: 'deny' as const, reason: 'approval_mismatch',
      approvalId: approval.request.approvalId };
  }
  const used = await consumeApproval(store, silo, approval, requestId, fresh, now);
  return { outcome: used ? 'allow' as const : 'ask' as const,
    reason: used ? 'approval_used' : `approval_${approval.state}`, approvalId: approval.request.approvalId };
}

function approvalLifetime(waitLimited: boolean) {
  if (waitLimited) return 900_000;
  return 86400_000;
}
