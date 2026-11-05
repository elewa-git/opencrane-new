import { isDeepStrictEqual } from 'node:util';
import { foldRoutineHistory, type Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { routineRecordIdentitySchema, type RoutineState } from '@opencrane/events';
import { calculateRoutineOccurrence, previewRoutineOccurrences }
  from '@opencrane/events/routine-schedule';
import { routineCandidatePage, type Query } from '@opencrane/projections';
import { claimRoutineDue } from './routine-due.ts';
import { skipRoutineOccurrence } from './routine-skip.ts';
import { recordRoutineMissed } from './routine-missed.ts';

type CommandInput = Parameters<typeof claimRoutineDue>[2];

interface Continuation {
  silo: string;
  afterRoutineId: string;
  afterCreatedPosition: number;
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
        !Number.isSafeInteger(continuation.afterCreatedPosition) ||
        continuation.afterCreatedPosition < 1 ||
        !/^[\w-]{1,200}$/u.test(continuation.afterRoutineId)))) {
    throw new Error('Routine scan refused');
  }
}

async function readCandidate(store: EventStore, silo: string, routineId: string,
  projectedPosition: number, deadline: number, check: () => void) {
  let state: RoutineState | undefined;
  let position = 0;
  const claims = new Map<string, CommandInput>();
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
    if (row.event.type === 'routine.due' && state.activeRun) {
      const run = state.activeRun;
      const input = { routineId, expectedPosition: position,
        localDate: run.slot.localDate, definitionRevision: run.definitionRevision,
        scheduleRevision: run.scheduleRevision, controlRevision: run.controlRevision };
      claims.set(run.occurrenceId, input);
    }
    position = row.sequence;
  }
  check();
  const latest = await store.head(subject, deadline);
  check();
  if (!state || !Number.isSafeInteger(projectedPosition) || projectedPosition < 1 ||
      position < projectedPosition || position !== latest) {
    throw new Error('Routine history unavailable');
  }
  return { state, position, claims };
}

function observation(state: RoutineState, now: number) {
  if (state.status !== 'active') {
    return { category: 'inactive' as const, occurrence: null };
  }
  const saved = state.definition;
  if (!saved) {
    throw new Error('Routine definition unavailable');
  }
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
    if (occurrence.status !== 'dst_skip') {
      throw new Error('Routine slot unavailable');
    }
  }
  if (Date.parse(occurrence.checkAt) <= Date.parse(saved.effectiveAt) ||
      (saved.cursor && occurrence.localDate <= saved.cursor.localDate)) {
    throw new Error('Routine slot unavailable');
  }
  const lateness = now - Date.parse(occurrence.checkAt);
  if (lateness < 0) {
    return { category: 'future' as const, occurrence };
  }
  if (lateness > 60_000) {
    return { category: 'late' as const, occurrence };
  }
  if (occurrence.status === 'dst_skip') {
    return { category: 'gap' as const, occurrence };
  }
  if (state.activeRun) {
    return { category: 'occupied' as const, occurrence };
  }
  return { category: 'eligible' as const, occurrence };
}

/** Inspect one page under withRoutineLeadership. Counts never authorise a command. */
export function scanRoutineCandidates(db: Query, store: EventStore, worker: Worker) {
  return inspectPage(db, store, worker);
}

/** Await each checked command before reporting completed candidate progress. */
export function dispatchRoutineCandidates(db: Query, store: EventStore,
  worker: Worker & { binding: Binding }) {
  if (!worker.binding || worker.binding.silo !== worker.silo) {
    throw new Error('Routine scan unavailable');
  }
  return inspectPage(db, store, worker, worker.binding);
}

