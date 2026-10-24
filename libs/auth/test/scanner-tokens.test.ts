import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tokenIssuer, tokenVerifier } from '../src/index.ts';

const issuerName = 'https://scanner-issuer.invalid/';
const request = { purpose: 'upload', requestId: '6be4d239-cb0e-4db2-b5aa-9fa70ff9a681' };
const directories: string[] = [];
let now = 1_800_000_000;

function clock() {
  return now;
}

async function cleanup() {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
  }
  directories.length = 0;
  now = 1_800_000_000;
}
afterEach(cleanup);

async function fixture(service: 'server' | 'image-worker' = 'server') {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-identity-'));
  directories.push(directory);
  const keyOptions = {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const },
  };
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = join(directory, 'signing.pem');
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const options = {
    privateKeyPath, issuer: issuerName, now: clock,
    scannerIdentity: { service, silo: 'silo-one' },
  };
  const tokens = await tokenIssuer(options);
  const services = { server: 'silo-one', 'image-worker': 'silo-one' };
  const verifier = tokenVerifier(tokens.jwks, issuerName, clock, services);
  return { tokens, verifier, options, services, key };
}

async function acceptsConfiguredIdentity(service: 'server' | 'image-worker', purpose: string) {
  const { tokens, verifier } = await fixture(service);
  const input = { ...request, purpose };
  const pass = await tokens.scanner(input);
  const claims = await verifier.verifyScanner(pass.value, input);
  expect(claims).toEqual({
    typ: 'scanner', aud: 'scanner', iss: issuerName, service, silo: 'silo-one',
    purpose, requestId: request.requestId, iat: now, exp: now + 120, jti: pass.id,
  });
  expect(pass.expiresAt).toBe((now + 120) * 1000);
  expect(tokens.jwks.keys[0]).not.toHaveProperty('d');
}

const identities = [['server', 'upload'], ['image-worker', 'image']] as const;
it.each(identities)('accepts the configured %s identity for %s', acceptsConfiguredIdentity);
