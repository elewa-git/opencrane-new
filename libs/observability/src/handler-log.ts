// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/operation.ts;
// changed: that file's doWithTrace() took a free-form name and fields for
// any operation. This is narrowed to plan.md's "logs and traces per handler"
// shape - a projection or reaction handler run - so the log and span fields
// are fixed (handler, event_id, event_type, stream, attempt, trace_id)
// instead of left to each call site to decide and possibly get wrong.
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type { Logger } from 'pino';

import { runWithContext } from './context.ts';

const tracer = trace.getTracer('@opencrane/observability');

/** Identifies one run of one projection or reaction handler, for the event catalogue at docs/architecture/events.md. */
export interface HandlerRun {
  /** The handler's name, e.g. "settle-budget" or "wake-computer" - matches its pg-boss queue name. */
  handler: string;
  /** Id of the event this run is handling. */
  eventId: string;
  /** The event's type, e.g. "effect.observed". */
  eventType: string;
  /** The stream the event came from, e.g. "budget-acme". */
  stream: string;
  /** Which attempt this is, starting at 1. pg-boss retries failed jobs, so a handler can run more than once for the same event. */
  attempt: number;
}

/** The fixed fields a handler run logs and puts on its span - see plan.md's "Logs and traces per handler". */
function runFields(run: HandlerRun, traceId: string): Attributes {
  return {
    handler: run.handler,
    event_id: run.eventId,
    event_type: run.eventType,
    stream: run.stream,
    attempt: run.attempt,
    trace_id: traceId,
  };
}

/**
 * Run `fn` as one handler run: opens one OpenTelemetry span named after the
 * handler, logs `handler.started` then `handler.completed` (or
 * `handler.failed`) with the fixed fields from {@link HandlerRun} plus
 * `trace_id`, and seeds the async context so any logging `fn` does inherits
 * those same fields.
 *
 * The span is always ended and any error `fn` throws is always re-thrown
 * after being recorded on the span, so wrapping a handler in this never
 * changes its control flow.
 */
export async function runHandler<T>(logger: Logger, run: HandlerRun, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(run.handler, async (span) => {
    const traceId = span.spanContext().traceId;
    const fields = runFields(run, traceId);
    span.setAttributes(fields);

    return runWithContext({ extra: fields }, async () => {
      const startedAt = performance.now();
      logger.info(fields, 'handler.started');
      try {
        const result = await fn();
        logger.info({ ...fields, duration_ms: Math.round(performance.now() - startedAt) }, 'handler.completed');
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        logger.error(
          { ...fields, duration_ms: Math.round(performance.now() - startedAt), err },
          'handler.failed',
        );
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  });
}
