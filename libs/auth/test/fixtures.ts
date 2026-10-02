import type { AuthConfig } from '../src/config.ts';

/**
 * Flips one real bit of an encrypted cookie's ciphertext, for tamper tests.
 *
 * Flipping the cookie's LAST character is not reliable: base64url's final
 * character can carry unused padding bits, so some flips silently decode
 * back to the same bytes. The first character of the ciphertext segment
 * never has that problem, so this flips that one instead.
 */
export function tamperCookie(cookieValue: string): string {
  const parts = cookieValue.split('.');
  const ciphertext = parts[3];
  if (parts.length !== 4 || !ciphertext) {
    throw new Error('not a well-formed envelope cookie');
  }
  const firstChar = ciphertext[0];
  parts[3] = (firstChar === 'A' ? 'B' : 'A') + ciphertext.slice(1);
  return parts.join('.');
}

/**
 * Forges a cookie by rewriting part of its plaintext without the key.
 *
 * AES-GCM encrypts like a stream cipher, so XOR-ing the ciphertext bytes at
 * the same offsets changes exactly those plaintext bytes. `knownPlaintext` is
 * what the cookie holds (the test built it), `find` a fragment of it, and
 * `replacement` the same-length text to put there. The result is still valid
 * JSON and still matches the schema (for example `"org-1"` becomes
 * `"org-2"`), so only a real authentication-tag check can reject it. Unlike
 * {@link tamperCookie}, which breaks the leading `{`, `JSON.parse` cannot catch it.
 */
export function replaceInCiphertext(cookieValue: string, knownPlaintext: string, find: string, replacement: string): string {
  const parts = cookieValue.split('.');
  const ciphertext = parts[3];
  const offset = knownPlaintext.indexOf(find);
  if (parts.length !== 4 || !ciphertext || offset === -1 || find.length !== replacement.length) {
    throw new Error('cannot forge this cookie: check the envelope, the fragment and its length');
  }
  const bytes = Buffer.from(ciphertext, 'base64url');
  for (let i = 0; i < find.length; i += 1) {
    bytes[offset + i] = bytes[offset + i]! ^ find.charCodeAt(i) ^ replacement.charCodeAt(i);
  }
  parts[3] = bytes.toString('base64url');
  return parts.join('.');
}

/** Cuts the cookie's authentication tag down to its first `length` bytes. */
export function truncateAuthTag(cookieValue: string, length: number): string {
  const parts = cookieValue.split('.');
  const tag = parts[2];
  if (parts.length !== 4 || !tag) {
    throw new Error('not a well-formed envelope cookie');
  }
  parts[2] = Buffer.from(tag, 'base64url').subarray(0, length).toString('base64url');
  return parts.join('.');
}

/** Cuts the cookie's nonce down to its first `length` bytes. */
export function truncateNonce(cookieValue: string, length: number): string {
  const parts = cookieValue.split('.');
  const nonce = parts[1];
  if (parts.length !== 4 || !nonce) {
    throw new Error('not a well-formed envelope cookie');
  }
  parts[1] = Buffer.from(nonce, 'base64url').subarray(0, length).toString('base64url');
  return parts.join('.');
}

/** A minimal, valid config for tests that never reach the network. */
export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    issuerUrl: 'https://idp.example.test',
    clientId: 'test-client',
    redirectUri: 'https://app.example.test/auth/callback',
    scopes: 'openid profile email',
    cookieSecret: 'a'.repeat(32),
    cookieName: 'oc_session',
    flowCookieName: 'oc_auth_flow',
    cookieSecure: true,
    sessionMaxAgeSeconds: 12 * 60 * 60,
    orgClaim: 'org_id',
    rolesClaim: 'roles',
    extraIdentities: [],
    stepUpMaxAgeSeconds: 5 * 60,
    allowInsecureRequests: false,
    ...overrides,
  };
}
