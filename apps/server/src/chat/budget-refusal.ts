import { createHash } from 'node:crypto';
import { computerSummary, type ComputerSummary } from '@opencrane/auth';
import { readEventAt, readStreamSummary, type EventStore } from '@opencrane/event-store';
import { computerTurnClosedDataSchema, decisionRecordedDataSchema,
  type EventEnvelope } from '@opencrane/events';
import { z } from 'zod';
import { readChatFacts } from './chat-summary.ts';

type RefusedTurn = {
  silo: string; assistantId: string; conversationId: string; turnId: string; stopId: string;
};
type RecoveryControl = { signal: AbortSignal; deadline: number };

function requireRecoveryLive(control?: RecoveryControl) {
  if (control?.signal.aborted || performance.now() >= (control?.deadline ?? Infinity)) {
    throw new Error('Bridge report recovery cancelled');
  }
}

function budgetClosePositions(summary: ComputerSummary) {
  const positions: number[] = [];
  for (const turn of summary.turns.values()) {
    if (turn.firstClose?.budgetStopId) positions.push(turn.firstClose.sequence);
  }
  return positions;
}

/** Recover saved refusals even when a restarted computer has no reports left to replay. */
export async function recoverBudgetRefusals(store: EventStore, silo: string,
  assistantId: string, control?: RecoveryControl) {
  requireRecoveryLive(control);
  const subject = `computer-${assistantId}`;
  const deadline = Math.min(performance.now() + 10_000, control?.deadline ?? Infinity);
  const positions = await readStreamSummary(store, silo, subject,
    computerSummary, deadline, budgetClosePositions);
  requireRecoveryLive(control);
  for (const position of positions) {
    requireRecoveryLive(control);
    const saved = await readEventAt(store, subject, position, deadline);
    requireRecoveryLive(control);
    if (!saved || saved.event.silo !== silo || saved.event.type !== 'computer.turn_closed') {
      throw new Error('Saved budget close unavailable');
    }
    const close = computerTurnClosedDataSchema.parse(saved.event.data);
    if (close.task !== 'chat_turn' || !close.budgetStopId ||
        close.assistantId !== assistantId || close.status !== 'failed') {
      throw new Error('Saved budget close mismatch');
    }
    const refused = { silo, assistantId, conversationId: close.conversationId,
      turnId: close.turnId, stopId: close.budgetStopId };
    await recordBudgetRefusal(store, refused, control);
  }
}

/** Save the admission refusal before the bridge acknowledges it, without reserving money. */
export async function recordBudgetRefusal(store: EventStore, turn: RefusedTurn,
  control?: RecoveryControl) {
  requireRecoveryLive(control);
  const readDeadline = Math.min(performance.now() + 10_000, control?.deadline ?? Infinity);
  const facts = await readChatFacts(store, turn.silo, turn.conversationId, turn.turnId,
    undefined, undefined, readDeadline);
  requireRecoveryLive(control);
  const requesterId = z.string().parse(facts.message?.authorId);
  const identity = ['budget-turn-refusal', turn.silo, turn.conversationId, turn.turnId];
  const hash = createHash('sha256');
  hash.update(JSON.stringify(identity));
  const id = hash.digest('hex');
  const context = { ...turn, requesterId };
  const contextHash = createHash('sha256');
  contextHash.update(JSON.stringify(context));
  const decision = {
    requestId: id, requesterId, assistantId: turn.assistantId,
    conversationId: turn.conversationId, turnId: turn.turnId,
    route: 'model', outcome: 'deny', reason: 'budget_exhausted',
    contextDigest: contextHash.digest('hex'),
  };
  const data = decisionRecordedDataSchema.parse(decision);
  const event: EventEnvelope = {
    id, commandId: id, type: 'decision.recorded', subject: `decision-${id}`, silo: turn.silo,
    source: 'opencrane-server', principal: { kind: 'system', id: 'turn-lifecycle' },
    time: new Date().toISOString(), correlation: {}, data,
  };
  // Use one stream per refused turn so reconnects remain idempotent after NATS deduplication expires.
  const command = { event, expectedSequence: 0, historyChecked: true as const,
    ...(control ? { signal: control.signal, deadline: control.deadline } : {}) };
  const result = await store.append(command);
  requireRecoveryLive(control);
  if (result.status === 'appended') return;
  if (result.status !== 'conflict') throw new Error('Budget refusal save unavailable');
  const deadline = Math.min(performance.now() + 10_000, control?.deadline ?? Infinity);
  const position = await store.head(event.subject, deadline);
  requireRecoveryLive(control);
  const saved = await readEventAt(store, event.subject, position, deadline);
  requireRecoveryLive(control);
  if (saved?.event.id !== id || saved.event.silo !== turn.silo ||
      saved.event.type !== event.type ||
      decisionRecordedDataSchema.parse(saved.event.data).contextDigest !== data.contextDigest) {
    throw new Error('Budget refusal record conflict');
  }
}
