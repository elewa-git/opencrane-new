// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/http-trace.ts;
// changed: that file stripped a URL's whole query string for tracing. This one
// is for log lines and blanks only the parameters that carry a secret. It works
// on plain text and never calls `new URL()`, so a URL the parser cannot read
// (a stray `[`) is redacted like any other. OpenCrane 1 failed closed on those;
// the first version here had failed open.
import { isSensitiveQueryName } from './names.ts';

/** Value written in place of a redacted value. */
export const REDACTED_VALUE = '[Redacted]';

/** One `?name=value`, `&name=value`, `;name=value` or `#name=value` pair. Name and value stop at the characters that end a pair or a string (`& ; # ?`, whitespace, quotes, backslash), so a pair inside a sentence matches on its own. */
const QUERY_PAIR = /([?&;#])([^=&;#?\s"'\\]+)=([^&;#?\s"'\\]*)/gu;

/** Decode `%74oken` to `token` so an encoded name cannot dodge the check; an invalid escape is compared as written. */
function decodeName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Return `text` with the value of every sensitive query-string parameter
 * (`token`, `code`, `state`, `access_token`, `refresh_token`, `client_secret`,
 * `password`, `api_key`, and anything else {@link isSensitiveQueryName}
 * matches) replaced by `[Redacted]`. Nothing else is touched or tidied.
 *
 * `text` can be a relative path (what Fastify puts on `request.url`), an
 * absolute URL, a string that is not a valid URL, or a sentence that contains
 * one, such as Fastify's `Route GET:/x?token=abc not found`. The logger runs
 * it over every string it writes (see sanitize.ts).
 */
export function redactUrl(text: string): string {
  return text.replace(QUERY_PAIR, (pair, separator: string, name: string) =>
    isSensitiveQueryName(decodeName(name)) ? `${separator}${name}=${REDACTED_VALUE}` : pair,
  );
}
