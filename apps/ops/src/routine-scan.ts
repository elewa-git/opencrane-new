import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { routineRecordIdentitySchema, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence, previewRoutineOccurrences }
  from '@opencrane/events/routine-schedule';
import { routineCandidatePage, type Query } from '@opencrane/projections';

interface Continuation {
  silo: string;
  afterRoutineId: string;
  generation: number;
  checkedAt: number;
}
interface Worker {
  silo: string;
  signal: AbortSignal;
  checkCurrent: (deadline: number) => Promise<boolean>;
  now?: () => number;
  continuation?: Continuation | null;
}

function requireInput(worker: Worker, checkedAt: number) {
  const continuation = worker.continuation;
  if (!Number.isFinite(checkedAt) || !/^[\w-]{1,200}$/u.test(worker.silo) ||
      (continuation && (continuation.silo !== worker.silo ||
        !/^[\w-]{1,200}$/u.test(continuation.afterRoutineId)))) {
    throw new Error('Routine scan refused');
  }
}

async function readCandidate(store: EventStore, silo: string, routineId: string,
  projectedPosition: number, deadline: number, check: () => void) {
  let state: RoutineState | undefined;
  let position = 0;
  const completed = new Map<string, NonNullable<RoutineState['activeRun']>>();
  const subject = `routine-${routineId}`;
  for await (const row of store.readStream(subject, 1, deadline)) {
    check();
    const identity = routineRecordIdentitySchema.parse(row.event.data);
    if (row.event.silo !== silo || row.event.subject !== subject ||
        identity.routineId !== routineId || row.sequence <= position ||
        (!state && row.event.type !== 'routine.created')) {
      throw new Error('Routine history unavailable');
    }
    state = foldRoutineHistory(state, row.event, completed);
    position = row.sequence;
  }
  check();
  const latest = await store.head(subject, deadline);
  check();
  if (!state || !Number.isSafeInteger(projectedPosition) || projectedPosition < 1 ||
      position < projectedPosition || position !== latest) {
    throw new Error('Routine history unavailable');
  }
  return state;
}

function observation(state: RoutineState, now: number) {
  if (state.status !== 'active') return 'inactive';
  const saved = state.definition;
  if (!saved) throw new Error('Routine definition unavailable');
  const identity = { silo: state.silo, routineId: state.routineId,
    scheduleRevision: saved.scheduleRevision, schedule: saved.definition.schedule };
  let occurrence;
  if (saved.next) {
    const input = { ...identity, localDate: saved.next.localDate };
    occurrence = calculateRoutineOccurrence(input);
    const slot = { localDate: occurrence.localDate, localTime: occurrence.localTime,
      zone: occurrence.zone, at: occurrence.at, offsetMinutes: occurrence.offsetMinutes };
    const expected = { ...saved.next, at: new Date(saved.next.at).toISOString() };
    if (!isDeepStrictEqual(slot, expected)) {
      throw new Error('Routine slot unavailable');
    }
  } else {
    const input = { ...identity, now: saved.effectiveAt, effectiveAt: saved.effectiveAt,
      afterLocalDate: saved.cursor?.localDate, count: 1 };
    occurrence = previewRoutineOccurrences(input)[0]!;
    if (occurrence.status !== 'dst_skip') throw new Error('Routine slot unavailable');
  }
  if (Date.parse(occurrence.checkAt) <= Date.parse(saved.effectiveAt) ||
      (saved.cursor && occurrence.localDate <= saved.cursor.localDate)) {
    throw new Error('Routine slot unavailable');
  }
  const lateness = now - Date.parse(occurrence.checkAt);
  if (lateness < 0) return 'future';
  if (lateness > 60_000) return 'late';
  if (occurrence.status === 'dst_skip') return 'gap';
  if (state.activeRun) return 'occupied';
  return 'eligible';
}

/** Inspect one page under withRoutineLeadership. Counts never authorise a command. */
export async function scanRoutineCandidates(db: Query, store: EventStore, worker: Worker) {
  try {
    const deadline = performance.now() + 10_000;
    const now = worker.now ?? Date.now;
    const continuation = worker.continuation;
    let checkedAt = continuation?.checkedAt ?? now();
    requireInput(worker, checkedAt);
    function check() {
      const current = now();
      if (worker.signal.aborted || performance.now() >= deadline ||
          !Number.isFinite(current) || current < checkedAt) {
        throw new Error('Routine scan refused');
      }
      checkedAt = current;
    }
    async function requireLeadership() {
      check();
      const expires = Math.min(deadline, performance.now() + 1000);
      const current = await worker.checkCurrent(expires);
      check();
      if (!current || performance.now() >= expires) throw new Error('Routine scan refused');
    }
    await requireLeadership();
    const minimumPosition = await store.head(undefined, deadline);
    check();
    const page = await routineCandidatePage(db, worker.silo,
      continuation?.afterRoutineId ?? '', minimumPosition, deadline);
    check();
    if (continuation && continuation.generation !== page.generation) {
      throw new Error('Routine scan refused');
    }
    const counts = { eligible: 0, gap: 0, late: 0, occupied: 0, future: 0, inactive: 0 };
    for (const row of page.rows) {
      await requireLeadership();
      const state = await readCandidate(store, worker.silo, row.routine_id,
        Number(row.position), deadline, check);
      check();
      const category = observation(state, checkedAt);
      counts[category] += 1;
    }
    await requireLeadership();
    let next: Continuation | null = null;
    if (page.rows.length === 50) {
      next = { silo: worker.silo, afterRoutineId: page.rows[49]!.routine_id,
        generation: page.generation, checkedAt };
    }
    return { examined: page.rows.length, counts, continuation: next,
      executionAvailable: false as const };
  } catch {
    // Keep private event and database details out of worker results.
    throw new Error('Routine scan unavailable');
  }
}
