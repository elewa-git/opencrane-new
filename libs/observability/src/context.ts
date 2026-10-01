// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/context.ts;
// changed: plain function names (dropped the repo-wide "___" prefix, which
// OpenCrane 2 does not use), and the mixin also reads the active
// OpenTelemetry span so every log line carries trace_id/span_id on its own.
//
// Per-request / per-handler context, carried through async work with
// AsyncLocalStorage. Set it once at the top of a request or a handler run
// (see runWithContext), and every log line written anywhere inside that
// async call tree picks up the same fields automatically - no need to pass
// a logger or an id down through every function call.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isSpanContextValid, trace } from '@opentelemetry/api';

/** Fields carried through one request or handler run. */
export interface LogContext {
  /** Correlation id for this request or handler run. */
  requestId?: string;
  /** Extra fields merged into every log line written inside the scope. */
  extra?: Record<string, unknown>;
}

const store = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `context` active for it and everything it calls, sync or async. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return store.run(context, fn);
}

/** Return the context active for the code calling this, or undefined outside any `runWithContext` scope. */
export function getContext(): LogContext | undefined {
  return store.getStore();
}

/**
 * Pino mixin: the fields to merge into every log line.
 *
 * Reads the active `runWithContext` scope (request id and any extra fields)
 * plus the currently active OpenTelemetry span, so a log line written while
 * a span is open always carries that span's `trace_id`/`span_id` - without
 * the caller having to look either up by hand.
 */
export function contextMixin(): Record<string, unknown> {
  const context = store.getStore();
  const fields: Record<string, unknown> = context?.extra !== undefined ? { ...context.extra } : {};
  if (context?.requestId !== undefined) {
    fields['request_id'] = context.requestId;
  }

  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext !== undefined && isSpanContextValid(spanContext)) {
    fields['trace_id'] = spanContext.traceId;
    fields['span_id'] = spanContext.spanId;
  }

  return fields;
}
