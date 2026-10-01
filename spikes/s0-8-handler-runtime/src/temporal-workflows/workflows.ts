import { assertCents } from '../money.ts';
// Workflow code runs in Temporal's deterministic sandbox: no direct I/O, no
// Node built-ins, only the @temporalio/workflow API and proxied activities.
import * as wf from '@temporalio/workflow';
import type * as activities from './activities.ts';

// Four attempts in total (one try and three retries), the same shape as the
// pg-boss retry tests. startToCloseTimeout is generous: it must exceed a
// healthy handler's run time or a slow-but-fine run would be retried.
const { applyEvent } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { initialInterval: '200ms', backoffCoefficient: 2, maximumInterval: '2s', maximumAttempts: 4 },
});

// A slower retry profile (four attempts, gaps of 1, 2 and 4 seconds) so
// a test can look at an activity while it is between attempts.
const { applyEvent: applyEventSlowRetry } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '30s',
  retry: { initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '4s', maximumAttempts: 4 },
});

// Crash recovery: no startToCloseTimeout pressure, the server notices a dead
// worker through the missing heartbeat instead.
const { applyEffect } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '60s',
  heartbeatTimeout: '2s',
  retry: { initialInterval: '100ms', maximumAttempts: 5 },
});

const { appendBudgetEntry } = wf.proxyActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { initialInterval: '100ms', maximumAttempts: 3 },
});
const { appendBudgetEntry: appendBudgetEntryLocal } = wf.proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '10s',
  retry: { initialInterval: '100ms', maximumAttempts: 3 },
});

/** One-shot workflow for the crash-recovery test. */
export async function crashRecoveryWorkflow(
  input: activities.ApplyEffectInput,
): Promise<{ alreadyApplied: boolean; attempt: number }> {
  return applyEffect(input);
}

// ---------------------------------------------------------------------------
// One workflow per key: the ordered, single-writer event processor
// ---------------------------------------------------------------------------

export interface QueuedEvent {
  /** Unique event id: a repeat delivery of the same id is ignored. */
  eventId: string;
  seq: number;
  delayMs?: number | undefined;
  poison?: boolean | undefined;
  failUntilAttempt?: number | undefined;
}

export interface DeadLetter {
  eventId: string;
  seq: number;
  message: string;
}

export interface KeyedProcessorInput {
  key: string;
  /** Finish the workflow once this many events have been processed (tests use it to await completion). */
  completeAfter?: number | undefined;
  /** Use the slower retry profile (so tests can observe the gaps between attempts). */
  slowRetry?: boolean | undefined;
  /** Continue as new after this many processed events, to keep the history bounded. */
  maxEventsPerRun?: number | undefined;
  /** State carried over from the previous run when continuing as new. */
  carry?: KeyedProcessorState | undefined;
}

export interface KeyedProcessorState {
  queue: QueuedEvent[];
  seen: string[];
  processedCount: number;
  processedTail: number[];
  duplicatesIgnored: number;
  deadLetter: DeadLetter | null;
  skipped: { eventId: string; seq: number }[];
  runNumber: number;
}

export const pushEventSignal = wf.defineSignal<[QueuedEvent]>('pushEvent');
/** Operator step: run the dead-lettered head event again (order is preserved). */
export const retryHeadSignal = wf.defineSignal<[]>('retryHead');
/** Operator step: drop the dead-lettered head event on purpose (an audited skip). */
export const skipHeadSignal = wf.defineSignal<[]>('skipHead');
export const stateQuery = wf.defineQuery<KeyedProcessorState>('state');

/**
 * One workflow per key, with one awaited activity at a time in the loop below.
 * Workflow JavaScript is single-threaded, but async handlers can interleave.
 * The loop (and the budget mutex below) provides the required serialisation.
 */
export async function keyedEventProcessor(input: KeyedProcessorInput): Promise<void> {
  const carry = input.carry;
  const state: KeyedProcessorState = {
    queue: carry?.queue ?? [],
    seen: carry?.seen ?? [],
    processedCount: carry?.processedCount ?? 0,
    processedTail: carry?.processedTail ?? [],
    duplicatesIgnored: carry?.duplicatesIgnored ?? 0,
    deadLetter: carry?.deadLetter ?? null,
    skipped: carry?.skipped ?? [],
    runNumber: (carry?.runNumber ?? 0) + 1,
  };
  const seenSet = new Set(state.seen);
  let processedThisRun = 0;
  const run = input.slowRetry ? applyEventSlowRetry : applyEvent;

  wf.setHandler(pushEventSignal, (ev) => {
    if (seenSet.has(ev.eventId)) {
      state.duplicatesIgnored++;
      return;
    }
    seenSet.add(ev.eventId);
    state.seen.push(ev.eventId);
    state.queue.push(ev);
  });
  wf.setHandler(retryHeadSignal, () => {
    state.deadLetter = null;
  });
  wf.setHandler(skipHeadSignal, () => {
    if (state.deadLetter !== null) {
      const head = state.queue.shift();
      if (head) state.skipped.push({ eventId: head.eventId, seq: head.seq });
      state.deadLetter = null;
    }
  });
  wf.setHandler(stateQuery, () => state);

  for (;;) {
    await wf.condition(() => state.queue.length > 0 && state.deadLetter === null);
    const ev = state.queue[0] as QueuedEvent; // peek: only remove it once it has really succeeded
    try {
      await run({
        key: input.key,
        seq: ev.seq,
        delayMs: ev.delayMs,
        poison: ev.poison,
        failUntilAttempt: ev.failUntilAttempt,
      });
      state.queue.shift();
      state.processedCount++;
      state.processedTail.push(ev.seq);
      if (state.processedTail.length > 50) state.processedTail.shift();
      processedThisRun++;
    } catch (err) {
      // The activity's own retries are used up. Keep the event at the head
      // of this key's queue (it is never skipped) and record it as dead.
      // Temporal wraps the real error as the `cause` of an ActivityFailure.
      const cause = err instanceof Error && 'cause' in err ? (err as Error & { cause?: unknown }).cause : undefined;
      const message = cause instanceof Error ? cause.message : err instanceof Error ? err.message : String(err);
      state.deadLetter = { eventId: ev.eventId, seq: ev.seq, message };
      continue;
    }

    if (input.completeAfter !== undefined && state.processedCount >= input.completeAfter) return;

    if (input.maxEventsPerRun !== undefined && processedThisRun >= input.maxEventsPerRun) {
      await wf.condition(wf.allHandlersFinished);
      await wf.continueAsNew<typeof keyedEventProcessor>({
        key: input.key,
        completeAfter: input.completeAfter,
        slowRetry: input.slowRetry,
        maxEventsPerRun: input.maxEventsPerRun,
        carry: state,
      });
    }
  }
}

