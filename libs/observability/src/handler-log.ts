// Copied from OpenCrane 1 (10abd0ef6).
import { SpanStatusCode, isSpanContextValid, trace } from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type { Logger } from 'pino';

import { getContext, runWithContext } from './context.ts';

const tracer = trace.getTracer('@opencrane/observability');

/** Describe one run of a projection or reaction handler. */
export interface HandlerRun {
  /** Name the handler, for example "settle-budget"; this matches its queue name. */
  handler: string;
  /** Identify the event being handled. */
  eventId: string;
  /** Name the event type, for example "effect.observed". */
  eventType: string;
  /** Name the event stream, for example "budget-acme". */
  stream: string;
  /** Count this attempt from 1; failed jobs retry and may handle the event again. */
  attempt: number;
}

/** The fixed fields a handler run logs and puts on its span - see plan.md's "Logs and traces per handler". `traceId` is left out when no real span is active, rather than logging the all-zero id a no-op tracer returns. */
function runFields(run: HandlerRun, traceId: string | undefined): Attributes {
  const fields: Attributes = {
    handler: run.handler,
    event_id: run.eventId,
    event_type: run.eventType,
    stream: run.stream,
    attempt: run.attempt,
  };
  if (traceId !== undefined) {
    fields['trace_id'] = traceId;
  }
  return fields;
}

/**
 * Run `fn` inside a span named after the handler. Log when it starts and
 * completes or fails, and add its fields to the async context so its logs inherit them.
 *
 * End the span and re-throw errors after recording them, so wrapping a handler
 * does not change how it handles errors.
 */
export async function runHandler<T>(logger: Logger, run: HandlerRun, fn: () => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(run.handler, async (span) => {
    const spanContext = span.spanContext();
    const fields = runFields(run, isSpanContextValid(spanContext) ? spanContext.traceId : undefined);
    span.setAttributes(fields);

    // Keep a request id or extra fields an outer scope already set; the
    // handler's own fields win where the names clash.
    const outer = getContext();
    return runWithContext({ ...outer, extra: { ...outer?.extra, ...fields } }, async () => {
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
