import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory, memberAuthorisation } from '@opencrane/authz';
import { ownershipWriteAccess } from '@opencrane/models';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { foldRoutine, routineMissedSchema, routineRecordIdentitySchema,
  type EventEnvelope, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence, previewRoutineOccurrences }
  from '@opencrane/events/routine-schedule';
import type { claimRoutineDue } from './routine-due.ts';

type Worker = Parameters<typeof claimRoutineDue>[1];
type Input = Parameters<typeof claimRoutineDue>[2];
type Run = NonNullable<RoutineState['activeRun']>;
type Missed = ReturnType<typeof missedData>;
type Occurrence = ReturnType<typeof calculateRoutineOccurrence>;
class MissedRefused extends Error {
  constructor() {
    super('Routine missed refused');
  }
}
function requireInput(input: Input) {
  const names = ['routineId', 'expectedPosition', 'localDate', 'definitionRevision',
    'scheduleRevision', 'controlRevision'];
  for (const name of Object.keys(input)) {
    if (!names.includes(name)) {
      throw new MissedRefused();
    }
  }
  const revisions = [input.expectedPosition, input.definitionRevision,
    input.scheduleRevision, input.controlRevision];
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new MissedRefused();
    }
  }
  if (typeof input.routineId !== 'string' || !/^[\w-]{1,200}$/u.test(input.routineId) ||
      typeof input.localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(input.localDate)) {
    throw new MissedRefused();
  }
}
function requireActive(worker: Worker) {
  if (worker.signal.aborted) {
    throw new MissedRefused();
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
      throw new MissedRefused();
    }
    state = foldRoutineHistory(state, row.event, completedRuns);
    rows.push(row);
  }
  requireActive(worker);
  if (performance.now() >= deadline) {
    throw new MissedRefused();
  }
  return { rows, state };
}
async function loadClaimAccess(store: EventStore, worker: Worker, input: Input) {
  try {
    if (worker.binding.silo !== worker.silo) {
      throw new MissedRefused();
    }
    const history = await loadHistory(store, worker, input);
    requireActive(worker);
    const ownerId = history.state?.definition?.definition.ownerId;
    if (!ownerId) {
      throw new MissedRefused();
    }
    const auth = memberAuthorisation(worker.binding, store);
    const access = await auth.loadRoutineAccess(ownerId, input.routineId);
    requireActive(worker);
    if (access.rows.at(-1)?.sequence !== history.rows.at(-1)?.sequence) {
      throw new MissedRefused();
    }
    return { ...history, access };
  } catch {
    // Keep missing access and incomplete history indistinguishable to this internal caller.
    throw new MissedRefused();
  }
}
async function requireWorker(worker: Worker, deadline: number) {
  requireActive(worker);
  if (!(await worker.checkCurrent(deadline)) || performance.now() >= deadline) {
    throw new MissedRefused();
  }
  requireActive(worker);
}
async function requireOwner(access: Awaited<ReturnType<typeof loadClaimAccess>>['access'],
  worker: Worker) {
  if (!(await access.check('manage')).allowed) {
    throw new MissedRefused();
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
    throw new MissedRefused();
  }
}
function slot(occurrence: Occurrence) {
  if (occurrence.status === 'dst_skip') {
    return null;
  }
  return { localDate: occurrence.localDate, localTime: occurrence.localTime,
    zone: occurrence.zone, at: occurrence.at, offsetMinutes: occurrence.offsetMinutes };
}
function checkedDefinition(state: RoutineState | undefined, input: Input, now: number) {
  const saved = state?.definition;
  if (!saved || state.status !== 'active' || !Number.isFinite(now) ||
      saved.definition.schedule.frequency !== 'daily' ||
      saved.definitionRevision !== input.definitionRevision ||
      saved.scheduleRevision !== input.scheduleRevision ||
      saved.controlRevision !== input.controlRevision ||
      (saved.cursor && saved.cursor.localDate >= input.localDate)) {
    throw new MissedRefused();
  }
  return saved;
}
function rangeStart(state: RoutineState | undefined, input: Input, now: number) {
  const saved = checkedDefinition(state, input, now);
  const calculation = { silo: state!.silo, routineId: input.routineId,
    scheduleRevision: saved.scheduleRevision, schedule: saved.definition.schedule,
    now: saved.effectiveAt, effectiveAt: saved.effectiveAt, count: 1 };
  const firstInput = { ...calculation, afterLocalDate: saved.cursor?.localDate };
  let occurrence = previewRoutineOccurrences(firstInput)[0]!;
  if (saved.next) {
    const { now: _now, effectiveAt: _effectiveAt, count: _count, ...identity } = calculation;
    const requested = { ...identity, localDate: saved.next.localDate };
    occurrence = calculateRoutineOccurrence(requested);
    const expected = { ...saved.next, at: new Date(saved.next.at).toISOString() };
    if (!isDeepStrictEqual(slot(occurrence), expected)) {
      throw new MissedRefused();
    }
  } else if (occurrence.status !== 'dst_skip') {
    throw new MissedRefused();
  }
  if (occurrence.localDate !== input.localDate ||
      Date.parse(occurrence.checkAt) <= Date.parse(saved.effectiveAt)) {
    throw new MissedRefused();
  }
  return { saved, occurrence, calculation };
}
function consumedOccurrences(rows: StoredEvent[], input: Input) {
  const consumed = new Set<string>();
  for (const row of rows) {
    if (row.event.type === 'routine.occurrences_missed') {
      const prior = routineMissedSchema.parse(row.event.data);
      if (prior.scheduleRevision === input.scheduleRevision &&
          prior.lastLocalDate >= input.localDate) {
        throw new MissedRefused();
      }
    }
    const data = row.event.data;
    if (typeof data === 'object' && data !== null) {
      const occurrenceId: unknown = Reflect.get(data, 'occurrenceId');
      if (typeof occurrenceId === 'string') {
        consumed.add(occurrenceId);
      }
    }
  }
  return consumed;
}
function missedData(state: RoutineState | undefined, input: Input,
  rows: StoredEvent[], now: number) {
  const start = rangeStart(state, input, now);
  const { saved, calculation } = start;
  let occurrence = start.occurrence;
  const consumed = consumedOccurrences(rows, input);
  let firstLocalDate = '';
  let lastLocalDate = '';
  let count = 0;
  let cursor = saved.cursor;
  // Limit calendar work before the access check; later calls use the saved next slot.
  for (let index = 0; index < 100; index++) {
    if (now - Date.parse(occurrence.checkAt) <= 60_000) {
      break;
    }
    if (occurrence.status === 'scheduled' && !consumed.has(occurrence.occurrenceId)) {
      if (count === 0) {
        firstLocalDate = occurrence.localDate;
      }
      lastLocalDate = occurrence.localDate;
      count++;
      cursor = slot(occurrence);
    }
    // Advance by local date so a whole-day gap cannot discard its next valid instant.
    const following = { ...calculation, afterLocalDate: occurrence.localDate };
    occurrence = previewRoutineOccurrences(following)[0]!;
  }
  if (count === 0) {
    throw new MissedRefused();
  }
  return { version: 1 as const, routineId: input.routineId,
    definitionRevision: input.definitionRevision, scheduleRevision: input.scheduleRevision,
    controlRevision: input.controlRevision, firstLocalDate, lastLocalDate, count,
    reason: 'downtime' as const, cursor, next: slot(occurrence) };
}
function envelope(silo: string, input: Input, data: Missed, time: string): EventEnvelope {
  const identity = JSON.stringify([silo, input.expectedPosition, data]);
  const hash = createHash('sha256');
  hash.update(identity);
  const id = `routine-missed-${hash.digest('hex')}`;
  return { id, commandId: id, silo, source: 'opencrane-server',
    type: 'routine.occurrences_missed', subject: `routine-${data.routineId}`, time,
    principal: { kind: 'system', id: 'opencrane-server' }, correlation: {}, data };
}
function savedReceipt(row: StoredEvent, state: RoutineState | undefined,
  rows: StoredEvent[], input: Input) {
  const data = missedData(state, input, rows, Date.parse(row.event.time));
  const expected = envelope(row.event.silo, input, data, row.event.time);
  if (!isDeepStrictEqual(row.event, expected)) {
    throw new MissedRefused();
  }
  return { status: 'confirmed' as const, eventId: row.event.id, position: row.sequence,
    executionAvailable: false as const };
}
function previousReceipt(rows: StoredEvent[], input: Input) {
  let state: RoutineState | undefined;
  const completedRuns = new Map<string, Run>();
  let position = 0;
  const preceding: StoredEvent[] = [];
  for (const row of rows) {
    if (position === input.expectedPosition && row.event.type === 'routine.occurrences_missed') {
      return savedReceipt(row, state, preceding, input);
    }
    state = foldRoutineHistory(state, row.event, completedRuns);
    position = row.sequence;
    preceding.push(row);
  }
  return undefined;
}

