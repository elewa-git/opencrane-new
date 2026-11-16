import { vi } from 'vitest';
import { z } from 'zod';
import { eventEnvelopeSchema } from '@opencrane/events';
import type { EventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import type { memorySink } from '@opencrane/observability/testing';

export interface RoutineDispatchObservation {
  phase: string;
  outcome: string;
  leadership: ReturnType<typeof memorySink>;
}

export function reportDispatchFailure(observation: RoutineDispatchObservation) {
  const options = { level: 'error' };
  const logger = createLogger('routine-handoff-diagnostic', options);
  const details = { phase: observation.phase, outcome: observation.outcome,
    leadership: observation.leadership.lines() };
  logger.error(details, 'Routine handoff test failed');
}

export function observeDispatch<Result>(observation: RoutineDispatchObservation,
  pending: Promise<Result>) {
  observation.outcome = 'pending';
  function completed(result: Result) {
    observation.outcome = 'completed';
    return result;
  }
  function rejected(error: unknown): never {
    observation.outcome = 'rejected';
    throw error;
  }
  return pending.then(completed, rejected);
}

export async function waitForDispatchHandler(observation: RoutineDispatchObservation,
  entered: Promise<void>, pending: Promise<unknown>,
  handler = 'turn start') {
  function diagnostic(outcome: string) {
    const records = JSON.stringify(observation.leadership.lines());
    return `Dispatch ${outcome} before ${handler}; phase=${observation.phase}; leadership=${records}`;
  }
  function completedEarly(): never {
    throw new Error(diagnostic('completed'));
  }
  function refusedEarly(cause: unknown): never {
    throw new Error(diagnostic('rejected'), { cause });
  }
  const settled = pending.then(completedEarly, refusedEarly);
  await Promise.race([entered, settled]);
}

const envelopeSchema = eventEnvelopeSchema(z.unknown());

export function traceRoutineAppends(observation: RoutineDispatchObservation, store: EventStore) {
  const append = store.append.bind(store);
  const options = { level: 'error', destination: observation.leadership.stream };
  const logger = createLogger('routine-handoff-append', options);
  async function observed(...args: Parameters<typeof append>) {
    const command = args[0];
    const parsed = envelopeSchema.safeParse(command.event);
    let eventType = 'unparsed';
    if (parsed.success) eventType = parsed.data.type;
    let remainingMs: number | undefined;
    if (command.deadline !== undefined) remainingMs = command.deadline - performance.now();
    const attempt = { phase: 'append', eventType, remainingMs };
    logger.error(attempt, 'Routine handoff append started');
    const result = await append(...args);
    const finished = { ...attempt, status: result.status };
    logger.error(finished, 'Routine handoff append finished');
    return result;
  }
  vi.spyOn(store, 'append').mockImplementation(observed);
}
