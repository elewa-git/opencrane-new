import { describe, expect, it } from 'vitest';
import { clearCookie, cookieValues, serializeCookie } from '../src/cookies.ts';

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

describe('cookieValues', () => {
  it('keeps each value of the named cookie in order', function duplicateValues() {
    expect(cookieValues('a=1; b=2; a=three%20four', 'a')).toEqual(['1', 'three four']);
  });

  it('returns an empty list for a missing header', function missingHeader() {
    expect(cookieValues(undefined, 'oc_session')).toEqual([]);
  });

  it('leaves a malformed percent escape in the value for the session check', function malformed() {
    expect(cookieValues('oc_session=abc%zz', 'oc_session')).toEqual(['abc%zz']);
  });
});
