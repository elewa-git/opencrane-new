import { readFile } from 'node:fs/promises';
import { createPublicKey, randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type JWTPayload } from 'jose';

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

/** Signed short-lived credentials. Callers keep only the returned id in events. */
export async function tokenIssuer(options: TokenOptions) {
  const pem = await readFile(options.privateKeyPath, 'utf8');
  const key = await importPKCS8(pem, algorithm);
  const publicPem = createPublicKey(pem).export({ type: 'spki', format: 'pem' }).toString();
  const publicKey = await importSPKI(publicPem, algorithm);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function issue(payload: JWTPayload, audience: string, ttl: number, tokenId?: string): Promise<IssuedToken> {
    const issuedAt = now();
    const id = tokenId ?? `token:${randomUUID()}`;
    const expiresAt = issuedAt + ttl;
    const value = await new SignJWT(payload).setProtectedHeader({ alg: algorithm })
      .setIssuer(options.issuer).setAudience(audience).setJti(id)
      .setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(key);
    return { id, value, expiresAt: expiresAt * 1000 };
  }

  return {
    computer(input: { silo: string; computerId: string; assistantId: string; tokenId?: string }) {
      return issue({ typ: 'computer', silo: input.silo, computer: input.computerId,
        assistant: input.assistantId }, computerTokenAudience, options.computerTtlSeconds ?? 600, input.tokenId);
    },
    turn(input: { silo: string; conversationId: string; turnId: string; requesterId: string;
      assistantId: string; computerTokenId?: string; delegation?: string[] }) {
      return issue({ typ: 'turn', silo: input.silo, conversation: input.conversationId,
        computerTokenId: input.computerTokenId, turn: input.turnId, requester: input.requesterId, assistant: input.assistantId,
        delegation: input.delegation ?? [input.requesterId] }, turnTokenAudience,
      options.turnTtlSeconds ?? 120);
    },
    async verify(value: string, audience: string, activeId?: string) {
      const result = await jwtVerify(value, publicKey, { issuer: options.issuer, audience,
        algorithms: [algorithm], currentDate: new Date(now() * 1000) });
      if (activeId !== undefined && result.payload.jti !== activeId) throw new Error('Token has been rotated');
      return result.payload;
    },
  };
}
