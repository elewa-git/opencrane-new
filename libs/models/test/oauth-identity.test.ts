import { exportSPKI, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { expect, it, vi } from 'vitest';
import { verifyOAuthIdentity } from '../src/oauth-identity.ts';

const keys = await generateKeyPair('RS256');
const publicKey = await exportSPKI(keys.publicKey);
const configuration = { issuer: 'https://identity.example.test/', clientId: 'fixture',
  identityVerification: { algorithm: 'RS256' as const, publicKey } };
const nonce = 'n'.repeat(43);
const attempt = JSON.stringify({ nonce });
const now = Math.floor(Date.now() / 1000);
const claims: JWTPayload = { iss: configuration.issuer, aud: configuration.clientId,
  sub: 'account-123', nonce, iat: now, exp: now + 300, name: 'unsigned-name-canary' };

async function reply(payload: JWTPayload, algorithm = 'RS256', signingKey = keys.privateKey) {
  const signed = new SignJWT(payload);
  signed.setProtectedHeader({ alg: algorithm,
    jku: 'https://never-fetch.example.test/private-canary' });
  const token = await signed.sign(signingKey);
  return JSON.stringify({ access_token: 'access-canary', id_token: token,
    name: 'unsigned-name-canary', userinfo: 'https://never-fetch.example.test/private-canary' });
}

async function verifiesIdentity() {
  const contents = await reply(claims);
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    expect(await verifyOAuthIdentity(configuration, contents, attempt)).toEqual({
      identity: { issuer: configuration.issuer, subject: 'account-123' },
      expiresAt: (now + 300) * 1000,
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
  }
}
it('returns safe signed identity evidence without fetching provider URLs', verifiesIdentity);

const invalidClaims = [
  { iss: 'https://wrong.example.test/' }, { aud: 'wrong-client' }, { nonce: 'wrong-canary' },
  { exp: now - 1 }, { iat: now + 60 }, { nbf: now + 60 }, { sub: '' }, { sub: 123 },
  { sub: 'bad\nsubject' }, { sub: 'x'.repeat(256) }, { azp: 'wrong-client' },
  { aud: ['fixture', 'other-client'] }, { iss: undefined }, { aud: undefined },
  { nonce: undefined }, { sub: undefined }, { exp: undefined }, { iat: undefined },
];
async function refusesClaims(changes: Record<string, unknown>) {
  const payload = { ...claims, ...changes };
  const contents = await reply(payload);
  await expect(verifyOAuthIdentity(configuration, contents, attempt))
    .rejects.toThrow(/^OAuth identity unavailable$/u);
}
it.each(invalidClaims)('refuses invalid signed OAuth claims %j', refusesClaims);

async function refusesSignature(mode: string) {
  let contents = '{}';
  if (mode === 'signature') {
    const wrongKeys = await generateKeyPair('RS256');
    contents = await reply(claims, 'RS256', wrongKeys.privateKey);
  } else if (mode === 'algorithm') {
    const otherAlgorithm = await generateKeyPair('PS256');
    contents = await reply(claims, 'PS256', otherAlgorithm.privateKey);
  } else if (mode === 'malformed') {
    contents = '{"id_token":"private-canary"}';
  }
  await expect(verifyOAuthIdentity(configuration, contents, attempt))
    .rejects.toThrow(/^OAuth identity unavailable$/u);
}
it.each(['signature', 'algorithm', 'missing', 'malformed'])(
  'refuses %s identity evidence with a safe error', refusesSignature);

async function requiresAuthorisedParty() {
  const contents = await reply({ ...claims, aud: ['fixture', 'other'], azp: 'fixture' });
  expect(await verifyOAuthIdentity(configuration, contents, attempt)).toEqual({
    identity: { issuer: configuration.issuer, subject: 'account-123' },
    expiresAt: (now + 300) * 1000,
  });
}
it('accepts multiple audiences only with the configured authorised party', requiresAuthorisedParty);

async function keepsLegacyUnconfirmed() {
  const contents = await reply(claims);
  expect(await verifyOAuthIdentity(configuration, contents, '{}')).toBeUndefined();
  const legacy = { issuer: configuration.issuer, clientId: configuration.clientId };
  expect(await verifyOAuthIdentity(legacy, contents, attempt)).toBeUndefined();
}
it('keeps an old attempt without nonce or verification settings unconfirmed', keepsLegacyUnconfirmed);

async function sanitisesKeyFailure() {
  const contents = await reply(claims);
  const invalid = { ...configuration, identityVerification: {
    algorithm: 'RS256' as const, publicKey: 'dependency-private-canary' } };
  function caught(error: unknown) {
    return error;
  }
  const error = await verifyOAuthIdentity(invalid, contents, attempt).catch(caught);
  expect(error).toEqual(new Error('OAuth identity unavailable'));
  expect(error).not.toHaveProperty('cause');
  expect(JSON.stringify(error)).not.toContain('canary');
}
it('hides verification dependency errors and private provider values', sanitisesKeyFailure);
