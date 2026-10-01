// Decides whether a field name (or a URL query-string parameter name) holds
// something secret, for log fields (sanitize.ts) and URLs (redact.ts) alike.
//
// This replaces the exact-name list in OpenCrane 1's sanitize.ts (10abd0ef6
// libs/backend/observability/src/sanitize.ts) with a rule on the words in the
// name, so `api_key`, `x-api-key` and `accessToken` are all caught, while usage
// counts such as `input_tokens` and references such as `secretRef` (events
// carry secret references, never values) are not.

/** Names that end like this are sensitive on their own: `authorization`, `x-authorization`, `proxy-authorization`, `cookie`, `set-cookie`. */
const SENSITIVE_ENDINGS = ['authorization', 'cookie', 'cookies'];

/** Parts that make a name sensitive wherever they sit in it. Compared with the name lower-cased and its `-`/`_` removed, so `API_KEY`, `x-api-key` and `apiKey` all contain `apikey`. */
const SENSITIVE_PARTS = ['secret', 'password', 'passwd', 'token', 'apikey', 'masterkey', 'providerkey', 'privatekey', 'databaseurl', 'connectionstring'];

/** A sensitive-looking name ending in one of these words holds a reference or a count, not the secret: `secretRef`, `secret_id`, `tokenCount`, `tokenType`. */
const REFERENCE_WORDS = new Set(['ref', 'id', 'name', 'count', 'type']);

/** OAuth callback parameters: secret in a URL, but ordinary field names in a log record (`code: 404`, `state: 'running'`). */
const SENSITIVE_QUERY_ONLY = new Set(['code', 'state']);

/** Split a name into lower-case words: `accessToken`, `access_token` and `ACCESS-TOKEN` all give `access`, `token`. */
function splitWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .split(/[^A-Za-z\d]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Return whether a log field called `name` must have its value redacted.
 *
 * `value` is used for one exception: a number under a name ending in `tokens`
 * (`input_tokens: 120`) is a usage count, which the budget logs need. The same
 * name holding a string or a list of tokens is still redacted.
 */
export function isSensitiveFieldName(name: string, value?: unknown): boolean {
  const flat = name.toLowerCase().replace(/[-_]/gu, '');
  if (SENSITIVE_ENDINGS.some((ending) => flat.endsWith(ending))) {
    return true;
  }
  if (!SENSITIVE_PARTS.some((part) => flat.includes(part))) {
    return false;
  }
  if (typeof value === 'number' && flat.endsWith('tokens')) {
    return false;
  }
  const words = splitWords(name);
  return !REFERENCE_WORDS.has(words[words.length - 1] ?? '');
}

/** Return whether a URL query-string parameter called `name` must have its value redacted: every sensitive field name, plus the OAuth `code` and `state`. */
export function isSensitiveQueryName(name: string): boolean {
  return SENSITIVE_QUERY_ONLY.has(name.toLowerCase()) || isSensitiveFieldName(name);
}
