// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/http-trace.ts;
// changed: that file stripped a URL's whole query string for OpenTelemetry
// span attributes. This one is for log lines instead, and only blanks out
// the query-string parameters that are known to carry a secret, so the rest
// of the query string (which is often useful for debugging) stays visible.
//
// A previous review found that the server logged a request URL with its
// token verbatim, e.g. `?token=SECRET123`. redactUrl() is the fix: every
// place that logs a request URL should pass it through this first.

/** Query-string parameter names (case-insensitive) whose value must never reach a log line. */
const SENSITIVE_QUERY_PARAMS = new Set(['token', 'code', 'state', 'access_token', 'id_token']);

/** Value written in place of a redacted query-string parameter. */
export const REDACTED_VALUE = '[Redacted]';

/**
 * Return `url` with any query-string parameter named in {@link SENSITIVE_QUERY_PARAMS}
 * replaced by `[Redacted]`. The path, other parameters and (for an absolute
 * URL) the origin are left untouched.
 *
 * Works on both relative paths (e.g. `/callback?token=abc`, what Fastify
 * puts on `request.url`) and absolute URLs. A value that cannot be parsed as
 * a URL at all is returned unchanged, since it is not the shape this guards
 * against.
 */
export function redactUrl(url: string): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//iu.test(url);
  let parsed: URL;
  try {
    parsed = new URL(url, isAbsolute ? undefined : 'http://redact.invalid');
  } catch {
    return url;
  }

  let redactedAny = false;
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAMS.has(name.toLowerCase())) {
      parsed.searchParams.set(name, REDACTED_VALUE);
      redactedAny = true;
    }
  }
  if (!redactedAny) {
    return url;
  }

  return isAbsolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
