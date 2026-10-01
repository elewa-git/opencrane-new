import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { runHandler } from '../src/handler-log.ts';

// Kept apart from handler-log.test.ts, which registers a real tracer provider
// for its whole run. This file needs the OpenTelemetry default, no provider:
// the state of every plain test run and `npm start`, where a no-op tracer
// hands out an all-zero trace id that must not be logged as if it were real.
// Vitest gives each file its own module graph, so nothing here registers one.

describe('runHandler with no tracer provider registered', () => {
  it('omits trace_id from the logged fields rather than logging the all-zero no-op span id', async () => {
    const calls: Record<string, unknown>[] = [];
    const record = (fields: Record<string, unknown>): void => void calls.push(fields);
    // This spy implements only the two pino methods runHandler calls; overloads require a full Logger.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const logger = { info: record, error: record } as unknown as Logger;
    const run = { handler: 'settle-budget', eventId: 'evt_1', eventType: 'effect.observed', stream: 'budget-acme', attempt: 1 };

    await runHandler(logger, run, () => Promise.resolve('ok'));

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call['trace_id']).toBeUndefined();
      expect(call['handler']).toBe('settle-budget');
    }
  });
});
