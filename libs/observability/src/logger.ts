// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/logger.ts;
// changed: dropped the pretty-print transport and the fd-based destination
// option (no interactive CLI yet), so it always writes JSON, to any pino
// destination (a test passes an in-memory one). Dropped OpenCrane 1's
// `redact: [...REDACT_PATHS]` option and the `log`/`bindings` formatters:
// redaction now happens once, on the finished line, through pino's
// `hooks.streamWrite` (see sanitize.ts for why). One rule set in one place
// replaces a path list that had to be kept in step with a name list.
import pino, { type Logger } from 'pino';

import { contextMixin } from './context.ts';
import { sanitizeLogLine } from './sanitize.ts';

/** Where a logger writes: any object with a `write(line)` method. Re-exported so callers need no direct pino dependency. */
export type LogDestination = pino.DestinationStream;

export interface CreateLoggerOptions {
  /** Minimum level to emit; defaults to the `LOG_LEVEL` environment variable, then `"info"`. */
  level?: string;
  /** Where records are written; defaults to stdout. Tests pass an in-memory stream here. */
  destination?: LogDestination;
  /** Extra pino serializers (for example a `req` serializer). pino's own `err` serializer is always on, and a caller's `err` replaces it. */
  serializers?: Record<string, pino.SerializerFn>;
}

/**
 * Create a pino logger that writes one JSON line per record to stdout (or
 * `opts.destination`), with:
 * - every line carrying the active request id and OpenTelemetry trace/span
 *   id, via {@link contextMixin};
 * - sensitive fields replaced by `[Redacted]` and entire URL queries removed
 *   at any depth, on every line and for every child logger, so a
 *   call site cannot forget to redact (see {@link sanitizeLogLine}).
 *
 * @param name Service/component name stamped on every record (pino's `name` option).
 */
export function createLogger(name: string, opts: CreateLoggerOptions = {}): Logger {
  return pino(
    {
      name,
      level: opts.level ?? process.env['LOG_LEVEL'] ?? 'info',
      mixin: contextMixin,
      serializers: opts.serializers ?? {},
      hooks: { streamWrite: sanitizeLogLine },
    },
    opts.destination ?? pino.destination({ fd: 1, sync: true }),
  );
}

export type { Logger } from 'pino';
