import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory, memberAuthorisation } from '@opencrane/authz';
import { ownershipWriteAccess } from '@opencrane/models';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { foldRoutine, routineRecordIdentitySchema,
  type EventEnvelope, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence, previewRoutineOccurrences }
  from '@opencrane/events/routine-schedule';
import type { claimRoutineDue } from './routine-due.ts';

type Worker = Parameters<typeof claimRoutineDue>[1];
type Input = Parameters<typeof claimRoutineDue>[2];
type Run = NonNullable<RoutineState['activeRun']>;
type Skip = ReturnType<typeof skipData>['data'];
type Occurrence = ReturnType<typeof calculateRoutineOccurrence>;
class SkipRefused extends Error {
  constructor() {
    super('Routine skip refused');
  }
}
function requireInput(input: Input) {
  const names = ['routineId', 'expectedPosition', 'localDate', 'definitionRevision',
    'scheduleRevision', 'controlRevision'];
  for (const name of Object.keys(input)) {
    if (!names.includes(name)) {
      throw new SkipRefused();
    }
  }
  const revisions = [input.expectedPosition, input.definitionRevision,
    input.scheduleRevision, input.controlRevision];
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new SkipRefused();
    }
  }
  if (typeof input.routineId !== 'string' || !/^[\w-]{1,200}$/u.test(input.routineId) ||
      typeof input.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)) {
    throw new SkipRefused();
  }
}
function requireActive(worker: Worker) {
  if (worker.signal.aborted) {
    throw new SkipRefused();
  }
}
async function loadHistory(store: EventStore, worker: Worker, input: Input) {
  const rows: StoredEvent[] = [];
  let state: RoutineState | undefined;
  const completedRuns = new Map<string, Run>();
  const deadline = performance.now() + 10_000;
  for await (const row of store.readStream(`routine-${input.routineId}`, 1, deadline)) {
    requireActive(worker);
    const identity = routineRecordIdentitySchema.parse(row.event.data);
    if (row.event.silo !== worker.silo || identity.version !== 1 ||
        (rows.length === 0 && row.event.type !== 'routine.created')) {
      throw new SkipRefused();
    }
    state = foldRoutineHistory(state, row.event, completedRuns);
    rows.push(row);
  }
  requireActive(worker);
  if (performance.now() >= deadline) {
    throw new SkipRefused();
  }
  return { rows, state };
}
async function loadClaimAccess(store: EventStore, worker: Worker, input: Input) {
  try {
    if (worker.binding.silo !== worker.silo) {
      throw new SkipRefused();
    }
    const history = await loadHistory(store, worker, input);
    requireActive(worker);
    const ownerId = history.state?.definition?.definition.ownerId;
    if (!ownerId) {
      throw new SkipRefused();
    }
    const auth = memberAuthorisation(worker.binding, store);
    const access = await auth.loadRoutineAccess(ownerId, input.routineId);
    requireActive(worker);
    if (access.rows.at(-1)?.sequence !== history.rows.at(-1)?.sequence) {
      throw new SkipRefused();
    }
    return { ...history, access };
  } catch {
    // Keep missing access and incomplete history indistinguishable to this internal caller.
    throw new SkipRefused();
  }
}
async function requireWorker(worker: Worker, deadline: number) {
  requireActive(worker);
  if (!(await worker.checkCurrent(deadline)) || performance.now() >= deadline) {
    throw new SkipRefused();
  }
  requireActive(worker);
}
async function requireOwner(access: Awaited<ReturnType<typeof loadClaimAccess>>['access'],
  worker: Worker) {
  if (!(await access.check('manage')).allowed) {
    throw new SkipRefused();
  }
  requireActive(worker);
}
async function claimWriteAccess(store: EventStore,
  access: Awaited<ReturnType<typeof loadClaimAccess>>['access'], worker: Worker) {
  try {
    const fresh = await ownershipWriteAccess(store, access.positions);
    requireActive(worker);
    await requireOwner(access, worker);
    return fresh;
  } catch {
    throw new SkipRefused();
  }
}
function slot(occurrence: Occurrence) {
  if (occurrence.status === 'dst_skip') {
    return null;
  }
  return { localDate: occurrence.localDate, localTime: occurrence.localTime,
    zone: occurrence.zone, at: occurrence.at, offsetMinutes: occurrence.offsetMinutes };
}
function skipData(state: RoutineState | undefined, input: Input) {
  const saved = state?.definition;
  if (!saved || state.status !== 'active' ||
      saved.definitionRevision !== input.definitionRevision ||
      saved.scheduleRevision !== input.scheduleRevision ||
      saved.controlRevision !== input.controlRevision ||
      (saved.cursor && saved.cursor.localDate >= input.localDate)) {
    throw new SkipRefused();
  }
  const calculation = { silo: state.silo, routineId: input.routineId,
    scheduleRevision: saved.scheduleRevision, schedule: saved.definition.schedule,
    localDate: input.localDate };
  const occurrence = calculateRoutineOccurrence(calculation);
  const { localDate: _localDate, ...identity } = calculation;
  const firstInput = { ...identity, now: saved.effectiveAt, effectiveAt: saved.effectiveAt,
    afterLocalDate: saved.cursor?.localDate, count: 1 };
  const currentSlot = slot(occurrence);
  let savedSlot = saved.next;
  if (savedSlot) {
    savedSlot = { ...savedSlot, at: new Date(savedSlot.at).toISOString() };
  }
  if (!isDeepStrictEqual(savedSlot, currentSlot) ||
      Date.parse(occurrence.checkAt) <= Date.parse(saved.effectiveAt)) {
    throw new SkipRefused();
  }
  const reason = skipReason(state, occurrence, firstInput);
  const nextInput = { ...firstInput, now: occurrence.checkAt, afterLocalDate: input.localDate };
  const following = previewRoutineOccurrences(nextInput)[0]!;
  const data = { version: 1 as const, routineId: input.routineId,
    definitionRevision: input.definitionRevision, scheduleRevision: input.scheduleRevision,
    controlRevision: input.controlRevision, occurrenceId: occurrence.occurrenceId,
    localDate: occurrence.localDate, localTime: occurrence.localTime, zone: occurrence.zone,
    reason, cursor: currentSlot ?? saved.cursor, next: slot(following) };
  return { data, checkAt: occurrence.checkAt };
}
function skipReason(state: RoutineState, occurrence: Occurrence, firstInput: unknown) {
  if (occurrence.status === 'dst_skip') {
    const first = previewRoutineOccurrences(firstInput)[0]!;
    if (first.localDate !== occurrence.localDate) {
      throw new SkipRefused();
    }
    return 'dst' as const;
  }
  if (!state.activeRun || state.activeRun.occurrenceId === occurrence.occurrenceId) {
    throw new SkipRefused();
  }
  return 'overlap' as const;
}
function requireTime(checkAt: string, now: number, started: number) {
  const lateness = now - Date.parse(checkAt);
  if (!Number.isFinite(now) || now < started || lateness < 0 || lateness > 60_000) {
    throw new SkipRefused();
  }
}
function envelope(silo: string, data: Skip, time: string): EventEnvelope {
  const id = `routine-skip-${data.occurrenceId}`;
  return { id, commandId: id, silo, source: 'opencrane-server',
    type: 'routine.occurrence_skipped', subject: `routine-${data.routineId}`, time,
    principal: { kind: 'system', id: 'opencrane-server' }, correlation: {}, data };
}
function savedReceipt(row: StoredEvent, state: RoutineState | undefined, input: Input) {
  const expected = skipData(state, input);
  let time = row.event.time;
  if (expected.data.reason === 'dst') {
    time = expected.checkAt;
  }
  requireTime(expected.checkAt, Date.parse(time), Date.parse(expected.checkAt));
  if (!isDeepStrictEqual(row.event, envelope(row.event.silo, expected.data, time))) {
    throw new SkipRefused();
  }
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence,
    occurrenceId: expected.data.occurrenceId, executionAvailable: false as const };
}
function previousReceipt(rows: StoredEvent[], input: Input) {
  let state: RoutineState | undefined;
  const completedRuns = new Map<string, Run>();
  let position = 0;
  for (const row of rows) {
    if (position === input.expectedPosition && row.event.type === 'routine.occurrence_skipped') {
      return savedReceipt(row, state, input);
    }
    state = foldRoutineHistory(state, row.event, completedRuns);
    position = row.sequence;
  }
  return undefined;
}

