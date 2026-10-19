import { z } from 'zod';
import { egressDestinationSchema, optionalProviderTurnBindingSchema } from '@opencrane/events';
import { readFile } from 'node:fs/promises';
import { createPublicKey, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, importPKCS8, importSPKI, jwtVerify, SignJWT, type JSONWebKeySet, type JWTPayload } from 'jose';

const turnClaimsSchema = optionalProviderTurnBindingSchema.safeExtend({
  sharingClass: z.literal('shared_only').optional(),
});

const algorithm = 'ES256';
export const computerTokenAudience = 'agentgateway';
export const turnTokenAudience = 'decision-service';

const egressId = z.string().regex(/^[\w-]{1,200}$/u);
const egressInput = egressDestinationSchema.extend({
  silo: egressId, requester: egressId, assistant: egressId, computer: egressId,
  generation: z.int().positive(), conversation: egressId, thread: egressId, turn: egressId,
  operationId: egressId, operationKind: egressId,
  operationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  channel: z.enum(['command', 'desktop']), siloPosition: z.int().positive(),
  personPosition: z.int().positive(), assistantPosition: z.int().positive(),
  turnExpiresAt: z.int().positive(), grantExpiresAt: z.int().positive(),
  leaseExpiresAt: z.int().positive().optional(),
});
const egressClaims = egressInput.extend({ typ: z.literal('computer-egress'),
  aud: z.literal('computer-egress'), iss: z.string(), jti: z.uuid(),
  iat: z.int(), exp: z.int() });
export type EgressCapability = z.infer<typeof egressClaims>;

function egressExpiry(input: z.infer<typeof egressInput>) {
  if (input.channel === 'desktop' && input.leaseExpiresAt === undefined) {
    throw new Error('Egress capability refused');
  }
  return Math.floor(Math.min(input.turnExpiresAt, input.grantExpiresAt,
    input.leaseExpiresAt ?? Infinity) / 1000);
}
function lifetime(audience: string) {
  if (audience === 'computer-egress') return 60;
  if (audience === turnTokenAudience) return 120;
  return 600;
}

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
        requiredClaims: ['exp', 'iat', 'jti'], maxTokenAge: lifetime(audience),
        currentDate: new Date(now() * 1000) });
      const { iat, exp } = result.payload;
      if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp! <= iat! ||
          exp! - iat! > lifetime(audience)) throw new Error('Invalid token lifetime');
      if (activeId !== undefined && result.payload.jti !== activeId) throw new Error('Token has been rotated');
      if (audience === 'computer-egress') {
        const claims = egressClaims.parse(result.payload);
        if (claims.exp > egressExpiry(claims)) throw new Error('Egress capability refused');
      } else if (result.payload['typ'] === 'computer-egress') {
        throw new Error('Egress capability refused');
      }
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

  async function issue(payload: JWTPayload, audience: string, ttl: number,
    tokenId?: string, expiryLimit = Infinity): Promise<IssuedToken> {
    const issuedAt = now();
    const id = tokenId ?? `token:${randomUUID()}`;
    const expiresAt = Math.min(issuedAt + ttl, expiryLimit);
    if (expiresAt <= issuedAt) throw new Error('Invalid token lifetime');
    const value = await new SignJWT(payload).setProtectedHeader({ alg: algorithm, kid: 'lifecycle' })
      .setIssuer(options.issuer).setAudience(audience).setJti(id)
      .setIssuedAt(issuedAt).setExpirationTime(expiresAt).sign(key);
    return { id, value, expiresAt: expiresAt * 1000 };
  }

  return {
    jwks,
    ...tokenVerifier(jwks, options.issuer, now),
    async egress(input: z.infer<typeof egressInput>) {
      const checked = egressInput.parse(input);
      const payload = { ...checked, typ: 'computer-egress' };
      return issue(payload, 'computer-egress', 60, randomUUID(), egressExpiry(checked));
    },
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
    takeoverGate(input: { silo: string; computer: string; assistant: string;
      generation: number; podUid: string; takeoverId: string; affectedTurnIds: string[] }) {
      const payload = { ...input, typ: 'takeover-gate' };
      return issue(payload, 'takeover-gate', 30);
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
    async turn(input: {
      silo: string; conversationId: string; turnId: string; requesterId: string;
      threadId: string; task: string; model: string; assistantId: string;
      computerTokenId?: string; delegation?: string[];
      sharingClass?: 'shared_only' | undefined;
      providerId?: string | undefined; bindingSequence?: number | undefined;
    }) {
      const claims = { providerId: input.providerId, bindingSequence: input.bindingSequence,
        sharingClass: input.sharingClass };
      const checkedClaims = turnClaimsSchema.parse(claims);
      const payload = {
        ...checkedClaims, typ: 'turn', silo: input.silo,
        conversation: input.conversationId, thread: input.threadId,
        task: input.task, model: input.model, computerTokenId: input.computerTokenId,
        turn: input.turnId, requester: input.requesterId, assistant: input.assistantId,
        delegation: input.delegation ?? [input.requesterId],
      };
      return issue(payload, turnTokenAudience, options.turnTtlSeconds ?? 120);
    },
  };
}

export async function verifyEgressCapability(verifier: ReturnType<typeof tokenVerifier>,
  value: string, channel: EgressCapability['channel']) {
  const payload = await verifier.verify(value, 'computer-egress');
  const claims = egressClaims.parse(payload);
  if (claims.channel !== channel) throw new Error('Egress capability refused');
  return claims;
}
