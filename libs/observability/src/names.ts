// Decide whether a log field name may hold a secret (sanitize.ts).
//
// Check the words in a name so `api_key`, `x-api-key` and `accessToken` match.
// Keep usage counts such as `input_tokens` and references such as `secretRef`:
// events carry secret references, never secret values.

/** Hide names ending in these words, such as `authorization` or `set-cookie`. */
const SENSITIVE_ENDINGS = ['authorization', 'cookie', 'cookies'];

/** Hide names containing these parts after lower-casing and removing `-` and `_`. */
const SENSITIVE_PARTS = ['secret', 'password', 'passwd', 'token', 'apikey', 'masterkey', 'providerkey', 'privatekey', 'databaseurl', 'connectionstring'];

/** Keep these endings because they name references or counts, not secrets. */
const REFERENCE_WORDS = new Set(['ref', 'id', 'name', 'count', 'type']);

/** Split names into lower-case words so `accessToken` and `ACCESS-TOKEN` both match. */
function splitWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .split(/[^A-Za-z\d]+/u)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Check whether to hide the value of a log field called `name`.
 *
 * Keep one exception: a number under a name ending in `tokens`
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