function appendedPosition(result: Awaited<ReturnType<EventStore['append']>>) {
  if (result.status === 'conflict' || result.status === 'rejected') {
    throw new SkipRefused();
  }
  if (result.status === 'appended') {
    return result.sequence;
  }
  if (result.cause instanceof SkipRefused) {
    throw result.cause;
  }
  throw new Error('Append unavailable');
}

/** Record one checked skip without starting or replacing work. */
export async function skipRoutineOccurrence(store: EventStore, worker: Worker, input: Input) {
  try {
    requireInput(input);
    requireActive(worker);
    const saved = await loadClaimAccess(store, worker, input);
    const previous = previousReceipt(saved.rows, input);
    if (previous) {
      const fresh = await claimWriteAccess(store, saved.access, worker);
      await requireWorker(worker, fresh.deadline);
      await fresh();
      requireActive(worker);
      return previous;
    }
    if (saved.rows.at(-1)?.sequence !== input.expectedPosition) {
      throw new SkipRefused();
    }
    const expected = skipData(saved.state, input);
    const now = worker.now ?? Date.now;
    const started = now();
    requireTime(expected.checkAt, started, started);
    let time = new Date(started).toISOString();
    if (expected.data.reason === 'dst') {
      time = expected.checkAt;
    }
    const event = envelope(worker.silo, expected.data, time);
    for (const row of saved.rows) {
      if (typeof row.event.data === 'object' && row.event.data !== null &&
          Reflect.get(row.event.data, 'occurrenceId') === expected.data.occurrenceId) {
        throw new SkipRefused();
      }
    }
    foldRoutine(saved.state, event);
    // Finish history before watching only the small streams that grant access.
    const fresh = await claimWriteAccess(store, saved.access, worker);
    const deadline = fresh.deadline;
    async function checkAccess() {
      await requireWorker(worker, deadline);
      try {
        await fresh();
      } catch {
        throw new SkipRefused();
      }
      requireActive(worker);
      requireTime(expected.checkAt, now(), started);
    }
    await checkAccess();
    const change = { event, expectedSequence: input.expectedPosition,
      historyChecked: true as const, deadline, checkAccess, signal: worker.signal };
    // Carry cancellation through the store's last awaited access check.
    const result = await store.append(change);
    requireActive(worker);
    const position = appendedPosition(result);
    const row = await store.readEvent(position, performance.now() + 10_000);
    requireActive(worker);
    const confirmed = savedReceipt(row, saved.state, input);
    await requireOwner(saved.access, worker);
    await checkAccess();
    return confirmed;
  } catch (error) {
    if (error instanceof SkipRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Do not expose private service details.
    throw new Error('Routine skip unavailable');
  }
}
