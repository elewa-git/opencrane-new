// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/sanitize.ts;
// changed: the list of sensitive field names is trimmed to what this repo's
// rules ask for (authorization/cookie/set-cookie headers, plus fields named
// like secret/password/apiKey/token), and matching is substring-based for
// the word fields so it also catches variants such as accessToken or
// clientSecret, not only an exact field named "token".

/** Value written in place of a redacted field. */
const REDACTED = '[Redacted]';

/** Value written in place of a value nested deeper than MAX_DEPTH. */
const TRUNCATED = '[Truncated]';

/** Maximum object depth walked before the rest of a value is dropped, so a cyclical or huge object cannot hang logging. */
const MAX_DEPTH = 10;

/** Header/field names that are sensitive by themselves, matched by exact (case-insensitive) name. */
const SENSITIVE_FIELD_NAMES = new Set(['authorization', 'cookie', 'set-cookie']);

/** Words that make a field name sensitive wherever they appear in it, so "apiKey", "accessToken" and "clientSecret" are all caught. */
const SENSITIVE_NAME_WORDS = ['secret', 'password', 'apikey', 'token'];

/** Return whether a field name must be redacted, regardless of where it sits in the object. */
function isSensitiveFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_FIELD_NAMES.has(lower)) {
    return true;
  }
  return SENSITIVE_NAME_WORDS.some((word) => lower.includes(word));
}

/** Return whether `value` is a plain `{}` object, as opposed to something a library owns (a Buffer, a class instance, ...). */
function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Copy a value, dropping sensitive fields at every depth and stopping at MAX_DEPTH or a cycle. */
function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  // Primitives, and objects a serializer elsewhere owns (Error, Date, Buffer, ...), pass through as-is.
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (value instanceof Error || value instanceof Date) {
    return value;
  }
  if (!isPlainRecord(value) && !Array.isArray(value)) {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return TRUNCATED;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(value)) {
    sanitized[name] = isSensitiveFieldName(name) ? REDACTED : sanitizeValue(nested, depth + 1, seen);
  }
  return sanitized;
}

/**
 * Copy a pino log object with sensitive fields (headers, secrets, tokens,
 * passwords, API keys - see {@link SENSITIVE_FIELD_NAMES} and {@link SENSITIVE_NAME_WORDS})
 * replaced by `[Redacted]`, at any depth.
 *
 * Wired in as pino's `log` and `bindings` formatters (see logger.ts), so it
 * runs on every record without every call site having to remember to redact
 * by hand. Fails closed: if walking the object throws for any reason, the
 * whole field set is replaced by a single redacted marker rather than
 * risking a half-walked object reaching the log.
 */
export function sanitizeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  try {
    return sanitizeValue(fields, 0, new WeakSet<object>()) as Record<string, unknown>;
  } catch {
    return { logFields: REDACTED };
  }
}
