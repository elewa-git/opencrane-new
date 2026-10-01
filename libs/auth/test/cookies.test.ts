import { describe, expect, it } from 'vitest';
import { clearCookie, parseCookieHeader, serializeCookie } from '../src/cookies.ts';

describe('serializeCookie', () => {
  it('defaults to HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    const header = serializeCookie('oc_session', 'abc');
    expect(header).toBe('oc_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  it('can drop Secure for local http development', () => {
    const header = serializeCookie('oc_session', 'abc', { secure: false, maxAgeSeconds: 60 });
    expect(header).toContain('Max-Age=60');
    expect(header).not.toContain('Secure');
  });
});

describe('clearCookie', () => {
  it('sets Max-Age=0', () => {
    expect(clearCookie('oc_session')).toContain('Max-Age=0');
  });
});

describe('parseCookieHeader', () => {
  it('parses several cookies from one header', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('returns an empty object for a missing header', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('never throws on a malformed percent-escape from a tampered value', () => {
    expect(() => parseCookieHeader('oc_session=abc%zz')).not.toThrow();
    expect(parseCookieHeader('oc_session=abc%zz')).toEqual({ oc_session: 'abc%zz' });
  });
});
