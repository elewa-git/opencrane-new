import { decisionRecordedDataSchema, toolDispatchRecordedDataSchema }
  from '@opencrane/events';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import type { OriginalCallStatus } from '@opencrane/protocol';
import { history } from './event-history.ts';
import { invalidatesApproval, readApproval } from './approvals.ts';
import { approvalActivity } from './decision-activity.ts';
import { utcInstant } from './approval-record.ts';

export interface RetainedCall {
  approvalId: string;
  turnId: string;
  permitId: string;
  expiresAt: string;
}
const permitIdSchema = z.uuid();

type RequestBinding = {
  approvalId: string;
  conversationId: string;
  turnId: string;
  serverId: string;
  requesterId: string;
  assistantId: string;
};

function matchingDecision(row: StoredEvent, request: RequestBinding, permitId: string) {
  if (row.event.type !== 'decision.recorded' || row.event.source !== 'models') return false;
  const parsed = decisionRecordedDataSchema.safeParse(row.event.data);
  if (!parsed.success) return false;
  const decision = parsed.data;
  return decision.requestId === permitId &&
    decision.logicalRequestId === request.approvalId &&
    decision.conversationId === request.conversationId &&
    decision.turnId === request.turnId && decision.serverId === request.serverId &&
    decision.requesterId === request.requesterId &&
    decision.assistantId === request.assistantId &&
    decision.route === 'mcp' && decision.outcome === 'allow' &&
    row.event.correlation.approval === request.approvalId;
}

function matchingObservation(row: StoredEvent, request: RequestBinding, permitId: string) {
  if (row.event.type !== 'tool.dispatch_recorded' || row.event.source !== 'models' ||
      row.event.subject !== `decision-${permitId}`) return false;
  const parsed = toolDispatchRecordedDataSchema.safeParse(row.event.data);
  if (!parsed.success) return false;
  const observed = parsed.data;
  return observed.approvalId === request.approvalId &&
    observed.logicalRequestId === request.approvalId && observed.requestId === permitId &&
    observed.conversationId === request.conversationId && observed.turnId === request.turnId &&
    observed.serverId === request.serverId;
}

async function savedAttempt(store: EventStore, silo: string,
  request: RequestBinding,
  use: { permitId: string; usedAt: string }, deadline: number) {
  const attempt: OriginalCallStatus['attempts'][number] = {
    requestId: use.permitId, usedAt: use.usedAt,
  };
  if (!permitIdSchema.safeParse(use.permitId).success) return attempt;
  const rows = await history(store, `decision-${use.permitId}`, silo, deadline);
  const decision = rows[0];
  function isObservation(row: StoredEvent) {
    if (!decision || row.sequence <= decision.sequence) return false;
    return matchingObservation(row, request, use.permitId);
  }
  const validDecision = decision && matchingDecision(decision, request, use.permitId);
  const observation = validDecision ? rows.find(isObservation) : undefined;
  if (observation) {
    const data = toolDispatchRecordedDataSchema.parse(observation.event.data);
    attempt.startedAt = utcInstant(data.startedAt);
    attempt.observedAt = utcInstant(observation.event.time);
    attempt.outcome = data.outcome;
    attempt.evidence = data.evidence;
  }
  return attempt;
}

function provedUnsent(attempt: OriginalCallStatus['attempts'][number]) {
  return attempt.outcome === 'not_dispatched' &&
    (attempt.evidence === 'connection_refused' ||
      attempt.evidence === 'adapter_dispatch_refused');
}

function liveOriginalCall(current: Awaited<ReturnType<typeof readApproval>>,
  activity: Awaited<ReturnType<typeof approvalActivity>>, now: Date) {
  if (current.invalidation ||
      ['denied', 'expired', 'cancelled'].includes(current.state) ||
      Date.parse(current.request.expiresAt) <= now.getTime()) return false;
  if (!activity.computer.firstStart || activity.computer.firstClose ||
      activity.computer.lifecycle?.event.type !== 'computer.ready') return false;
  // Treat a ready record after the original start as a replacement computer run.
  if (activity.computer.lifecycle.sequence > activity.computer.firstStart.sequence) return false;
  function endsOriginalCall(row: StoredEvent) {
    return row.sequence > current.requestPosition &&
      invalidatesApproval(row.event, current.request.turnId);
  }
  if (activity.conversation.some(endsOriginalCall)) return false;
  return true;
}

function retryResult(current: Awaited<ReturnType<typeof readApproval>>,
  attempts: OriginalCallStatus['attempts'], activity: Awaited<ReturnType<typeof approvalActivity>>,
  retained: RetainedCall | undefined, now: Date): OriginalCallStatus['retry'] {
  if (!liveOriginalCall(current, activity, now)) return 'ended';
  const last = attempts.at(-1);
  if (current.state !== 'outcome_unknown' || attempts.length !== 1 ||
      !last || !provedUnsent(last)) return 'unknown';
  if (!retained || retained.approvalId !== current.request.approvalId ||
      retained.turnId !== current.request.turnId || retained.permitId !== last.requestId ||
      Date.parse(retained.expiresAt) <= now.getTime() ||
      Date.parse(retained.expiresAt) > now.getTime() + 5_000) return 'unknown';
  return 'eligible';
}

export async function readOriginalCallStatus(store: EventStore, silo: string,
  logicalRequestId: string, retained: RetainedCall | undefined,
  deadline = performance.now() + 10_000, now?: Date) {
  // Read saved work before the caller's final access check. This read never writes.
  const readOptions = { deadline, ...(now ? { now } : {}), deferInvalidation: true };
  const current = await readApproval(store, silo, logicalRequestId,
    readOptions);
  const request = current.request;
  if (request.approvalId !== logicalRequestId) throw new Error('Call unavailable');
  if (!current.requestedAt) throw new Error('Call date unavailable');
  const attempts: OriginalCallStatus['attempts'] = [];
  for (const use of current.uses) {
    attempts.push(await savedAttempt(store, silo, request, use, deadline));
  }
  const activity = await approvalActivity(store, silo, request.assistantId,
    request.conversationId, request.turnId, deadline);
  const checkedAt = now ?? new Date();
  const status: OriginalCallStatus = {
    logicalRequestId, approvalId: request.approvalId, turnId: request.turnId,
    requesterId: request.requesterId, requestedAt: current.requestedAt,
    expiresAt: utcInstant(request.expiresAt), attempts,
    retry: retryResult(current, attempts, activity, retained, checkedAt),
  };
  if (current.decidedAt) status.decidedAt = current.decidedAt;
  if (current.endedAt) status.endedAt = current.endedAt;
  return { status, requestPosition: current.requestPosition,
    conversationId: request.conversationId };
}
