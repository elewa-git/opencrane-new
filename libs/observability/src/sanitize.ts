// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/sanitize.ts;
// changed: (1) sensitive names are matched by the words in them (names.ts), not
// an exact list; (2) every string is also scrubbed for sensitive query-string
// parameters (redact.ts), so a URL inside a message or an error text is covered;
// (3) this runs on the finished JSON line (sanitizeLogLine), not as pino's `log`
// and `bindings` formatters. Those run before serializers and are reset on every
// `logger.child()`, so they never saw an Error's own properties or child
// bindings. The finished line has everything as plain JSON, so the OpenCrane 1
// cycle and class-instance checks are gone.
import { isSensitiveFieldName } from './names.ts';
import { REDACTED_VALUE, redactUrl } from './redact.ts';

/** Value written in place of a value nested deeper than MAX_DEPTH. */
const TRUNCATED = '[Truncated]';

/** Maximum depth walked before the rest is dropped, so a huge or hostile record cannot exhaust the stack. */
const MAX_DEPTH = 12;

/** Copy `value` with the value of every sensitive field replaced by `[Redacted]` and every string scrubbed, at any depth. */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return redactUrl(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  // fromEntries makes plain own properties, so a field named "__proto__" in
  // logged JSON stays a field instead of changing a prototype.
  return Object.fromEntries(
    Object.entries(value).map(([name, nested]) => [name, isSensitiveFieldName(name, nested) ? REDACTED_VALUE : sanitizeValue(nested, depth + 1)]),
  );
}

/**
 * Copy an object with sensitive fields (headers, secrets, tokens, passwords,
 * API keys: see names.ts) replaced by `[Redacted]` and sensitive query-string
 * parameters in any string blanked too, at any depth. Meant for plain data such
 * as parsed JSON. Fails closed: if walking throws, the result is one redacted
 * marker.
 */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return sanitizeValue(fields, 0) as Record<string, unknown>;
  } catch {
    return { logFields: REDACTED_VALUE };
  }
}

/**
 * Sanitise one finished pino log line (JSON ending in a newline) and return the
 * line to write. The logger runs every record through this just before it
 * reaches the destination (pino's `hooks.streamWrite`), so no call site, child
 * logger, serializer or error property can skip it.
 *
 * Fails closed: a line that is not valid JSON, or cannot be walked, is replaced
 * by a fixed error line and its text is never written. The line is parsed and
 * written again, so a number above 2^53 would be rounded; log those as strings.
 */
export function sanitizeLogLine(line: string): string {
  try {
    return `${JSON.stringify(sanitizeValue(JSON.parse(line), 0))}\n`;
  } catch {
    return `${JSON.stringify({ level: 50, time: Date.now(), msg: 'log line dropped: it could not be sanitised' })}\n`;
  }
}
