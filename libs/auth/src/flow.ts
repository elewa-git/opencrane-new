// Copied from OpenCrane 1 (10abd0ef6)
// libs/backend/server/infra/auth/src/sessions/session.types.ts (the
// `oidcFlow` shape); changed: split into its own short-lived cookie instead
// of living inside an `express-session`, since this slice has no
// server-side session store to hold it in.
import { z } from 'zod';
import { createEnvelopeCodec, EnvelopeError } from './codec.ts';
import type { AuthConfig } from './config.ts';

export const flowSchema = z
  .object({
    /** Replay-protection value echoed back by the provider. */
    state: z.string().min(1),
    /** Replay-protection value checked against the returned ID token. */
    nonce: z.string().min(1),
    /** PKCE verifier the token exchange must present. */
    codeVerifier: z.string().min(1),
    /** Sanitised local path to return to after login. */
    returnTo: z.string(),
    /** Unix seconds: when `/auth/login` started this flow. */
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type FlowData = z.infer<typeof flowSchema>;

/** Thrown when the login-flow cookie is missing, tampered with, or expired. */
export class FlowInvalidError extends Error {}

/** A login must complete within this long, or it is discarded. */
export const FLOW_MAX_AGE_SECONDS = 600;

// Keyed like the session cookie: see codecFor in session.ts.
function codecFor(config: AuthConfig) {
  const purpose = ['flow', config.issuerUrl, config.clientId, config.redirectUri, config.flowCookieName].join('|');
  return createEnvelopeCodec(config.cookieSecret, purpose, flowSchema);
}

/** Encrypts login-flow state into the value to store in the flow cookie. */
export function encodeFlow(config: AuthConfig, flow: FlowData): string {
  return codecFor(config).encode(flow);
}

/**
 * Decrypts and validates a login-flow cookie value.
 *
 * @throws {FlowInvalidError} when the cookie was tampered with, does not
 *   match the expected shape, or is older than {@link FLOW_MAX_AGE_SECONDS}.
 */
export function decodeFlow(config: AuthConfig, cookieValue: string, now = new Date()): FlowData {
  let flow: FlowData;
  try {
    flow = codecFor(config).decode(cookieValue);
  } catch (err) {
    if (err instanceof EnvelopeError) {
      throw new FlowInvalidError('login flow cookie is invalid', { cause: err });
    }
    throw err;
  }
  if (now.getTime() / 1000 - flow.createdAt > FLOW_MAX_AGE_SECONDS) {
    throw new FlowInvalidError('login flow has expired');
  }
  return flow;
}
