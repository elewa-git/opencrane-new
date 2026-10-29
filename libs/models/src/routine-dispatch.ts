import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory } from '@opencrane/authz';
import { isEventStoreUnavailable, readEventAt, type StoredEvent } from '@opencrane/event-store';
import { budgetRootAllowanceSetDataSchema, conversationCreatedDataSchema,
  type RoutineState } from '@opencrane/events';
import type { BudgetActor } from './actor.ts';
import { withinBudgetDeadline } from './budget-writer.ts';
import { data } from './state.ts';

type Identity = { requester: string; assistant: string; computer: string; generation: number;
  conversation: string; turn: string; thread: string };
type Run = NonNullable<RoutineState['activeRun']>;

export class RoutineDispatchRefused extends Error {
  constructor() {
    super('Routine dispatch refused');
  }
}

function refuseRoutineDispatch(error: unknown): never {
  // Preserve failed reads and the timer's error without claiming a saved refusal.
  if (isEventStoreUnavailable(error) ||
      (error instanceof Error && error.message === 'Budget append unavailable')) {
    throw error;
  }
  throw new RoutineDispatchRefused();
}

function preparation(conversation: StoredEvent[], claims: Identity, silo: string) {
  function isCreation(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  const creations = conversation.filter(isCreation);
  const created = creations[0];
  if (!created) {
    throw new Error('Routine dispatch refused');
  }
  const fields = data(created.event);
  if (!Object.hasOwn(fields, 'routinePreparation')) {
    if (claims.conversation.startsWith('routine-session-')) {
      throw new Error('Routine dispatch refused');
    }
    return undefined;
  }
  const saved = conversationCreatedDataSchema.parse(fields);
  if (!('routinePreparation' in saved) || !saved.routinePreparation ||
      creations.length !== 1 || saved.mode !== 'agent_session') {
    throw new Error('Routine dispatch refused');
  }
  const marker = saved.routinePreparation;
  requireCreation(created, claims, silo, marker.occurrenceId);
  if (created.sequence <= marker.claimPosition || saved.createdBy !== claims.requester ||
      saved.assistantId !== claims.assistant || saved.conversationId !== claims.conversation) {
    throw new Error('Routine dispatch refused');
  }
  return { marker, payer: saved.payingGroupId };
}

function requireCreation(created: StoredEvent, claims: Identity, silo: string,
  occurrenceId: string) {
  const expectedId = `routine-session-create-${occurrenceId}`;
  const expectedPrincipal = { kind: 'human', id: claims.requester };
  if (created.event.silo !== silo ||
      created.event.subject !== `conversation-${claims.conversation}` ||
      created.event.source !== 'opencrane-server' ||
      !isDeepStrictEqual(created.event.principal, expectedPrincipal) ||
      created.event.id !== expectedId || created.event.commandId !== expectedId ||
      claims.conversation !== `routine-session-${occurrenceId}`) {
    throw new Error('Routine dispatch refused');
  }
}

function requireRun(state: RoutineState | undefined, occurrenceId: string) {
  const run = state?.activeRun;
  if (!run || !state.definition || !state.activation || state.status !== 'active' ||
      state.stopRequested || run.occurrenceId !== occurrenceId ||
      state.definition.controlRevision !== run.controlRevision) {
    throw new Error('Routine dispatch refused');
  }
  return run;
}

/** Load routine evidence before access; later checks read only changes to this routine. */
export async function prepareRoutineDispatch(actor: BudgetActor, claims: Identity,
  conversation: StoredEvent[], turn: StoredEvent) {
  try {
    const saved = preparation(conversation, claims, actor.silo);
    if (!saved) {
      return undefined;
    }
    const deadline = performance.now() + 10_000;
    return await withinBudgetDeadline(load(actor, claims, saved, turn, deadline), deadline);
  } catch (error) {
    refuseRoutineDispatch(error);
  }
}

async function load(actor: BudgetActor, claims: Identity,
  saved: NonNullable<ReturnType<typeof preparation>>, turn: StoredEvent, deadline: number) {
  const { store, silo } = actor;
  const { marker, payer } = saved;
  const subject = `routine-${marker.routineId}`;
  let state: RoutineState | undefined;
  let position = 0;
  let claim: StoredEvent | undefined;
  const completed = new Map<string, Run>();
  async function readChanges(deadline: number) {
    const latest = await store.head(subject, deadline);
    if (latest < position) {
      throw new Error('Routine dispatch refused');
    }
    if (latest === position) {
      return;
    }
    for await (const row of store.readStream(subject, position + 1, deadline)) {
      if (row.sequence > latest) {
        break;
      }
      if (row.sequence <= position || row.event.silo !== silo || row.event.subject !== subject) {
        throw new Error('Routine dispatch refused');
      }
      if (position === 0 && row.event.type !== 'routine.created') {
        throw new Error('Routine dispatch refused');
      }
      state = foldRoutineHistory(state, row.event, completed);
      position = row.sequence;
      if (position === marker.claimPosition) {
        if (row.event.id !== marker.claimId || row.event.type !== 'routine.due') {
          throw new Error('Routine dispatch refused');
        }
        claim = row;
      }
    }
    if (position !== latest) {
      throw new Error('Routine dispatch refused');
    }
    if (performance.now() >= deadline) {
      throw new Error('Budget append unavailable');
    }
  }
  await readChanges(deadline);
  const run = requireRun(state, marker.occurrenceId);
  if (!claim || !isDeepStrictEqual(claim.event.data, run) ||
      run.conversationId !== claims.conversation || run.turnId !== claims.turn ||
      run.definition.ownerId !== claims.requester || run.definition.assistantId !== claims.assistant ||
      run.definition.payingGroupId !== payer || data(turn.event)['payingGroupId'] !== payer) {
    throw new Error('Routine dispatch refused');
  }
  const admission = state!.activation!.admission;
  await requireAllocation(actor, claims, payer, admission, turn, run, deadline);
  async function check(deadline: number) {
    while (true) {
      await readChanges(deadline);
      const current = requireRun(state, marker.occurrenceId);
      if (!isDeepStrictEqual(current, run) ||
          !isDeepStrictEqual(state!.activation!.admission, admission)) {
        throw new Error('Routine dispatch refused');
      }
      // Catch prohibition saved while the incremental read was waiting.
      const latest = await store.head(subject, deadline);
      if (latest === position) {
        return;
      }
    }
  }
  async function confirm(deadline: number) {
    try {
      await withinBudgetDeadline(check(deadline), deadline);
    } catch (error) {
      refuseRoutineDispatch(error);
    }
  }
  return { confirm };
}

async function requireAllocation(actor: BudgetActor, claims: Identity, payer: string | undefined,
  admission: NonNullable<RoutineState['activation']>['admission'], turn: StoredEvent,
  run: Run, deadline: number) {
  function matchesRoot(root: BudgetActor['state']['roots'][number]) {
    return root.conversationId === claims.conversation && root.turnId === claims.turn;
  }
  const root = actor.state.roots.find(matchesRoot);
  const started = data(turn.event);
  if (!root || root.position !== admission.position || !root.preparationDigest ||
      started['rootId'] !== root.rootId || started['messageId'] !== run.messageId ||
      started['executionMode'] !== 'restricted') {
    throw new Error('Routine dispatch refused');
  }
  const identity = { requesterId: claims.requester, assistantId: claims.assistant,
    payingGroupId: payer, computerId: claims.computer, generation: claims.generation,
    threadId: claims.thread };
  const fields = ['requesterId', 'assistantId', 'payingGroupId', 'computerId',
    'generation', 'threadId'] as const;
  for (const field of fields) {
    if (root[field] !== identity[field]) {
      throw new Error('Routine dispatch refused');
    }
  }
  const subject = `budget-${actor.silo}`;
  const allocation = await readEventAt(actor.store, subject, admission.position, deadline);
  const expected = budgetRootAllowanceSetDataSchema.strip().parse(root);
  const principal = { kind: 'system', id: 'models' };
  if (!allocation || allocation.event.id !== admission.eventId ||
      allocation.event.type !== 'budget.root_allowance_set' || allocation.event.source !== 'models' ||
      !isDeepStrictEqual(allocation.event.principal, principal) ||
      !isDeepStrictEqual(allocation.event.data, expected)) {
    throw new Error('Routine dispatch refused');
  }
}
