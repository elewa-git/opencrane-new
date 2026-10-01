// The cookie-forging helpers and the base test config live with the auth
// library's own tests; the server tests reuse them rather than keep a copy.
export {
  replaceInCiphertext,
  tamperCookie,
  testAuthConfig,
  truncateAuthTag,
} from '../../../../libs/auth/test/fixtures.ts';
