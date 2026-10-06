// Copied from OpenCrane 1 (10abd0ef6).
// Carry request and handler details through async work with AsyncLocalStorage.
// Log lines inside the call tree receive these details without passing a logger
// or id through every function.
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

/** Run `fn` with `context` available to everything it calls, sync or async. */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  return store.run(context, fn);
}

/** Return the active context, or undefined when no context is active. */
export function getContext(): LogContext | undefined {
  return store.getStore();
}

/**
 * Return fields to add to every pino log line.
 *
 * Add the active request id and extra fields, along with the current
 * OpenTelemetry trace and span ids, so callers do not have to look them up.
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
