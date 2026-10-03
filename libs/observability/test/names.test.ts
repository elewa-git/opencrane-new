import { describe, expect, it } from 'vitest';
import { isSensitiveFieldName } from '../src/names.ts';

describe('isSensitiveFieldName', () => {
  it.each([
    ['authorization', 'Authorization', 'proxy-authorization', 'x-authorization', 'cookie', 'Set-Cookie'],
    ['password', 'PASSWORD', 'dbPassword', 'secret', 'clientSecret', 'client_secret'],
    ['token', 'accessToken', 'refresh_token', 'idtoken', 'apiKey', 'api_key'],
    ['API_KEY', 'APIKey', 'x-api-key', 'masterKey', 'provider_key', 'privateKey'],
    ['DATABASE_URL', 'connectionString'],
  ])('treats %s, %s, ... as sensitive', (...names) => {
    for (const name of names) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
  });

  it('leaves ordinary names alone, and names that only refer to a secret or count one', () => {
    for (const name of ['handler', 'event_id', 'stream', 'code', 'state', 'message', 'cookiePolicy', 'authorizationUrl']) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
    for (const name of ['tokenCount', 'token_count', 'tokenType', 'secretRef', 'secret_ref', 'secret_id', 'secretName', 'apiKeyId']) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
  });

  it('keeps a number under a name ending in "tokens" (a usage count), but not a string or a list', () => {
    expect(isSensitiveFieldName('input_tokens', 120)).toBe(false);
    expect(isSensitiveFieldName('maxOutputTokens', 4096)).toBe(false);
    expect(isSensitiveFieldName('input_tokens', 'abc123')).toBe(true);
    expect(isSensitiveFieldName('tokens', ['abc', 'def'])).toBe(true);
    // A number under a name that is not a plural count is still a secret.
    expect(isSensitiveFieldName('token', 123456)).toBe(true);
    expect(isSensitiveFieldName('password', 123456)).toBe(true);
  });
});
