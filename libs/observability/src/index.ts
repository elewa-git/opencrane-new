// Share logging, secret removal and tracing across OpenCrane services.
//
// - Write JSON logs, hide sensitive fields and URL queries, and add request and
//   trace ids to each line.
// - Carry request details through async work without passing a logger or id around.
// - Remove URL queries and fragments, including those in messages.
// - Record each handler run in a span and log its handler, event, stream and attempt.
// - Start and stop OpenTelemetry; keep it off unless the endpoint is configured.
export { createLogger, type CreateLoggerOptions, type Logger, type LogDestination } from './logger.ts';
export { runWithContext, getContext, contextMixin, type LogContext } from './context.ts';
export { redactUrl, REDACTED_VALUE } from './redact.ts';
export { sanitizeLogFields, sanitizeLogLine } from './sanitize.ts';
export { runHandler, type HandlerRun } from './handler-log.ts';
export { startTelemetry, shutdownTelemetry, resolveTelemetryEnabled, type TelemetryOptions } from './telemetry.ts';
