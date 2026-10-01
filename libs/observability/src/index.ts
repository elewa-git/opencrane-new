// @opencrane/observability - structured logging, secret redaction and
// tracing shared by every OpenCrane 2 service.
//
// - createLogger() builds a pino logger that writes JSON to stdout, with
//   sensitive fields and sensitive URL query parameters redacted on every
//   line (children and error properties included) and the active
//   request/trace id attached to every line.
// - runWithContext()/getContext() carry per-request fields through async
//   work without threading a logger or an id through every function.
// - redactUrl() blanks the value of sensitive query-string parameters (token,
//   code, state, access_token, refresh_token, password, api_key, ...) in a URL.
// - runHandler() is the "logs and traces per handler" helper from plan.md:
//   wraps one projection/reaction run in a span and a fixed set of log
//   fields (handler, event_id, event_type, stream, attempt, trace_id).
// - startTelemetry()/shutdownTelemetry() bootstrap the OpenTelemetry SDK,
//   off by default unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
export { createLogger, type CreateLoggerOptions, type Logger, type LogDestination } from './logger.ts';
export { runWithContext, getContext, contextMixin, type LogContext } from './context.ts';
export { redactUrl, REDACTED_VALUE } from './redact.ts';
export { sanitizeLogFields, sanitizeLogLine } from './sanitize.ts';
export { runHandler, type HandlerRun } from './handler-log.ts';
export { startTelemetry, shutdownTelemetry, resolveTelemetryEnabled, type TelemetryOptions } from './telemetry.ts';
