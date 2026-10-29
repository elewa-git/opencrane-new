import { foldRoutineHistory } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { parseEventByType, routineControlSchema, routineStopSchema,
  type EventEnvelope, type RoutineState } from '@opencrane/events';
import { readRoutineApproval } from './routine-approval-evidence.ts';
import { currentMembership } from './ownership.ts';
import { data, type BudgetState } from './state.ts';
import { withinBudgetDeadline } from './budget-writer.ts';

type Root = BudgetState['roots'][number];
export type RootStopReason = 'requester_stop' | 'turn_ended' | 'access_revoked' | 'routine_stop';
type StopEvidence = StoredEvent & { routine?: RoutineState };
type Append = (type: string, payload: unknown) => Promise<void>;

export async function readRootStopEvidence(store: EventStore, subject: string, position: number,
  deadline = performance.now() + 10_000) {
  try {
    if (!Number.isSafeInteger(position) || position < 1) {
      throw new Error('Invalid position');
    }
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

function lifecycleRun(state: RoutineState | undefined, event: EventEnvelope) {
  const control = routineControlSchema.parse(event.data);
  const saved = state?.definition;
  const run = state?.activeRun;
  // Bind the prohibition to the run occupied before this lifecycle change was saved.
  if (!saved || !run || state.status === 'retired' ||
      control.affectedRun !== run.occurrenceId ||
      control.definitionRevision !== saved.definitionRevision ||
      control.scheduleRevision !== saved.scheduleRevision ||
      control.controlRevision !== saved.controlRevision + 1) {
    throw new Error('Invalid routine prohibition');
  }
  return { control, state };
}

async function requireApprovalStop(store: EventStore, state: RoutineState | undefined,
  source: StoredEvent, claimPosition: number, deadline: number) {
  const stop = routineStopSchema.parse(source.event.data);
  if (stop.source !== 'approval') {
    return;
  }
  if (!stop.cause || stop.cause.position >= source.sequence) {
    throw new Error('Invalid routine prohibition');
  }
  const reason = await readRoutineApproval(store, state, stop.cause, claimPosition, deadline);
  if (reason !== stop.reason || stop.affectedRun !== state?.activeRun?.occurrenceId) {
    throw new Error('Invalid routine prohibition');
  }
}

async function requireLifecycleRun(store: EventStore, state: RoutineState | undefined,
  source: StoredEvent, claimPosition: number, deadline: number) {
  if (source.event.type === 'routine.run_stop_requested') {
    await requireApprovalStop(store, state, source, claimPosition, deadline);
    return;
  }
  if (!isLifecycleProhibition(source.event)) {
    return;
  }
  const checked = lifecycleRun(state, source.event);
  const control = checked.control;
  if (control.source === 'access') {
    if (source.event.type !== 'routine.paused' || !control.cause ||
        control.cause.position >= source.sequence || control.reason !== 'owner_removed') {
      throw new Error('Invalid routine prohibition');
    }
    await readRoutineRemoval(store, state, control.cause, claimPosition, deadline);
  } else if (control.source === 'admin') {
    await requireAdminPause(store, source, deadline);
  } else if (control.source !== 'owner' ||
      control.actorId !== checked.state.definition!.definition.ownerId) {
    throw new Error('Invalid routine prohibition');
  }
}

async function requireAdminPause(store: EventStore, source: StoredEvent, deadline: number) {
  const control = routineControlSchema.parse(source.event.data);
  if (source.event.type !== 'routine.paused' || control.reason !== 'admin_requested') {
    throw new Error('Invalid admin prohibition');
  }
  // Read authority as it stood at the pause. Later demotion must not prevent cleanup.
  async function* readStream(subject: string, from = 1) {
    for await (const row of store.readStream(subject, from, deadline)) {
      if (performance.now() >= deadline) {
        throw new Error('Admin history unavailable');
      }
      if (row.sequence >= source.sequence) {
        return;
      }
      const parsed = parseEventByType(row.event);
      if (!parsed.success || row.event.subject !== subject ||
          (subject.startsWith('member-') && data(row.event)['memberId'] !== control.actorId)) {
        throw new Error('Invalid admin history');
      }
      yield row;
    }
  }
  const history = { readStream };
  const member = await currentMembership(history, source.event.silo, control.actorId,
    undefined, deadline);
  if (!hasActiveAdmission(member.facts, control.actorId) ||
      (member.role !== 'admin' && member.role !== 'owner')) {
    throw new Error('Invalid admin authority');
  }
}

function hasActiveAdmission(facts: StoredEvent[], actorId: string) {
  let active = false;
  for (const row of facts) {
    if (row.event.subject !== `member-${actorId}`) {
      continue;
    }
    if (row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped') {
      active = true;
    } else if (row.event.type === 'member.removed') {
      active = false;
    } else if (row.event.type === 'member.role_changed' && !active) {
      return false;
    }
  }
  return active;
}

function sameFrozenDefinition(state: RoutineState) {
  const run = state.activeRun!;
  const saved = state.definition!;
  return saved.definition.ownerId === run.definition.ownerId &&
    saved.definition.ownerAdmissionId === run.definition.ownerAdmissionId &&
    saved.definitionRevision === run.definitionRevision &&
    saved.scheduleRevision === run.scheduleRevision && saved.controlRevision === run.controlRevision;
}
function removalRun(state: RoutineState | undefined, position: number, claimPosition: number) {
  if (!state?.activeRun || !state.definition || state.status === 'retired' || claimPosition < 1 ||
      position <= claimPosition || position <= (state.activation?.admission.position ?? 0) ||
      !sameFrozenDefinition(state)) {
    throw new Error('Invalid routine removal');
  }
  return state.activeRun;
}
function requireMemberRow(row: StoredEvent, silo: string, subject: string, deadline: number) {
  const parsed = parseEventByType(row.event);
  if (!parsed.success || row.event.silo !== silo || row.event.subject !== subject ||
      performance.now() >= deadline) {
    throw new Error('Invalid routine removal');
  }
  return data(parsed.event);
}
/** Verify removal of the membership recorded by this still-occupied occurrence. */
export async function readRoutineRemoval(store: EventStore, state: RoutineState | undefined,
  cause: { eventId: string; position: number }, claimPosition: number, deadline: number) {
  const run = removalRun(state, cause.position, claimPosition);
  const subject = `member-${run.definition.ownerId}`;
  let admissionId: string | undefined;
  let verified = false;
  let position = 0;
  for await (const row of store.readStream(subject, 1, deadline)) {
    const fields = requireMemberRow(row, state!.silo, subject, deadline);
    position = row.sequence;
    // Keep later membership changes from erasing removal of the original admission.
    if (row.sequence > cause.position) {
      continue;
    }
    if (fields['memberId'] !== run.definition.ownerId) {
      throw new Error('Invalid routine removal');
    }
    if (row.sequence === cause.position) {
      if (row.event.id !== cause.eventId || row.event.type !== 'member.removed' ||
          admissionId !== run.definition.ownerAdmissionId) {
        break;
      }
      verified = true;
    }
    if (row.event.type === 'member.joined' || row.event.type === 'silo.owner_bootstrapped') {
      admissionId = row.event.id;
    } else if (row.event.type === 'member.removed') {
      admissionId = undefined;
    }
  }
  if (verified) {
    return new Map([[subject, position]]);
  }
  throw new Error('Invalid routine removal');
}

async function readRoutineThroughStop(store: EventStore, source: StoredEvent, deadline: number) {
  let routine: RoutineState | undefined;
  let claimPosition = 0;
  const completedRuns = new Map<string, NonNullable<RoutineState['activeRun']>>();
  for await (const row of store.readStream(source.event.subject, 1, deadline)) {
    if (performance.now() >= deadline || row.sequence > source.sequence) {
      break;
    }
    if (row.sequence === source.sequence && row.event.id === source.event.id) {
      await requireLifecycleRun(store, routine, row, claimPosition, deadline);
    }
    routine = foldRoutineHistory(routine, row.event, completedRuns);
    if (row.event.type === 'routine.due') {
      claimPosition = row.sequence;
    }
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
