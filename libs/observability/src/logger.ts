// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/logger.ts;
// changed: dropped the pretty-print transport and the fd-based destination
// option (this repo has no interactive CLI yet that needs them) - it always
// writes JSON. The destination is now any pino DestinationStream, so a test
// can pass an in-memory sink instead of writing to a real file descriptor.
import pino, { type Logger } from 'pino';

import { contextMixin } from './context.ts';
import { sanitizeLogFields } from './sanitize.ts';

export interface CreateLoggerOptions {
  /** Minimum level to emit; defaults to the `LOG_LEVEL` environment variable, then `"info"`. */
  level?: string;
  /** Where records are written; defaults to stdout. Tests pass an in-memory stream here. */
  destination?: pino.DestinationStream;
  /** Extra pino serializers, merged with none by default (e.g. a `req` serializer that redacts a URL). */
  serializers?: Record<string, pino.SerializerFn>;
}

/**
 * Create a pino logger that writes one JSON line per record to stdout (or
 * `opts.destination`), with:
 * - every line carrying the active request id and OpenTelemetry trace/span
 *   id, via {@link contextMixin};
 * - sensitive fields (see sanitize.ts) replaced by `[Redacted]` at any depth,
 *   on every record, so a call site cannot forget to redact.
 *
 * @param name Service/component name stamped on every record (pino's `name` option).
 */
export function createLogger(name: string, opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? process.env['LOG_LEVEL'] ?? 'info';

  return pino(
    {
      name,
      level,
      mixin: contextMixin,
      formatters: {
        log: sanitizeLogFields,
        bindings: sanitizeLogFields,
      },
      // Turn an `err` field (e.g. from handler-log.ts) into {type, message,
      // stack} instead of a bare Error instance, so it survives to JSON.
      // A caller-supplied serializer for the same key wins.
      serializers: { err: pino.stdSerializers.err, ...opts.serializers },
    },
    opts.destination ?? pino.destination({ fd: 1, sync: true }),
  );
}

export type { Logger } from 'pino';
