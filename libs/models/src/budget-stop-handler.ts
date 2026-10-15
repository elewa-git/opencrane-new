import { createHash } from 'node:crypto';
import { computerSummary } from '@opencrane/auth';
import { readStreamSummary, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { computerTurnStartedDataSchema, type EventEnvelope } from '@opencrane/events';
import { registerHandler } from '@opencrane/handlers';
import { listOpenConversations, type Query } from '@opencrane/projections';
import { history, envelope } from './actor.ts';
import { closesDecisionTurn } from './approvals.ts';
import { queuedPersonalPayer } from './provider-turns.ts';
import { applyBudget, budgetStopId, data, emptyBudget, type BudgetState } from './state.ts';

type Session = Extract<Awaited<ReturnType<typeof listOpenConversations>>[number],
  { mode: 'agent_session' }>;
type Work = { conversationId: string; turnId: string; assistantId: string;
  payingGroupId?: string | undefined; position: number };

async function budgetAtStop(store: EventStore, event: EventEnvelope, deadline: number) {
  const rows = await history(store, `budget-${event.silo}`, event.silo, deadline);
  const state = emptyBudget();
  for (const row of rows) {
    applyBudget(state, row.event, row.sequence);
    if (row.event.id === event.id) return state;
  }
  throw new Error('Budget stop is not saved');
}

async function requireIndex(db: Query, position: number) {
  const result = await db.query<{ sequence: string }>(
    "SELECT sequence FROM projection_checkpoints WHERE name = 'conversations'");
  if (Number(result.rows[0]?.sequence ?? -1) < position) {
    throw new Error('Conversation index has not reached the budget stop');
  }
}

export async function queuedPayer(store: EventStore, silo: string,
  session: Pick<Session, 'assistantId' | 'payingGroupId'>, position: number, deadline: number) {
  const rows = await history(store, `assistant-${session.assistantId}`, silo, deadline);
  for (const row of rows) {
    if (row.event.type !== 'assistant.created') continue;
    if (data(row.event)['kind'] === 'personal') {
      return queuedPersonalPayer(store, silo, position, deadline);
    }
    return session.payingGroupId;
  }
  throw new Error('Assistant unavailable for queued budget stop');
}

async function affectedWork(store: EventStore, event: EventEnvelope, session: Session,
  state: BudgetState, deadline: number) {
  const rows = await history(store, `conversation-${session.conversationId}`, event.silo, deadline);
  const works = new Map<string, Work>();
  for (const row of rows) {
    if (row.sequence > state.sequence || row.event.type !== 'message.posted' ||
        data(row.event)['authorKind'] !== 'human') continue;
    const payer = await queuedPayer(store, event.silo, session, row.sequence, deadline);
    works.set(row.event.id, { conversationId: session.conversationId,
      turnId: row.event.id, assistantId: session.assistantId, payingGroupId: payer,
      position: row.sequence });
  }
  function addAdmissions(summary: Parameters<typeof computerSummary.add>[0]) {
    for (const [turnId, turn] of summary.turns) {
      if (turn.firstClose) {
        works.delete(turnId);
        continue;
      }
      const start = turn.firstStart;
      if (!start || start.sequence > state.sequence) continue;
      const saved = computerTurnStartedDataSchema.parse(start.event.data);
      if (saved.conversationId !== session.conversationId) continue;
      // Keep the admitted payer even if the installation default later changes.
      const position = works.get(turnId)?.position ?? start.sequence;
      works.set(turnId, { ...saved, position });
    }
  }
  await readStreamSummary(store, event.silo, `computer-${session.assistantId}`,
    computerSummary, deadline, addAdmissions);
  return works.values();
}

async function saveStop(store: EventStore, trigger: EventEnvelope, work: Work,
  stopId: string, deadline: number) {
  const subject = `conversation-${work.conversationId}`;
  const hash = createHash('sha256');
  hash.update(JSON.stringify([trigger.silo, stopId, work.conversationId, work.turnId]));
  const id = hash.digest('hex');
  const payload = { conversationId: work.conversationId, turnId: work.turnId,
    reason: 'budget', stopId };
  const event = envelope(trigger.silo, subject, 'agent.turn_stop_requested', payload, id);
  for (let attempt = 0; attempt < 10; attempt++) {
    const rows = await history(store, subject, trigger.silo, deadline);
    function ended(row: StoredEvent) {
      return row.event.type === 'conversation.closed' || closesDecisionTurn(row.event, work.turnId);
    }
    if (rows.some(ended)) return;
    const command = { event, expectedSequence: rows.at(-1)?.sequence ?? 0, deadline,
      historyChecked: true as const };
    const result = await store.append(command);
    if (result.status === 'appended') return;
    if (result.status !== 'conflict') throw new Error('Budget turn stop append unavailable');
    // Read again so a competing Stop or final report ends this command without another record.
  }
  throw new Error('Budget turn stop kept changing; retry');
}

export function budgetStopHandler(store: EventStore) {
  async function stopBudgetTurns(event: EventEnvelope, db: Query) {
    const deadline = performance.now() + 10_000;
    const state = await budgetAtStop(store, event, deadline);
    if (state.stops.length === 0) return;
    await requireIndex(db, state.sequence);
    const sessions = await listOpenConversations(db, event.silo);
    for (const session of sessions) {
      if (session.mode !== 'agent_session') continue;
      const works = await affectedWork(store, event, session, state, deadline);
      for (const work of works) {
        if (work.position > state.sequence) continue;
        const stopId = budgetStopId(state, work, new Date(event.time), work.position);
        if (stopId) await saveStop(store, event, work, stopId, deadline);
      }
    }
  }
  return registerHandler('stop-budget-turns', stopBudgetTurns);
}
