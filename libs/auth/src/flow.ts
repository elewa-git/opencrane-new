// Copied from OpenCrane 1 (10abd0ef6); login state uses its own short-lived cookie.
import { z } from 'zod';
import { createEnvelopeCodec, EnvelopeError } from './codec.ts';
import type { AuthConfig } from './config.ts';

export const flowSchema = z
  .object({
    /** Value the provider returns to show this login was not replayed. */
    state: z.string().min(1),
    /** Value checked against the returned ID token to prevent replay. */
    nonce: z.string().min(1),
    /** PKCE verifier sent when exchanging the code for tokens. */
    codeVerifier: z.string().min(1),
    /** Sanitised local path to return to after login. */
    returnTo: z.string(),
    stepUp: z.object({ approvalId: z.string().regex(/^[a-f0-9]{64}$/u), sub: z.string(), sessionDigest: z.string() }).strict().optional(),
    /** Unix seconds: when `/auth/login` started this flow. */
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type FlowData = z.infer<typeof flowSchema>;

/** Thrown when the login-flow cookie is missing, tampered with, or expired. */
export class FlowInvalidError extends Error {}

/** A login must complete within this long, or it is discarded. */
export const FLOW_MAX_AGE_SECONDS = 600;

// Use a different key purpose from the session cookie; see codecFor in session.ts.
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