/**
 * NEGATIVE CONTROL only: one workflow per EVENT instead of one per key. With
 * no single owner per key, events of one key run side by side and out of order.
 */
export async function singleEventWorkflow(input: { key: string; seq: number; delayMs: number }): Promise<void> {
  await applyEvent({ key: input.key, seq: input.seq, delayMs: input.delayMs });
}

// ---------------------------------------------------------------------------
// One workflow per budget: the single-writer actor with a synchronous answer
// ---------------------------------------------------------------------------

export interface BudgetActorInput {
  key: string;
  ceilingCents: number;
  /** PostgreSQL connection string for the durable entry. Omit for the in-memory-only variant. */
  connectionString?: string | undefined;
  /** Which activity type writes the durable entry. */
  durable?: 'none' | 'activity' | 'local' | undefined;
  /** Serialise requests. Off only for the negative control that must overspend. */
  serialise?: boolean | undefined;
  /** Extra time each durable write takes. Only the negative control uses it, to widen the race. */
  entryDelayMs?: number | undefined;
}

export interface BudgetRequest {
  op: 'reserve' | 'settle';
  requestId: string;
  /** reserve: the amount to hold. settle: the amount that was actually used. */
  amountCents: number;
  /** settle only: the amount that was reserved earlier. */
  reservedAmountCents?: number | undefined;
}

export interface BudgetAnswer {
  accepted: boolean;
  reservedCents: number;
  ceilingCents: number;
}

export const budgetUpdate = wf.defineUpdate<BudgetAnswer, [BudgetRequest]>('budget');
export const balanceQuery = wf.defineQuery<{ reservedCents: number; ceilingCents: number; handled: number }>('balance');

/** A first-in, first-out lock for code running inside a workflow. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * The budget actor. The balance lives in the workflow's memory and every
 * accepted change is written to the test ledger before the answer returns.
 * This is not the event-store command path required for production.
 *
 * An async Update handler can be interleaved with another Update at every
 * `await`. The mutex is what makes this a single writer: without it two
 * requests can both pass the ceiling check before either one records its
 * change. The test suite runs that unprotected variant on purpose.
 */
export async function budgetActorWorkflow(input: BudgetActorInput): Promise<never> {
  assertCents(input.ceilingCents);
  let reservedCents = 0;
  let handled = 0;
  const lock = new Mutex();
  const durable = input.durable ?? 'none';
  const serialise = input.serialise ?? true;

  const writeEntry = async (req: BudgetRequest): Promise<void> => {
    if (durable === 'none' || input.connectionString === undefined) return;
    const entry = {
      connectionString: input.connectionString,
      key: input.key,
      op: req.op,
      amountCents: req.amountCents,
      deltaCents: req.op === 'reserve' ? req.amountCents : req.amountCents - (req.reservedAmountCents ?? 0),
      requestId: req.requestId,
      extraDelayMs: input.entryDelayMs,
    };
    if (durable === 'local') await appendBudgetEntryLocal(entry);
    else await appendBudgetEntry(entry);
  };

  const apply = async (req: BudgetRequest): Promise<BudgetAnswer> => {
    assertCents(req.amountCents);
    if (req.reservedAmountCents !== undefined) assertCents(req.reservedAmountCents);
    if (req.op === 'reserve') {
      if (reservedCents + req.amountCents > input.ceilingCents) return { accepted: false, reservedCents, ceilingCents: input.ceilingCents };
      await writeEntry(req); // an await point: another request could run here without the mutex
      reservedCents += req.amountCents;
      handled++;
      return { accepted: true, reservedCents, ceilingCents: input.ceilingCents };
    }
    // settle: replace the earlier hold with the amount actually used
    await writeEntry(req);
    reservedCents = reservedCents - (req.reservedAmountCents ?? 0) + req.amountCents;
    handled++;
    return { accepted: true, reservedCents, ceilingCents: input.ceilingCents };
  };

  wf.setHandler(budgetUpdate, (req) => (serialise ? lock.runExclusive(() => apply(req)) : apply(req)));
  wf.setHandler(balanceQuery, () => ({ reservedCents, ceilingCents: input.ceilingCents, handled }));

  // Stay alive to keep answering; the tests terminate the workflow when done.
  await wf.condition(() => false);
  throw new Error('unreachable');
}
