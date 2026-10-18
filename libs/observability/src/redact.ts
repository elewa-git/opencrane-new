/** Write this value where logged data has been hidden. */
export const REDACTED_VALUE = '[Redacted]';

/**
 * Remove the whole query and fragment without parsing parameters. Keep
 * Fastify's fixed fallback text and hide ids in conversation history and
 * member change paths. Remove other text after a query as well.
 */
export function redactUrl(text: string): string {
  const path = text.split(/[?#]/u, 1)[0] ?? '';
  const suffix = path !== text && /^Route [A-Z]+:/u.test(text) && text.endsWith(' not found') ? ' not found' : '';
  const safeConversationPath = path.replace(
    /\/api\/conversations\/[^/\s"'\\]+\/history(\/*)(?=[\s"'\\]|$)/gu,
    '/api/conversations/:conversationId/history$1',
  );
  const safeMemberChangePath = safeConversationPath.replace(
    /\/api\/members\/[^/\s"'\\]+\/changes\/[^/\s"'\\]+(?=\/*(?:[\s"'\\]|$))/gu,
    '/api/members/:memberId/changes/:commandId',
  );

  return safeMemberChangePath + suffix;
}
