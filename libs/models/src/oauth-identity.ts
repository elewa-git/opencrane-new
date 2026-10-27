import { importSPKI, jwtVerify } from 'jose';
import { z } from 'zod';
import type { oauthConfigurationSchema } from './oauth-attempt.ts';

type Configuration = Pick<z.infer<typeof oauthConfigurationSchema>,
  'issuer' | 'clientId' | 'identityVerification'>;
const attemptSchema = z.object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u).optional() });
const replySchema = z.object({ id_token: z.string().min(1).max(8192) });
const claimsSchema = z.object({
  sub: z.string().regex(/^[\x21-\x7e]{1,255}$/u), nonce: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string()).min(1)]), azp: z.string().optional(),
  iat: z.int().nonnegative(), exp: z.int().positive(),
});

/** Verify only private saved bytes with the operator's public key. Never follow provider URLs. */
export async function verifyOAuthIdentity(configuration: Configuration,
  contents: string, attemptContents?: string) {
  try {
    // Require the consent nonce only for sign-in. Refresh checks the saved account separately.
    let attempt: z.infer<typeof attemptSchema> | undefined;
    if (attemptContents !== undefined) {
      attempt = attemptSchema.parse(JSON.parse(attemptContents));
    }
    const verification = configuration.identityVerification;
    // Keep older attempts readable without treating missing evidence as a verified account.
    if (!verification || (attempt && !attempt.nonce)) {
      return undefined;
    }
    const reply = replySchema.parse(JSON.parse(contents));
    const key = await importSPKI(verification.publicKey, verification.algorithm);
    const now = Date.now();
    const requiredClaims = ['sub', 'iat', 'exp'];
    if (attempt) {
      requiredClaims.push('nonce');
    }
    const options = { algorithms: [verification.algorithm], issuer: configuration.issuer,
      audience: configuration.clientId, requiredClaims,
      currentDate: new Date(now) };
    const verified = await jwtVerify(reply.id_token, key, options);
    const claims = claimsSchema.parse(verified.payload);
    if ((attempt && claims.nonce !== attempt.nonce) || claims.iat > Math.floor(now / 1000) ||
        claims.exp <= claims.iat ||
        !validAuthorisedParty(claims, configuration.clientId)) {
      throw new Error('OAuth identity refused');
    }
    const identity = { issuer: configuration.issuer, subject: claims.sub };
    return { identity, expiresAt: claims.exp * 1000 };
  } catch {
    // Discard provider values and dependency errors, including attached causes.
    throw new Error('OAuth identity unavailable');
  }
}

function validAuthorisedParty(claims: z.infer<typeof claimsSchema>, clientId: string) {
  const multipleAudiences = Array.isArray(claims.aud) && claims.aud.length > 1;
  if (multipleAudiences || claims.azp !== undefined) {
    return claims.azp === clientId;
  }
  return true;
}
