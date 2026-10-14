import { createPublicKey, verify } from 'node:crypto';
import { record } from './http.ts';

function publicVerifier(value: unknown) {
  const jwk = record(value);
  const allowed = new Set(['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use']);
  for (const field of Object.keys(jwk)) {
    if (!allowed.has(field)) throw new Error('Invalid credential');
  }
  if (jwk['kty'] !== 'EC' || jwk['crv'] !== 'P-256'
    || typeof jwk['x'] !== 'string' || typeof jwk['y'] !== 'string'
    || !/^[\w-]{43}$/u.test(jwk['x']) || !/^[\w-]{43}$/u.test(jwk['y'])
    || (jwk['kid'] !== undefined && jwk['kid'] !== 'lifecycle')
    || (jwk['alg'] !== undefined && jwk['alg'] !== 'ES256')
    || (jwk['use'] !== undefined && jwk['use'] !== 'sig')) {
    throw new Error('Invalid credential');
  }
  return jwk;
}

function reference(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new Error('Invalid credential');
  }
  return value;
}

export function credentialIdentity(value: string, suppliedVerifier: unknown,
  claims: Record<string, unknown>) {
  // Trust keys only from root Pod exec. Public keys cannot be used to sign a gate.
  const verifier = publicVerifier(suppliedVerifier);
  const [encodedHeader, payload, signature] = value.split('.');
  if (!encodedHeader || !payload || !signature) throw new Error('Invalid credential');
  const decodedHeader = Buffer.from(encodedHeader, 'base64url').toString();
  const header = record(JSON.parse(decodedHeader) as unknown);
  for (const field of Object.keys(header)) {
    if (field !== 'alg' && field !== 'kid') throw new Error('Invalid credential');
  }
  if (header['alg'] !== 'ES256' || header['kid'] !== 'lifecycle') {
    throw new Error('Invalid credential');
  }
  const keyOptions = { key: verifier, format: 'jwk' as const };
  const key = createPublicKey(keyOptions);
  const options = { key, dsaEncoding: 'ieee-p1363' as const };
  const signed = Buffer.from(`${encodedHeader}.${payload}`);
  const bytes = Buffer.from(signature, 'base64url');
  if (bytes.length !== 64 || !verify('sha256', signed, options, bytes)) {
    throw new Error('Invalid credential');
  }
  const generation = claims['generation'];
  if (claims['aud'] !== 'agentgateway' || typeof generation !== 'number'
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('Invalid credential');
  }
  return { verifier, issuer: reference(claims['iss']), silo: reference(claims['silo']),
    computer: reference(claims['computer']), assistant: reference(claims['assistant']),
    generation, podUid: reference(process.env['POD_UID']) };
}
