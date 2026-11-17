import { expect, it } from 'vitest';
import { decodeSession } from '@opencrane/auth';
import { sessionCookie, testAuthConfig } from '@opencrane/auth/testing';

function signedInHeaders() {
  const config = testAuthConfig({ cookieName: 'test_session' });
  const before = Math.floor(Date.now() / 1000);
  const defaults = sessionCookie(config);
  const decoded = decodeSession(config, defaults.cookie.slice('test_session='.length));
  expect(decoded).toMatchObject({ sub: 'owner', orgId: 'org-acme', roles: [], exp: 2000000000 });
  expect(decoded.authTime).toBeGreaterThanOrEqual(before);
  expect(decoded.authTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  const overrides = { sub: 'alice', orgId: 'org-other', roles: ['admin'],
    authTime: 1234, exp: 2100000000 };
  const headers = sessionCookie(config, overrides);
  expect(decodeSession(config, headers.cookie.slice('test_session='.length))).toEqual(overrides);
}

it('returns request headers for a signed-in person with named overrides', signedInHeaders);
