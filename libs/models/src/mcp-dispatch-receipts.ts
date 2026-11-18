import { createLogger } from '@opencrane/observability';
import { envelope, type BudgetActor } from './actor.ts';
import type { Permit } from './mcp-dispatch-contract.ts';
import { privateDecisionReason } from './decision-refusal.ts';
import { remoteEvidence } from './remote-https.ts';
import { recordAdapterObservation, recordToolObservation } from './tool-dispatch.ts';

export type DispatchObserver = (outcome: 'responded' | 'outcome_unknown' | 'not_dispatched',
  deadline?: number) => Promise<void>;

export interface DispatchRefusal {
  permit: Permit;
  observe: DispatchObserver | undefined;
  startedAt: number;
  stage: string;
  deadline: number;
  error: unknown;
}

export async function reportDispatchRefusal(actor: BudgetActor, refusal: DispatchRefusal) {
  const { store } = actor;
  const { permit, observe, startedAt, stage, deadline, error } = refusal;
  const logger = createLogger('mcp-dispatch');
  const diagnostic = { stage, reason: privateDecisionReason(error),
    elapsedMs: Math.ceil(store.clock.now() - startedAt),
    accessRemainingMs: Math.max(0, Math.floor(deadline - store.clock.now())) };
  logger.warn(diagnostic, 'MCP dispatch refused');
  try {
    await recordRefusedStart(actor, permit, observe, startedAt);
  } catch {
    const evidence = { stage: 'refusal_evidence', reason: 'evidence_unavailable',
      elapsedMs: Math.ceil(store.clock.now() - startedAt) };
    logger.warn(evidence, 'MCP dispatch refused');
  }
}

async function recordRefusedStart(actor: BudgetActor, permit: Permit,
  observe: DispatchObserver | undefined, startedAt: number) {
  const { store } = actor;
  // Allow one second to save evidence only. This cannot extend permission to send.
  const deadline = store.clock.now() + 1000;
  if (permit.route.locator) {
    // Record proof only after a confirmed start and before opening any connection.
    if (observe) {
      await observe('not_dispatched', deadline);
    }
    return;
  }
  if (!permit.gatewayBinding) {
    return;
  }
  // Close the saved start before replying. No upstream connection has been opened.
  const observation = { id: permit.requestId, toolOutcome: 'not_dispatched' as const,
    evidence: 'dispatch_refused' as const, observedAt: new Date().toISOString(),
    durationMs: Math.ceil(store.clock.now() - startedAt) };
  await recordToolObservation(actor, observation, deadline);
}

export async function recordDispatchStarted(actor: BudgetActor, permit: Permit, deadline: number) {
  const { store, silo } = actor;
  const binding = permit.gatewayBinding;
  if (!binding) {
    return;
  }
  const subject = `decision-${permit.requestId}`;
  const expectedSequence = await store.head(subject, deadline);
  // Keep any saved outcome last, including one written after a gateway timeout.
  const decision = await store.readEvent(expectedSequence, deadline);
  if (decision.event.id !== permit.budget.decisionId) {
    throw new Error('Tool dispatch decision changed');
  }
  const payload = { requestId: permit.requestId, serverId: permit.route.serverId,
    connectionId: permit.route.connectionId, generation: binding.generation,
    recordDigest: binding.recordDigest, reviewRevision: permit.reviewRevision,
    ...(permit.route.locator ? { adapter: 'remote_https' } : {}) };
  const eventId = `${permit.requestId}:tool-dispatch-started`;
  const event = envelope(silo, subject, 'tool.dispatch_started', payload, eventId);
  // Consume once in this process. Never recover a failed save reply by sending later.
  const command = { event, expectedSequence, deadline, historyChecked: true as const };
  const result = await store.append(command);
  if (result.status !== 'appended') {
    throw new Error('Tool dispatch start unavailable');
  }
  const startedAt = store.clock.now();
  const adapter = { silo: permit.silo, decisionId: permit.budget.decisionId,
    startId: event.id, connectionId: payload.connectionId, generation: payload.generation,
    recordDigest: payload.recordDigest, reviewRevision: payload.reviewRevision! };
  async function observe(outcome: 'responded' | 'outcome_unknown' | 'not_dispatched',
    evidenceDeadline?: number) {
    const evidence = remoteEvidence(outcome);
    const observation = { id: permit.requestId, toolOutcome: outcome, evidence,
      observedAt: new Date().toISOString(),
      durationMs: Math.ceil(store.clock.now() - startedAt) } as const;
    await recordAdapterObservation(actor, adapter, observation, evidenceDeadline);
  }
  return observe;
}

