import { foldRoutineHistory } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { parseEventByType, routineControlSchema, type EventEnvelope, type RoutineState }
  from '@opencrane/events';
import { data, type BudgetState } from './state.ts';
import { withinBudgetDeadline } from './budget-writer.ts';

type Root = BudgetState['roots'][number];
export type RootStopReason = 'requester_stop' | 'turn_ended' | 'access_revoked' | 'routine_stop';
type StopEvidence = StoredEvent & { routine?: RoutineState };
type Append = (type: string, payload: unknown) => Promise<void>;

export async function readRootStopEvidence(store: EventStore, subject: string, position: number) {
  try {
    if (!Number.isSafeInteger(position) || position < 1) {
      throw new Error('Invalid position');
    }
    const deadline = performance.now() + 10_000;
    const reading = readEvidence(store, subject, position, deadline);
    return await withinBudgetDeadline(reading, deadline);
  } catch {
    // Keep store errors and evidence identities out of the caller's error.
    throw new Error('Root stop evidence refused');
  }
}

async function readEvidence(store: EventStore, subject: string, position: number,
  deadline: number): Promise<StopEvidence> {
  const saved = await readEventAt(store, subject, position, deadline);
  const parsed = parseEventByType(saved?.event);
  if (!saved || !parsed.success || parsed.event.subject !== subject) {
    throw new Error('Missing source event');
  }
  const source = { sequence: saved.sequence, event: parsed.event };
  if (source.event.type !== 'routine.run_stop_requested' &&
      !isLifecycleProhibition(source.event)) {
    return source;
  }
  const routine = await readRoutineThroughStop(store, source, deadline);
  return { ...source, routine };
}

function isLifecycleProhibition(event: EventEnvelope) {
  return event.type === 'routine.paused' || event.type === 'routine.retired';
}

function requireLifecycleRun(state: RoutineState | undefined, event: EventEnvelope) {
  if (!isLifecycleProhibition(event)) {
    return;
  }
  const control = routineControlSchema.parse(event.data);
  const saved = state?.definition;
  const run = state?.activeRun;
  // Bind the prohibition to the run occupied before this lifecycle change was saved.
  if (!saved || !run || state.status === 'retired' ||
      control.affectedRun !== run.occurrenceId || control.source !== 'owner' ||
      control.actorId !== saved.definition.ownerId ||
      control.definitionRevision !== saved.definitionRevision ||
      control.scheduleRevision !== saved.scheduleRevision ||
      control.controlRevision !== saved.controlRevision + 1) {
    throw new Error('Invalid routine prohibition');
  }
}

async function readRoutineThroughStop(store: EventStore, source: StoredEvent, deadline: number) {
  let routine: RoutineState | undefined;
  const completedRuns = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for await (const row of store.readStream(source.event.subject, 1, deadline)) {
    if (performance.now() >= deadline || row.sequence > source.sequence) {
      break;
    }
    if (row.sequence === source.sequence && row.event.id === source.event.id) {
      requireLifecycleRun(routine, row.event);
    }
    routine = foldRoutineHistory(routine, row.event, completedRuns);
    if (row.sequence === source.sequence && row.event.id === source.event.id) {
      return routine;
    }
  }
  throw new Error('Missing routine history');
}

function matchesRoutineStop(root: Root, source: StopEvidence) {
  const routine = source.routine;
  const run = routine?.activeRun;
  // Validate repeated completions and the Stop against their original runs while reading history.
  // Match that frozen run to the allocated budget root through its turn and people.
  const prohibited = isLifecycleProhibition(source.event) ||
    (source.event.type === 'routine.run_stop_requested' && routine?.stopRequested === true);
  return prohibited &&
    run !== null && run !== undefined && matchesTurn(root, run) &&
    run.definition.ownerId === root.requesterId &&
    run.definition.assistantId === root.assistantId &&
    run.definition.payingGroupId === root.payingGroupId;
}

function matchesTurn(root: Root, fields: Record<string, unknown>) {
  return fields['conversationId'] === root.conversationId && fields['turnId'] === root.turnId;
}
function matchesRequesterStop(root: Root, event: EventEnvelope) {
  const fields = data(event);
  return event.subject === `conversation-${root.conversationId}` &&
    event.type === 'agent.turn_stop_requested' && matchesTurn(root, fields) &&
    fields['requestedBy'] === root.requesterId;
}
function matchesTurnEnd(root: Root, event: EventEnvelope) {
  const fields = data(event);
  if (!matchesTurn(root, fields)) return false;
  if (event.type === 'computer.turn_closed') {
    return event.subject === `computer-${root.assistantId}` && fields['task'] === 'chat_turn' &&
      fields['assistantId'] === root.assistantId && fields['computerId'] === root.computerId &&
      fields['requesterId'] === root.requesterId;
  }
  return event.subject === `conversation-${root.conversationId}` &&
    (event.type === 'agent.turn_completed' || event.type === 'agent.turn_failed');
}
function matchesAccessLoss(root: Root, event: EventEnvelope) {
  const fields = data(event);
  if (event.type === 'member.removed') {
    return event.subject === `member-${root.requesterId}` && fields['memberId'] === root.requesterId;
  }
  if (event.subject !== `participation-${root.conversationId}` ||
      fields['conversationId'] !== root.conversationId) {
    return false;
  }
  return event.type === 'conversation.closed' ||
    (event.type === 'participant.removed' && fields['participantId'] === root.requesterId);
}
function matchesReason(root: Root, reason: RootStopReason, source: StopEvidence) {
  const event = source.event;
  switch (reason) {
    case 'requester_stop': return matchesRequesterStop(root, event);
    case 'turn_ended': return matchesTurnEnd(root, event);
    case 'access_revoked': return matchesAccessLoss(root, event);
    case 'routine_stop': return matchesRoutineStop(root, source);
    default: return false;
  }
}
export async function saveRootStop(state: BudgetState, silo: string, rootId: string,
  reason: RootStopReason, source: StopEvidence, append: Append) {
  function matchesRoot(root: Root) {
    return root.rootId === rootId;
  }
  const root = state.roots.find(matchesRoot);
  if (!root || source.event.silo !== silo || !matchesReason(root, reason, source)) {
    throw new Error('Root stop evidence refused');
  }
  // Reject access loss from before this root existed, including removal before re-invitation.
  if (reason === 'access_revoked' && source.sequence < root.position) {
    throw new Error('Root stop evidence refused');
  }
  // Keep the first saved reason even when a later valid source gives another reason.
  if (root.stop) return root.stop;
  const stop = { rootId, reason, sourceSubject: source.event.subject,
    sourcePosition: source.sequence, sourceEventId: source.event.id };
  await append('budget.root_stopped', stop);
  return root.stop!;
}
