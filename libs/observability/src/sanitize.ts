// Copied from OpenCrane 1 (10abd0ef6).
import { isSensitiveFieldName } from './names.ts';
import { REDACTED_VALUE, redactUrl } from './redact.ts';

/** Write this marker when data is nested deeper than MAX_DEPTH. */
const TRUNCATED = '[Truncated]';

/** Stop at this depth so a large or hostile record cannot exhaust the stack. */
const MAX_DEPTH = 12;

/** Copy `value`, hide sensitive fields, and remove URL details from every string. */
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
 * Copy plain data such as parsed JSON, hiding sensitive fields and URL queries
 * at any depth. If walking fails, return one redaction marker so data stays hidden.
 */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    const value = sanitizeValue(fields, 0);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { logFields: REDACTED_VALUE };
    }
    return Object.fromEntries(Object.entries(value));
  } catch {
    return { logFields: REDACTED_VALUE };
  }
}

/**
 * Clean one finished pino log line (JSON ending in a newline) before writing it.
 * Run every record here so no call, child logger, serializer or error field skips it.
 *
 * Replace invalid JSON or a line that cannot be walked with a fixed error line,
 * so its text is never written. Parsing and writing the line again rounds
 * numbers above 2^53, so log those as strings.
 */
export function sanitizeLogLine(line: string): string {
  try {
    return `${JSON.stringify(sanitizeValue(JSON.parse(line), 0))}\n`;
  } catch {
    return `${JSON.stringify({ level: 50, time: Date.now(), msg: 'log line dropped: it could not be sanitised' })}\n`;
  }
}
