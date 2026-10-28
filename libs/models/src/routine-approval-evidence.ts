import { isDeepStrictEqual } from 'node:util';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { approvalDecidedDataSchema, budgetRootAllowanceSetDataSchema,
  conversationCreatedDataSchema, parseEventByType, toolApprovalRequestedDataSchema,
  type RoutineState } from '@opencrane/events';
import { data } from './state.ts';
import { history } from './event-history.ts';

type Cause = { eventId: string; position: number };
type Run = NonNullable<RoutineState['activeRun']>;
type Request = ReturnType<typeof toolApprovalRequestedDataSchema.parse>;
function refuse(): never {
  throw new Error('Routine approval evidence refused');
}
function requireRow(row: StoredEvent | undefined, silo: string, subject: string) {
  if (!row || !parseEventByType(row.event).success ||
      row.event.silo !== silo || row.event.subject !== subject) {
    return refuse();
  }
  return row;
}
function ownerDecision(row: StoredEvent, ownerId: string, decision: 'approved' | 'rejected') {
  const event = row.event;
  if (event.type !== 'approval.decided' || event.source !== 'opencrane-server' ||
      event.principal?.kind !== 'human' || event.principal.id !== ownerId) {
    return false;
  }
  const saved = approvalDecidedDataSchema.parse(event.data);
  return saved.decision === decision && saved.decidedBy === ownerId;
}
function terminalReason(row: StoredEvent, ownerId: string, expiresAt: string) {
  const event = row.event;
  const at = Date.parse(event.time);
  const expiry = Date.parse(expiresAt);
  if (event.type === 'approval.expired' && at >= expiry && event.source === 'models' &&
      event.principal?.kind === 'system' && event.principal.id === 'models') {
    return 'approval_expired';
  }
  // Keep a saved rejection valid if publication crossed the expiry boundary.
  if (ownerDecision(row, ownerId, 'rejected')) {
    return 'approval_denied';
  }
  return refuse();
}
function requireModelsSource(row: StoredEvent, type: string) {
  const event = row.event;
  if (event.type !== type || event.source !== 'models' ||
      event.principal?.kind !== 'system' || event.principal.id !== 'models') {
    return refuse();
  }
}
function requireCreation(row: StoredEvent, run: Run, count: number) {
  const expectedId = `routine-session-create-${run.occurrenceId}`;
  const event = row.event;
  if (count !== 1 || event.source !== 'opencrane-server' || event.id !== expectedId ||
      event.commandId !== expectedId || event.principal?.kind !== 'human' ||
      event.principal.id !== run.definition.ownerId ||
      run.conversationId !== `routine-session-${run.occurrenceId}`) {
    return refuse();
  }
}
async function requirePreparation(store: EventStore, state: RoutineState, run: Run,
  claimPosition: number, deadline: number) {
  const subject = `conversation-${run.conversationId}`;
  const rows = await history(store, subject, state.silo, deadline);
  function creation(row: StoredEvent) {
    return row.event.type === 'conversation.created';
  }
  const creations = rows.filter(creation);
  const row = requireRow(creations[0], state.silo, subject);
  const created = conversationCreatedDataSchema.parse(row.event.data);
  requireCreation(row, run, creations.length);
  if (!('routinePreparation' in created) || !created.routinePreparation ||
      created.mode !== 'agent_session' ||
      created.createdBy !== run.definition.ownerId ||
      created.conversationId !== run.conversationId ||
      created.assistantId !== run.definition.assistantId ||
      created.payingGroupId !== run.definition.payingGroupId) {
    return refuse();
  }
  const marker = created.routinePreparation;
  const claimSubject = `routine-${state.routineId}`;
  const claim = await readEventAt(store, claimSubject, claimPosition, deadline);
  if (!claim || marker.routineId !== state.routineId ||
      marker.occurrenceId !== run.occurrenceId || marker.claimPosition !== claimPosition ||
      marker.claimId !== claim.event.id || row.sequence <= claimPosition ||
      !isDeepStrictEqual(claim.event.data, run)) {
    return refuse();
  }
  return row.sequence;
}
async function requireAllocation(store: EventStore, state: RoutineState, run: Run,
  preparationPosition: number, requestPosition: number, deadline: number) {
  const admission = state.activation?.admission;
  if (!admission || admission.position <= preparationPosition ||
      admission.position >= requestPosition) {
    return refuse();
  }
  const subject = `budget-${state.silo}`;
  const saved = await readEventAt(store, subject, admission.position, deadline);
  const row = requireRow(saved, state.silo, subject);
  requireModelsSource(row, 'budget.root_allowance_set');
  const root = budgetRootAllowanceSetDataSchema.parse(row.event.data);
  if (row.event.id !== admission.eventId || !root.preparationDigest ||
      root.conversationId !== run.conversationId || root.turnId !== run.turnId ||
      root.requesterId !== run.definition.ownerId || root.assistantId !== run.definition.assistantId ||
      root.payingGroupId !== run.definition.payingGroupId) {
    return refuse();
  }
}

