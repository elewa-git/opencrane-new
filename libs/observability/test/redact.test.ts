import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact.ts';

describe('redactUrl', () => {
  it('redacts a bare ?token= query string on a relative URL (the shape found logged verbatim)', () => {
    expect(redactUrl('/callback?token=SECRET123')).toBe('/callback?token=[Redacted]');
  });

  it('redacts token, code, state, access_token, id_token, refresh_token, client_secret, password and api_key, case-insensitively, and leaves other parameters alone', () => {
    const names = ['Token', 'code', 'STATE', 'access_token', 'id_token', 'refresh_token', 'client_secret', 'password', 'api_key'];
    const url = `/cb?${names.map((name, i) => `${name}=value${i}`).join('&')}&keep=me`;

    expect(redactUrl(url)).toBe(`/cb?${names.map((name) => `${name}=[Redacted]`).join('&')}&keep=me`);
  });

  it('leaves a URL with no sensitive parameters exactly as it was', () => {
    expect(redactUrl('/conversations/123?page=2&sort=asc#top')).toBe('/conversations/123?page=2&sort=asc#top');
    expect(redactUrl('https:// bad host/path')).toBe('https:// bad host/path');
    expect(redactUrl('')).toBe('');
  });

  it('keeps an absolute URL origin, path and fragment, does not tidy ../, and repeats for every occurrence', () => {
    expect(redactUrl('https://api.opencrane.test/a/../cb?token=one&x=1&token=two#frag')).toBe(
      'https://api.opencrane.test/a/../cb?token=[Redacted]&x=1&token=[Redacted]#frag',
    );
  });

  it('fails closed on a URL new URL() cannot parse: the token is still redacted (found logged in full)', () => {
    expect(redactUrl('//[x?token=SECRET_BRACKET')).toBe('//[x?token=[Redacted]');
    expect(redactUrl('http://[bad?token=SECRET_HOST&keep=1')).toBe('http://[bad?token=[Redacted]&keep=1');
  });

  it('redacts a token in the fragment (OAuth implicit flow), a percent-encoded parameter name, and a token after a second question mark', () => {
    expect(redactUrl('https://app.test/cb#access_token=SECRET_FRAG&state=abc')).toBe('https://app.test/cb#access_token=[Redacted]&state=[Redacted]');
    expect(redactUrl('/cb?%74oken=SECRET_ENC')).toBe('/cb?%74oken=[Redacted]');
    expect(redactUrl('/cb?next=/x?token=SECRET_Q2')).toBe('/cb?next=/x?token=[Redacted]');
  });

  it('redacts a URL inside a sentence or JSON-style text, keeping the words around it', () => {
    expect(redactUrl('Route GET:/nope?token=SECRET_B404&code=SECRET_CODE not found')).toBe('Route GET:/nope?token=[Redacted]&code=[Redacted] not found');
    expect(redactUrl('{"url":"/x?token=SECRET_Q","ok":true}')).toBe('{"url":"/x?token=[Redacted]","ok":true}');
  });

  it('does not touch text that only mentions a sensitive word, with no query-string delimiter in front of it', () => {
    expect(redactUrl('token refreshed for password reset')).toBe('token refreshed for password reset');
  });
});
