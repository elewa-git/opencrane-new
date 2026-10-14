import { createPublicKey, verify } from 'node:crypto';
import { record } from './http.ts';

export interface GateIdentity {
  verifier: unknown;
  issuer: string;
  silo: string;
  computer: string;
  assistant: string;
  generation: number;
  podUid: string;
}

export interface GateBinding {
  takeoverId: string;
  generation: number;
  affectedTurnIds: string[];
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,200}$/u.test(value)) {
    throw new Error('Invalid bridge gate');
  }
  return value;
}

function matchesIdentity(claims: Record<string, unknown>, identity: GateIdentity) {
  return claims['typ'] === 'takeover-gate' && claims['aud'] === 'takeover-gate'
    && claims['iss'] === identity.issuer && claims['silo'] === identity.silo
    && claims['computer'] === identity.computer && claims['assistant'] === identity.assistant
    && claims['podUid'] === identity.podUid && claims['generation'] === identity.generation;
}

function validTime(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = claims['iat'];
  const expiresAt = claims['exp'];
  if (typeof issuedAt !== 'number' || typeof expiresAt !== 'number') return false;
  return Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt)
    && issuedAt <= now + 5 && expiresAt > now && expiresAt > issuedAt
    && expiresAt - issuedAt <= 30;
}

function gateClaims(value: unknown, identity: GateIdentity): GateBinding {
  const claims = record(value);
  if (!matchesIdentity(claims, identity) || !validTime(claims)
    || typeof claims['jti'] !== 'string') {
    throw new Error('Invalid bridge gate');
  }
  const takeoverId = identifier(claims['takeoverId']);
  const turns = claims['affectedTurnIds'];
  if (!Array.isArray(turns) || turns.length > 64) throw new Error('Invalid bridge gate');
  const affectedTurnIds = turns.map(identifier);
  affectedTurnIds.sort();
  if (new Set(affectedTurnIds).size !== affectedTurnIds.length) {
    throw new Error('Invalid bridge gate');
  }
  return { takeoverId, generation: identity.generation, affectedTurnIds };
}

function tokenParts(gate: unknown) {
  if (typeof gate !== 'string' || gate.length > 8192) {
    throw new Error('Invalid bridge gate');
  }
  const parts = gate.split('.');
  if (parts.length !== 3) throw new Error('Invalid bridge gate');
  for (const part of parts) {
    if (!/^[\w-]+$/u.test(part)) throw new Error('Invalid bridge gate');
  }
  const encodedHeader = parts[0];
  const encodedClaims = parts[1];
  const encodedSignature = parts[2];
  if (!encodedHeader || !encodedClaims || !encodedSignature) {
    throw new Error('Invalid bridge gate');
  }
  return { encodedHeader, encodedClaims, encodedSignature };
}

function publicVerifierKey(value: unknown) {
  const verifier = record(value);
  if (verifier['kty'] !== 'EC' || verifier['crv'] !== 'P-256'
    || typeof verifier['x'] !== 'string' || typeof verifier['y'] !== 'string'
    || 'd' in verifier) throw new Error('Invalid bridge gate');
  const jwk = { kty: 'EC', crv: 'P-256', x: verifier['x'], y: verifier['y'] };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

export function requireBridgeGateAuthority(gate: unknown, identity: GateIdentity | undefined): GateBinding {
  if (!identity) throw new Error('Invalid bridge gate');
  const { encodedHeader, encodedClaims, encodedSignature } = tokenParts(gate);
  const header = record(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()) as unknown);
  if (header['alg'] !== 'ES256' || header['kid'] !== 'lifecycle'
    || Object.keys(header).length !== 2) throw new Error('Invalid bridge gate');
  const key = publicVerifierKey(identity.verifier);
  const signed = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, 'base64url');
  const options = { key, dsaEncoding: 'ieee-p1363' as const };
  if (signature.length !== 64 || !verify('sha256', signed, options, signature)) {
    throw new Error('Invalid bridge gate');
  }
  const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString()) as unknown;
  return gateClaims(claims, identity);
}