async function dispatchCandidate(store: EventStore, worker: Worker, binding: Binding,
  candidate: Awaited<ReturnType<typeof readCandidate>>, observed: ReturnType<typeof observation>) {
  const { state, position, claims } = candidate;
  const { category, occurrence } = observed;
  if (!occurrence || category === 'future') {
    return;
  }
  const saved = state.definition!;
  const input = { routineId: state.routineId, expectedPosition: position,
    localDate: occurrence.localDate, definitionRevision: saved.definitionRevision,
    scheduleRevision: saved.scheduleRevision, controlRevision: saved.controlRevision };
  const trustedWorker = { ...worker, binding };
  const previous = claims.get(occurrence.occurrenceId);
  let result;
  if (previous) {
    // Recover the original claim even after its delivery reply or broker dedupe has expired.
    result = await claimRoutineDue(store, trustedWorker, previous);
  } else if (category === 'late') {
    result = await recordRoutineMissed(store, trustedWorker, input);
  } else if (category === 'eligible') {
    result = await claimRoutineDue(store, trustedWorker, input);
  } else {
    result = await skipRoutineOccurrence(store, trustedWorker, input);
  }
  if (result.status !== 'confirmed' || result.executionAvailable !== false) {
    throw new Error('Routine command unavailable');
  }
}

type Page = Awaited<ReturnType<typeof routineCandidatePage>>;
function pageContinuation(page: Page, examined: number, lastCompleted: Page['rows'][number] | undefined,
  silo: string, checkedAt: number): Continuation | null {
  if (examined === page.rows.length && page.rows.length < 50) {
    return null;
  }
  if (!lastCompleted) {
    throw new Error('Routine scan made no progress');
  }
  return { silo, afterRoutineId: lastCompleted.routine_id,
    afterCreatedPosition: Number(lastCompleted.created_position),
    generation: page.generation, checkedAt };
}

async function inspectPage(db: Query, store: EventStore, worker: Worker, binding?: Binding) {
  try {
    const deadline = performance.now() + 10_000;
    const stopCandidatesAt = deadline - 1000;
    const now = worker.now ?? Date.now;
    const continuation = worker.continuation;
    let checkedAt = continuation?.checkedAt ?? now();
    requireInput(worker, checkedAt);
    function checkTime() {
      const current = now();
      if (worker.signal.aborted ||
          !Number.isFinite(current) || current < checkedAt) {
        throw new Error('Routine scan refused');
      }
      checkedAt = current;
    }
    function check() {
      checkTime();
      if (performance.now() >= deadline) {
        throw new Error('Routine scan refused');
      }
    }
    async function requireLeadership(finishing = false) {
      checkTime();
      let expires = Math.min(deadline, performance.now() + 1000);
      if (finishing && binding) {
        expires = performance.now() + 1000;
      }
      const current = await worker.checkCurrent(expires);
      checkTime();
      if (!current || performance.now() >= expires) {
        throw new Error('Routine scan refused');
      }
    }
    await requireLeadership();
    const minimumPosition = await store.head(undefined, deadline);
    check();
    const page = await routineCandidatePage(db, worker.silo,
      continuation?.afterCreatedPosition ?? 0, minimumPosition, deadline);
    check();
    if (continuation && continuation.generation !== page.generation) {
      throw new Error('Routine scan refused');
    }
    const counts = { eligible: 0, gap: 0, late: 0, occupied: 0, future: 0, inactive: 0 };
    let examined = 0;
    let lastCompleted: (typeof page.rows)[number] | undefined;
    for (const row of page.rows) {
      // Reserve time to verify ownership before returning completed progress.
      if (performance.now() >= stopCandidatesAt) {
        break;
      }
      await requireLeadership();
      const candidate = await readCandidate(store, worker.silo, row.routine_id,
        Number(row.position), deadline, check);
      check();
      const observed = observation(candidate.state, checkedAt);
      if (binding) {
        if (performance.now() >= stopCandidatesAt) {
          break;
        }
        await dispatchCandidate(store, worker, binding, candidate, observed);
        checkTime();
      }
      counts[observed.category] += 1;
      examined += 1;
      lastCompleted = row;
    }
    await requireLeadership(true);
    const next = pageContinuation(page, examined, lastCompleted, worker.silo, checkedAt);
    return { examined, counts, continuation: next,
      executionAvailable: false as const };
  } catch {
    // Keep private event and database details out of worker results.
    throw new Error('Routine scan unavailable');
  }
}
