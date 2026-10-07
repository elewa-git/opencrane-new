// Copied from OpenCrane 1 (10abd0ef6); sessions keep the ID token for provider logout.
import { z } from 'zod';
import { createEnvelopeCodec, EnvelopeError } from './codec.ts';
import type { AuthConfig } from './config.ts';

export const sessionSchema = z
  .object({
    /** Used only for provider logout; optional for existing and dev-only sessions. */
    idToken: z.string().min(1).optional(),
    stepUpApproval: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    /** Display only; never used for authorisation. */
    name: z.string().optional(),
    /** Stable subject identifier from the identity provider. */
    sub: z.string().min(1),
    /** The caller's organisation, from the configured org claim. */
    orgId: z.string().min(1),
    /** The caller's roles, from the configured roles claim. */
    roles: z.array(z.string()),
    /** Unix seconds: when the person last actually authenticated. */
    authTime: z.number().int().nonnegative(),
    /** Unix seconds: when this session stops being valid. */
    exp: z.number().int().positive(),
  })
  .strict();

export type SessionData = z.infer<typeof sessionSchema>;

/** Thrown when a session cookie is missing, tampered with, or malformed. */
export class SessionInvalidError extends Error {}
/** Thrown when a session cookie is well-formed but past its expiry. */
export class SessionExpiredError extends Error {}

// Include the issuer, client, redirect URI and cookie name in the key. A
// provider or client change must invalidate old sessions even if the secret
// is reused.
function codecFor(config: AuthConfig) {
  const purpose = ['session', config.issuerUrl, config.clientId, config.redirectUri, config.cookieName].join('|');
  return createEnvelopeCodec(config.cookieSecret, purpose, sessionSchema);
}

/** Encrypts a session into the value to store in the session cookie. */
export function encodeSession(config: AuthConfig, session: SessionData): string {
  return codecFor(config).encode(session);
}

/**
 * Decrypts and validates a session cookie value.
 *
 * @throws {SessionInvalidError} when the cookie was tampered with, signed
 *   with a different secret, or does not match the expected shape.
 * @throws {SessionExpiredError} when the cookie is genuine but `exp` has
 *   passed.
 */
export function decodeSession(config: AuthConfig, cookieValue: string, now = new Date()): SessionData {
  let session: SessionData;
  try {
    session = codecFor(config).decode(cookieValue);
  } catch (err) {
    if (err instanceof EnvelopeError) {
      throw new SessionInvalidError('session cookie is invalid', { cause: err });
    }
    throw err;
  }
  if (session.exp * 1000 <= now.getTime()) {
    throw new SessionExpiredError('session has expired');
  }
  return session;
}

/**
 * Checks sign-in freshness for a sensitive action, without checking session expiry.
 */
export function isAuthTimeRecent(session: SessionData, maxAgeSeconds: number, now = new Date()): boolean {
  return now.getTime() / 1000 - session.authTime <= maxAgeSeconds;
}

/**
 * Checks sign-in freshness using the deployment's `stepUpMaxAgeSeconds` setting.
 */
export function hasRecentAuth(config: AuthConfig, session: SessionData, now = new Date()): boolean {
  return isAuthTimeRecent(session, config.stepUpMaxAgeSeconds, now);
}