function requireRun(state: RoutineState | undefined) {
  const run = state?.activeRun;
  if (!state || !run || !state.definition || state.status !== 'active' || state.stopRequested ||
      state.definition.definitionRevision !== run.definitionRevision ||
      state.definition.scheduleRevision !== run.scheduleRevision ||
      state.definition.controlRevision !== run.controlRevision ||
      !isDeepStrictEqual(state.definition.definition, run.definition)) {
    return refuse();
  }
  return { state, run };
}

function requireRequest(requested: StoredEvent, terminal: StoredEvent, run: Run,
  request: Request) {
  requireModelsSource(requested, 'tool.approval_requested');
  const ended = data(terminal.event);
  // Allow the request timestamp to follow the start of the hold, as the Ask writer does.
  const remainingHoldMs = Date.parse(request.expiresAt) - Date.parse(requested.event.time);
  if (ended['approvalId'] !== request.approvalId ||
      request.requesterId !== run.definition.ownerId ||
      request.assistantId !== run.definition.assistantId ||
      request.conversationId !== run.conversationId || request.turnId !== run.turnId ||
      remainingHoldMs <= 0 || remainingHoldMs > 900_000 ||
      Date.parse(terminal.event.time) < Date.parse(requested.event.time)) {
    return refuse();
  }
}

function requireTerminal(rows: StoredEvent[], source: StoredEvent, request: Request) {
  let index = 1;
  const firstChange = rows[index];
  if (source.event.type === 'approval.expired' && firstChange?.event.type === 'approval.decided') {
    requireRow(firstChange, source.event.silo, source.event.subject);
    if (!ownerDecision(firstChange, request.requesterId, 'approved') ||
        data(firstChange.event)['approvalId'] !== request.approvalId) {
      return refuse();
    }
    index++;
  }
  const terminal = rows[index];
  if (!terminal || terminal.sequence !== source.sequence || terminal.event.id !== source.event.id) {
    return refuse();
  }
}

/** Read saved terminal evidence without expiring a card or opening its encrypted review. */
export async function readRoutineApproval(store: EventStore, previous: RoutineState | undefined,
  cause: Cause, claimPosition: number, deadline: number) {
  const { state, run } = requireRun(previous);
  const source = await store.readEvent(cause.position, deadline);
  requireRow(source, state.silo, source.event.subject);
  if (source.sequence !== cause.position || source.event.id !== cause.eventId) {
    return refuse();
  }
  const rows = await history(store, source.event.subject, state.silo, deadline);
  const requested = rows[0];
  if (!requested || requested.event.type !== 'tool.approval_requested') {
    return refuse();
  }
  const request = toolApprovalRequestedDataSchema.parse(requested.event.data);
  const subject = `approval-${request.approvalId}`;
  requireRow(requested, state.silo, subject);
  const terminal = requireRow(source, state.silo, subject);
  requireRequest(requested, terminal, run, request);
  requireTerminal(rows, source, request);
  const reason = terminalReason(terminal, run.definition.ownerId, request.expiresAt);
  const prepared = await requirePreparation(store, state, run, claimPosition, deadline);
  await requireAllocation(store, state, run, prepared, requested.sequence, deadline);
  return reason;
}
