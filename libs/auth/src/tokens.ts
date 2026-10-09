import { readFile } from 'node:fs/promises';
import { createPublicKey, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';

const algorithm = 'ES256';
export const computerTokenAudience = 'agentgateway';
export const turnTokenAudience = 'decision-service';

export interface IssuedToken {
  id: string;
  value: string;
  expiresAt: number;
}

interface TokenOptions {
  privateKeyPath: string;
  issuer: string;
  computerTtlSeconds?: number;
  turnTtlSeconds?: number;
  now?: () => number;
}

/** Public-key verification shared by the issuer and gateway decision process. */
export function tokenVerifier(jwks: JSONWebKeySet, issuer: string, now = () => Math.floor(Date.now() / 1000)) {
  const keys = createLocalJWKSet(jwks);
  return {
    async verify(value: string, audience: string, activeId?: string) {
      const result = await jwtVerify(value, keys, { issuer, audience, algorithms: [algorithm],
        requiredClaims: ['exp', 'iat', 'jti'], maxTokenAge: audience === turnTokenAudience ? '2m' : '10m',
        currentDate: new Date(now() * 1000) });
      const { iat, exp } = result.payload;
      if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp! <= iat! ||
          exp! - iat! > (audience === turnTokenAudience ? 120 : 600)) throw new Error('Invalid token lifetime');
      if (activeId !== undefined && result.payload.jti !== activeId) throw new Error('Token has been rotated');
      return result.payload;
    },
  };
}

/** Signed short-lived credentials. Callers keep only the returned id in events. */
export async function tokenIssuer(options: TokenOptions) {
  const pem = await readFile(options.privateKeyPath, 'utf8');
  const key = await importPKCS8(pem, algorithm);
  const publicPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();
  const publicKey = await importSPKI(publicPem, algorithm);
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: 'lifecycle', alg: algorithm, use: 'sig' }] };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function issue(payload: JWTPayload, audience: string, ttl: number, tokenId?: string): Promise<IssuedToken> {
    const issuedAt = now();
    const id = tokenId ?? `token:${randomUUID()}`;
    const expiresAt = issuedAt + ttl;
    const value = await new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: 'lifecycle' })
      .setIssuer(options.issuer).setAudience(audience).setJti(id)
      .setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(key);
    return { id, value, expiresAt: expiresAt * 1000 };
  }

  return {
    jwks,
    ...tokenVerifier(jwks, options.issuer, now),
    memoryContext(payload: JWTPayload, expiresAt: number) {
      const issuedAt = Date.now() / 1000;
      const expires = Math.min(expiresAt / 1000, issuedAt + 2);
      const token = new SignJWT(payload);
      token.setProtectedHeader({ alg: algorithm, kid: 'lifecycle' });
      token.setIssuer(options.issuer);
      token.setAudience('memory-mcp');
      token.setIssuedAt(issuedAt);
      token.setExpirationTime(expires);
      return token.sign(key);
    },
    budget(input: { silo: string; memberId: string; commandDigest: string }) {
      return issue({ typ: 'budget-admin', silo: input.silo, memberId: input.memberId, commandDigest: input.commandDigest }, 'budget-admin', 30);
    },
    providerVerification(input: { silo: string; memberId: string; commandDigest: string }) {
      const payload = { typ: 'provider-verification', ...input };
      return issue(payload, 'provider-verification', 30);
    },
    computer(input: { silo: string; computerId: string; assistantId: string; generation: number; tokenId?: string }) {
      return issue({ typ: 'computer', silo: input.silo, computer: input.computerId,
        assistant: input.assistantId, generation: input.generation }, computerTokenAudience, options.computerTtlSeconds ?? 600, input.tokenId);
    },
    turn(input: { silo: string; conversationId: string; turnId: string; requesterId: string; threadId: string; task: string; model: string;
      assistantId: string; computerTokenId?: string; delegation?: string[] }) {
      return issue({ typ: 'turn', silo: input.silo, conversation: input.conversationId, thread: input.threadId, task: input.task, model: input.model,
        computerTokenId: input.computerTokenId, turn: input.turnId, requester: input.requesterId, assistant: input.assistantId,
        delegation: input.delegation ?? [input.requesterId] }, turnTokenAudience,
      options.turnTtlSeconds ?? 120);
    },
  };
}