function appendedPosition(result: Awaited<ReturnType<EventStore['append']>>) {
  if (result.status === 'conflict' || result.status === 'rejected') {
    throw new MissedRefused();
  }
  if (result.status === 'appended') {
    return result.sequence;
  }
  if (result.cause instanceof MissedRefused) {
    throw result.cause;
  }
  throw new Error('Append unavailable');
}

/** Record a bounded range of old unclaimed slots without starting or replacing work. */
export async function recordRoutineMissed(store: EventStore, worker: Worker, input: Input) {
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
      throw new MissedRefused();
    }
    const now = worker.now ?? Date.now;
    const started = now();
    const data = missedData(saved.state, input, saved.rows, started);
    const event = envelope(worker.silo, input, data, new Date(started).toISOString());
    foldRoutine(saved.state, event);
    // Finish history before watching only the small streams that grant access.
    const fresh = await claimWriteAccess(store, saved.access, worker);
    const deadline = fresh.deadline;
    async function checkAccess() {
      await requireWorker(worker, deadline);
      try {
        await fresh();
      } catch {
        throw new MissedRefused();
      }
      requireActive(worker);
      const current = now();
      if (!Number.isFinite(current) || current < started) {
        throw new MissedRefused();
      }
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
    const confirmed = savedReceipt(row, saved.state, saved.rows, input);
    await requireOwner(saved.access, worker);
    await checkAccess();
    return confirmed;
  } catch (error) {
    if (error instanceof MissedRefused) {
      throw error;
    }
    // eslint-disable-next-line preserve-caught-error -- Do not expose private service details.
    throw new Error('Routine missed unavailable');
  }
}
