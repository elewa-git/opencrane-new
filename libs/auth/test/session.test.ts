import { describe, expect, it } from 'vitest';
import { decodeSession, encodeSession, hasRecentAuth, isAuthTimeRecent, SessionExpiredError, SessionInvalidError, type SessionData } from '../src/session.ts';
import { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag } from './fixtures.ts';

const config = testAuthConfig();
const now = new Date('2026-09-30T12:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

function validSession(overrides: Partial<SessionData> = {}): SessionData {
  return { sub: 'user-1', orgId: 'org-1', roles: ['member'], authTime: nowSeconds - 60, exp: nowSeconds + 3600, ...overrides };
}

describe('session cookie', () => {
  it('round-trips a session through encode and decode', () => {
    const session = validSession();
    const cookieValue = encodeSession(config, session);
    expect(decodeSession(config, cookieValue, now)).toEqual(session);
  });

  it('rejects a cookie that was tampered with', () => {
    const cookieValue = encodeSession(config, validSession());
    expect(() => decodeSession(config, tamperCookie(cookieValue), now)).toThrow(SessionInvalidError);
  });

  it('rejects a forged cookie that turns orgId "org-1" into "org-2" (valid JSON, valid orgId)', () => {
    // tamperCookie breaks the JSON, so JSON.parse rejects it even with no tag
    // check. This forgery keeps everything valid: only the tag can catch it.
    const session = validSession();
    const forged = replaceInCiphertext(encodeSession(config, session), JSON.stringify(session), '"org-1"', '"org-2"');
    expect(() => decodeSession(config, forged, now)).toThrow(SessionInvalidError);
  });

  it('rejects a session cookie whose authentication tag has been cut down to 4 bytes', () => {
    const cookieValue = encodeSession(config, validSession());
    expect(() => decodeSession(config, truncateAuthTag(cookieValue, 4), now)).toThrow(SessionInvalidError);
  });

  it('rejects a cookie encoded with a different cookie secret', () => {
    const cookieValue = encodeSession(config, validSession());
    const otherConfig = testAuthConfig({ cookieSecret: 'b'.repeat(32) });
    expect(() => decodeSession(otherConfig, cookieValue, now)).toThrow(SessionInvalidError);
  });

  it('rejects a cookie after the OIDC issuer changes, even with the same cookie secret', () => {
    // The session key is derived from more than just cookieSecret, so a
    // provider (or client, redirect URI, cookie name) change invalidates
    // sessions issued under the old one, instead of leaving them readable
    // by whichever new provider happens to reuse the secret.
    const cookieValue = encodeSession(config, validSession());
    const otherConfig = testAuthConfig({ issuerUrl: 'https://a-different-idp.example.test' });
    expect(() => decodeSession(otherConfig, cookieValue, now)).toThrow(SessionInvalidError);
  });

  it('rejects a well-formed but not-yet-decrypted-looking string', () => {
    expect(() => decodeSession(config, 'not-a-real-cookie', now)).toThrow(SessionInvalidError);
  });

  it('rejects a session whose expiry has passed', () => {
    const cookieValue = encodeSession(config, validSession({ exp: nowSeconds - 1 }));
    expect(() => decodeSession(config, cookieValue, now)).toThrow(SessionExpiredError);
  });

  it('accepts a session exactly at its expiry boundary as still expired', () => {
    const cookieValue = encodeSession(config, validSession({ exp: nowSeconds }));
    expect(() => decodeSession(config, cookieValue, now)).toThrow(SessionExpiredError);
  });
});

describe('isAuthTimeRecent (step-up)', () => {
  it('is true when auth_time is within the allowed age', () => {
    const session = validSession({ authTime: nowSeconds - 60 });
    expect(isAuthTimeRecent(session, 300, now)).toBe(true);
  });

  it('is false once auth_time is older than the allowed age', () => {
    const session = validSession({ authTime: nowSeconds - 600 });
    expect(isAuthTimeRecent(session, 300, now)).toBe(false);
  });
});

describe('hasRecentAuth (step-up window from the config)', () => {
  it('uses stepUpMaxAgeSeconds as the window', () => {
    const session = validSession({ authTime: nowSeconds - 120 });
    expect(hasRecentAuth(testAuthConfig({ stepUpMaxAgeSeconds: 300 }), session, now)).toBe(true);
    expect(hasRecentAuth(testAuthConfig({ stepUpMaxAgeSeconds: 60 }), session, now)).toBe(false);
  });

  it('says "not recent" for a session whose auth_time is 0 (no auth_time from the provider)', () => {
    expect(hasRecentAuth(testAuthConfig(), validSession({ authTime: 0 }), now)).toBe(false);
  });
});

function sessionEmailLimit() {
  const allowed = validSession({ email: 'a'.repeat(320) });
  const cookie = encodeSession(config, allowed);
  expect(decodeSession(config, cookie, now).email).toHaveLength(320);
  const oversized = validSession({ email: 'a'.repeat(321) });
  function encodeOversized() {
    encodeSession(config, oversized);
  }
  expect(encodeOversized).toThrow();
}
it('limits session email claims to 320 characters', sessionEmailLimit);
