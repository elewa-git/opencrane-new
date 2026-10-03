import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact.ts';

describe('redactUrl', () => {
  it.each([
    ['/callback?token=SECRET123', '/callback'],
    ['/conversations/123?page=2&sort=asc#top', '/conversations/123'],
    ['https://api.opencrane.test/a/../cb?token=one&x=1&token=two#frag', 'https://api.opencrane.test/a/../cb'],
    ['//[x?token=SECRET_BRACKET', '//[x'],
    ['http://[bad?token=SECRET_HOST&keep=1', 'http://[bad'],
    ['https://app.test/cb#access_token=SECRET_FRAG&state=abc', 'https://app.test/cb'],
    ['/cb?%74oken=SECRET_ENC', '/cb'],
    ['/cb?next=/x?token=SECRET_Q2', '/cb'],
    ['Route GET:/nope?token=SECRET_B404&code=SECRET_CODE not found', 'Route GET:/nope not found'],
    ['callback /cb?requestId=prefix\'private-canary trailing text', 'callback /cb'],
    ['/api/conversations/private-canary/history//?unknown=private-canary', '/api/conversations/:conversationId/history//'],
  ])('drops the entire query or fragment in %s', (text, expected) => {
    expect(redactUrl(text)).toBe(expected);
  });

  it.each(['https:// bad host/path', '', 'token refreshed for password reset', '/healthz'])('keeps text without queries or fragments: %s', text => {
    expect(redactUrl(text)).toBe(text);
  });
});
