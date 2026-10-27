import { importSPKI, jwtVerify } from 'jose';
import { z } from 'zod';
import type { oauthConfigurationSchema } from './oauth-attempt.ts';

type Configuration = Pick<z.infer<typeof oauthConfigurationSchema>,
  'issuer' | 'clientId' | 'identityVerification'>;
const attemptSchema = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional() });
const replySchema = z.object({ id_token: z.string().min(1).max(8192) });
const claimsSchema = z.object({
  sub: z.string().regex(/^[\x21-\x7e]{1,255}$/u), nonce: z.string(),
  aud: z.union([z.string(), z.array(z.string()).min(1)]), azp: z.string().optional(),
  iat: z.int().nonnegative(), exp: z.int().positive(),
});

/** Verify only private saved bytes with the operator's public key. Never follow provider URLs. */
export async function verifyOAuthIdentity(configuration: Configuration,
  contents: string, attemptContents: string) {
  try {
    const attempt = attemptSchema.parse(JSON.parse(attemptContents));
    const verification = configuration.identityVerification;
    // Keep older attempts readable without treating missing evidence as a verified account.
    if (!verification || !attempt.nonce) {
      return undefined;
    }
    const reply = replySchema.parse(JSON.parse(contents));
    const key = await importSPKI(verification.publicKey, verification.algorithm);
    const now = Date.now();
    const options = { algorithms: [verification.algorithm], issuer: configuration.issuer,
      audience: configuration.clientId, requiredClaims: ['sub', 'nonce', 'iat', 'exp'],
      currentDate: new Date(now) };
    const verified = await jwtVerify(reply.id_token, key, options);
    const claims = claimsSchema.parse(verified.payload);
    const multipleAudiences = Array.isArray(claims.aud) && claims.aud.length > 1;
    if (claims.nonce !== attempt.nonce || claims.iat > Math.floor(now / 1000) ||
        claims.exp <= claims.iat ||
        (multipleAudiences && claims.azp !== configuration.clientId) ||
        (claims.azp !== undefined && claims.azp !== configuration.clientId)) {
      throw new Error('OAuth identity refused');
    }
    const identity = { issuer: configuration.issuer, subject: claims.sub };
    return { identity, expiresAt: claims.exp * 1000 };
  } catch {
    // Discard provider values and dependency errors, including attached causes.
    throw new Error('OAuth identity unavailable');
  }
}
