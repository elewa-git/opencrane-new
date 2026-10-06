// Copied from OpenCrane 1 (10abd0ef6).
import pino, { type Logger } from 'pino';

import { contextMixin } from './context.ts';
import { sanitizeLogLine } from './sanitize.ts';

/** Where a logger writes: any object with a `write(line)` method. Re-exported so callers need no direct pino dependency. */
export type LogDestination = pino.DestinationStream;

export interface CreateLoggerOptions {
  /** Set the minimum level; default to `LOG_LEVEL`, then `"info"`. */
  level?: string;
  /** Write records here; use stdout by default. Tests can pass an in-memory stream. */
  destination?: LogDestination;
  /** Add pino serializers such as `req`; a supplied `err` serializer replaces pino's. */
  serializers?: Record<string, pino.SerializerFn>;
}

/**
 * Create a pino logger that writes one JSON line per record to stdout (or
 * `opts.destination`), with:
 * - Add the active request id and OpenTelemetry trace/span id to each line.
 * - Hide sensitive fields and remove URL queries at every depth, including
 *   child loggers, so each call cannot forget to clean its data.
 *
 * @param name Add this service name to every record.
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
