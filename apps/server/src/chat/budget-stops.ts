import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isOrganisationSession, type AuthConfig } from '@opencrane/auth';
import { agentTurnStopRequestedDataSchema,
  conversationCreatedDataSchema, computerTurnStartedDataSchema }
  from '@opencrane/events';
import type { StoredEvent } from '@opencrane/event-store';
import { history, queuedPayer, turnBudgetStopDetails } from '@opencrane/models';
import { budgetStopStatusSchema, type BudgetStopStatus } from '@opencrane/protocol';
import { z } from 'zod';
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import { sessionFor } from '../members/routes.ts';
import type { ChatOptions } from './routes.ts';

const parameters = z.object({ conversationId: idSchema });
const query = z.object({ turnId: idSchema }).strict();
const fields = z.object({ turnId: z.string().optional(), authorKind: z.string().optional(),
  authorId: z.string().optional() });
function data(row: StoredEvent) {
  return fields.parse(row.event.data);
}

export function registerBudgetStopRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ChatOptions) {
  app.get('/api/conversations/:conversationId/budget-stops', handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const session = sessionFor(request, config, new Date());
    if (!session) return reply.code(401).send({ status: 'refused' });
    if (!isOrganisationSession(config, session) ||
        (options && options.silo !== options.binding.silo)) {
      return reply.code(403).send({ status: 'refused' });
    }
    if (!options) return reply.code(503).send({ status: 'unavailable' });
    try {
      const { conversationId } = parameters.parse(request.params);
      const { turnId } = query.parse(request.query);
      let loaded: Awaited<ReturnType<typeof load>>;
      let loadingError: Error | undefined;
      try {
        loaded = await load(options, conversationId, turnId);
      } catch (error) {
        loadingError = new Error('Turn unavailable', { cause: error });
      }
      const checks = { write: false, conversationId };
      // Check access even after failed reads so outsiders cannot discover saved turns.
      // Keep this check after loading so a removal during loading takes effect.
      const { memberId, access } = await requireMember(request, reply, config, options, checks);
      if (loadingError) {
        throw loadingError;
      }
      if (!loaded || loaded.message.sequence < access.historyPosition) {
        return reply.code(403).send({ status: 'refused' });
      }
      const result = status(loaded, turnId, memberId, access.historyPosition);
      return reply.send(budgetStopStatusSchema.parse(result));
    } catch (error) {
      if (error instanceof MemberRefusal) {
        return reply.code(error.statusCode).send({ status: error.status });
      }
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}

async function load(options: ChatOptions, conversationId: string, turnId: string) {
  const deadline = performance.now() + 10_000;
  const rows = await history(options.store, `conversation-${conversationId}`, options.silo, deadline);
  function isCreation(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  function isMessage(row: StoredEvent) {
    return row.event.id === turnId && row.event.type === 'message.posted' &&
      data(row).authorKind === 'human';
  }
  const creation = rows.find(isCreation);
  const message = rows.find(isMessage);
  if (!creation || !message) return undefined;
  const session = conversationCreatedDataSchema.parse(creation.event.data);
  if (session.mode !== 'agent_session') return undefined;
  const computer = await history(options.store, `computer-${session.assistantId}`,
    options.silo, deadline);
  const start = started(computer, turnId);
  let payingGroupId: string | undefined;
  if (start) {
    const saved = computerTurnStartedDataSchema.parse(start.event.data);
    if (saved.conversationId !== conversationId) throw new Error('Turn unavailable');
    payingGroupId = saved.payingGroupId;
  } else {
    payingGroupId = await queuedPayer(options.store, options.silo, session,
      message.sequence, deadline);
  }
  const recorded = stopRecord(rows, turnId);
  const work = { conversationId, turnId, assistantId: session.assistantId, payingGroupId };
  const budget = await turnBudgetStopDetails(options.store, options.silo, work,
    message.sequence, deadline, recorded?.stopId);
  if (performance.now() >= deadline) throw new Error('History unavailable');
  return { rows, computer, message, recorded, budget };
}
function started(rows: StoredEvent[], turnId: string) {
  function matches(row: StoredEvent) {
    return row.event.type === 'computer.turn_started' && data(row).turnId === turnId;
  }
  return rows.find(matches);
}
function stopRecord(rows: StoredEvent[], turnId: string) {
  for (const row of rows) {
    if (row.event.type !== 'agent.turn_stop_requested') continue;
    const saved = agentTurnStopRequestedDataSchema.parse(row.event.data);
    if (saved.turnId === turnId && 'reason' in saved) return { ...saved, position: row.sequence };
  }
  return undefined;
}
function ended(rows: StoredEvent[], computer: StoredEvent[], turnId: string) {
  const start = started(computer, turnId);
  const terminalTypes = ['agent.turn_completed', 'agent.turn_failed', 'computer.turn_closed'];
  function isEnd(row: StoredEvent) {
    if (row.event.type === 'computer.lost') return !!start && row.sequence > start.sequence;
    return terminalTypes.includes(row.event.type) && data(row).turnId === turnId;
  }
  const candidates = [...rows, ...computer];
  const ends = candidates.filter(isEnd);
  function earlier(first: StoredEvent, second: StoredEvent) {
    return first.sequence - second.sequence;
  }
  ends.sort(earlier);
  return ends[0]?.sequence;
}
function status(loaded: NonNullable<Awaited<ReturnType<typeof load>>>, turnId: string,
  memberId: string, historyPosition: number): BudgetStopStatus {
  const { rows, computer, message, recorded, budget } = loaded;
  const stop = budget.stop;
  const close = ended(rows, computer, turnId);
  if (!recorded && (!stop || (close !== undefined && close < stop.position))) {
    return { status: 'not_stopped' };
  }
  if (!stop || (!recorded && close === undefined)) throw new Error('Stop unavailable');
  function reason(saved: NonNullable<typeof stop>['reasons'][number]) {
    const remedy = saved.ceilingCents === 0 ? 'ask_admin' : 'ask_admin_or_wait';
    const safe = { scope: saved.scope, period: saved.kind, cause: saved.reason,
      resetAt: saved.resetAt, remedy } as const;
    if (data(message).authorId === memberId) return { ...safe, limitCents: saved.ceilingCents };
    return safe;
  }
  const reasons = stop.reasons.map(reason);
  const work = stoppedWork(rows, computer, stop.id, historyPosition);
  function visibleCall(call: typeof budget.calls[number]) {
    if (data(message).authorId === memberId) return call;
    return { reference: call.reference, status: call.status };
  }
  const calls = budget.calls.map(visibleCall);
  return { status: 'stopped', stopId: stop.id, reasons, work, calls,
    positions: { stop: stop.position, turn: recorded?.position ?? null,
      conversation: rows.at(-1)?.sequence ?? 0,
      computer: computer.at(-1)?.sequence ?? 0, budget: budget.position } };
}

function stoppedWork(rows: StoredEvent[], computer: StoredEvent[], stopId: string,
  historyPosition: number) {
  const work: Extract<BudgetStopStatus, { status: 'stopped' }>['work'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.event.type !== 'agent.turn_stop_requested') continue;
    const saved = agentTurnStopRequestedDataSchema.parse(row.event.data);
    if (!('stopId' in saved) || saved.stopId !== stopId || seen.has(saved.turnId)) continue;
    function visible(candidate: StoredEvent) {
      const human = candidate.event.id === saved.turnId;
      const admitted = candidate.event.type === 'agent.turn_started' &&
        data(candidate).turnId === saved.turnId;
      return (human || admitted) && candidate.sequence >= historyPosition;
    }
    if (!rows.some(visible)) continue;
    seen.add(saved.turnId);
    let execution: typeof work[number]['execution'] = 'not_started';
    if (started(computer, saved.turnId)) execution = 'stopping';
    if (ended(rows, computer, saved.turnId) !== undefined) execution = 'ended';
    work.push({ turnId: saved.turnId, execution });
  }
  return work;
}
