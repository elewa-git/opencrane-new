import { describe, expect, it } from 'vitest';
import { logoutResponseSchema } from '../src/index.ts';

describe('logoutResponseSchema', () => {
  it('accepts an https address and null', () => {
    expect(logoutResponseSchema.parse({ endSessionUrl: 'https://idp.example/logout?id=1' }).endSessionUrl).toBe(
      'https://idp.example/logout?id=1',
    );
    expect(logoutResponseSchema.parse({ endSessionUrl: null }).endSessionUrl).toBeNull();
  });

  // A provider on a developer's machine, in a test or on a private network has no public domain name.
  it.each([['http://localhost:8080/oidc/v1/end_session'], ['http://127.0.0.1:9000/endsession?client_id=c'], ['http://[::1]:8080/endsession']])(
    'accepts %s',
    (address) => {
      expect(logoutResponseSchema.parse({ endSessionUrl: address }).endSessionUrl).toBe(address);
    },
  );

  it.each([
    ['a javascript: address', { endSessionUrl: 'javascript:alert(1)' }],
    ['a data: address', { endSessionUrl: 'data:text/html,hi' }],
    ['a relative path', { endSessionUrl: '/logout' }],
    ['an ftp: address', { endSessionUrl: 'ftp://idp.example/logout' }],
    ['a missing field', {}],
  ])('rejects %s', (_name, body) => {
    expect(logoutResponseSchema.safeParse(body).success).toBe(false);
  });
});
