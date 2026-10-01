// Test helpers other packages may reuse (the server's tests import this as
// `@opencrane/auth/testing`) instead of reaching into this folder by path.
// It needs fastify and jose, which are dev-only: production code must not import it.
export { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag, truncateNonce } from './fixtures.ts';
export { DEFAULT_MOCK_USER, MOCK_ID_TOKEN_LIFETIME_SECONDS, startMockOidcProvider, type MockOidcOptions, type MockOidcProvider, type MockUser } from './mock-oidc-provider.ts';
