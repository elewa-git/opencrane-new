/** Value written in place of a redacted value. */
export const REDACTED_VALUE = '[Redacted]';

/**
 * Drop the entire query and fragment from logged URLs and messages, without
 * parsing parameters. Keep Fastify's fixed fallback suffix and mask private
 * conversation ids in history paths. Other text after a query is dropped too.
 */
export function redactUrl(text: string): string {
  const path = text.split(/[?#]/u, 1)[0] ?? '';
  const suffix = path !== text && /^Route [A-Z]+:/u.test(text) && text.endsWith(' not found') ? ' not found' : '';
  return path.replace(/\/api\/conversations\/[^/\s"'\\]+\/history(\/*)(?=[\s"'\\]|$)/gu,
    '/api/conversations/:conversationId/history$1') + suffix;
}
