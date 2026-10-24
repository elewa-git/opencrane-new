import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { EventStore } from '@opencrane/event-store';
import { decodeJwt, importPKCS8, SignJWT, type JWTPayload } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { scannerTokenAudience, tokenIssuer, tokenVerifier } from '../src/index.ts';

const issuerName = 'https://scanner-issuer.invalid/';
const request = { purpose: 'upload', requestId: '6be4d239-cb0e-4db2-b5aa-9fa70ff9a681' };
const directories: string[] = [];
let now = 1_800_000_000;

function clock() {
  return now;
}

function forbiddenEffect(): never {
  throw new Error('canary-forbidden-effect');
}

function guardEffects() {
  const append = vi.spyOn(EventStore.prototype, 'append');
  const connect = vi.spyOn(Socket.prototype, 'connect');
  const fetch = vi.spyOn(globalThis, 'fetch');
  append.mockImplementation(forbiddenEffect);
  connect.mockImplementation(forbiddenEffect);
  fetch.mockImplementation(forbiddenEffect);
}
beforeEach(guardEffects);

async function cleanup() {
  expect(EventStore.prototype.append).not.toHaveBeenCalled();
  expect(Socket.prototype.connect).not.toHaveBeenCalled();
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
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

async function signClaims(payload: JWTPayload, pem: string) {
  const key = await importPKCS8(pem, 'ES256');
  const token = new SignJWT(payload);
  token.setProtectedHeader({ alg: 'ES256', kid: 'lifecycle' });
  return token.sign(key);
}

const invalidClaims: [string, unknown][] = [
  ['iss', 'https://foreign-issuer.invalid/'],
  ['aud', 'agentgateway'], ['aud', ['scanner', 'agentgateway']],
  ['typ', 'computer'], ['service', 'unknown-service'], ['silo', 'silo-two'],
  ['purpose', 'image'], ['requestId', '3eb757d2-9d4f-439f-8d18-7619e279eb1d'],
  ['iat', undefined], ['exp', undefined], ['iat', now + 1], ['nbf', now + 1],
  ['exp', now], ['exp', now + 121], ['iat', now + 0.5], ['exp', now + 119.5],
  ['jti', undefined], ['canary-field', 'canary-claim-value'],
];

async function refusesChangedClaim(field: string, value: unknown) {
  const { tokens, verifier, key } = await fixture();
  const pass = await tokens.scanner(request);
  const claims = decodeJwt(pass.value);
  claims[field] = value;
  const changed = await signClaims(claims, key.privateKey);
  await expect(verifier.verifyScanner(changed, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it.each(invalidClaims)('refuses an independently changed claim %s = %s', refusesChangedClaim);

async function refusesSignatureChange() {
  const { tokens, verifier } = await fixture();
  const pass = await tokens.scanner(request);
  const parts = pass.value.split('.');
  const signature = Buffer.from(parts[2]!, 'base64url');
  signature[0] = signature[0]! ^ 1;
  parts[2] = signature.toString('base64url');
  await expect(verifier.verifyScanner(parts.join('.'), request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it('refuses an altered signature', refusesSignatureChange);

async function checksTrustReplacement() {
  const original = await fixture();
  const replacement = await fixture();
  const oldPass = await original.tokens.scanner(request);
  const newPass = await replacement.tokens.scanner(request);
  await expect(original.verifier.verifyScanner(newPass.value, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
  await expect(replacement.verifier.verifyScanner(oldPass.value, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
  await rm(replacement.options.privateKeyPath);
  expect(await replacement.verifier.verifyScanner(newPass.value, request)).toMatchObject(request);
}
it('uses public keys alone and rejects the old signer after trust replacement',
  checksTrustReplacement);

async function checksMappedService(service: 'server' | 'image-worker', purpose: string) {
  const { tokens, services } = await fixture(service);
  const input = { ...request, purpose };
  const pass = await tokens.scanner(input);
  const absent = { ...services };
  delete absent[service];
  const wrong = { ...services, [service]: 'silo-two' };
  for (const mapping of [absent, wrong]) {
    const verifier = tokenVerifier(tokens.jwks, issuerName, clock, mapping);
    await expect(verifier.verifyScanner(pass.value, input)).rejects.toEqual(
      new Error('Scanner pass refused'),
    );
  }
}
it.each(identities)('requires the configured mapping for %s/%s', checksMappedService);

async function checksServicePurpose(service: 'server' | 'image-worker', purpose: string) {
  const { tokens, verifier, key } = await fixture(service);
  const input = { ...request, purpose };
  const pass = await tokens.scanner(input);
  const wrong = { ...request, purpose: 'image' };
  if (service === 'image-worker') {
    wrong.purpose = 'upload';
  }
  await expect(tokens.scanner(wrong)).rejects.toEqual(new Error('Scanner pass refused'));
  const claims = { ...decodeJwt(pass.value), purpose: wrong.purpose };
  const forged = await signClaims(claims, key.privateKey);
  await expect(verifier.verifyScanner(forged, wrong)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it.each(identities)('limits %s to %s even when the expected purpose agrees', checksServicePurpose);

const extraInputs = [
  { service: 'image-worker' }, { silo: 'silo-two' }, { exp: now + 600 },
  { issuer: 'canary-issuer' }, { 'canary-field': 'canary-input-value' },
  { purpose: 'canary-purpose' }, { requestId: 'canary-request' },
];
async function refusesRequestOverrides(extra: Record<string, unknown>) {
  const { tokens, verifier } = await fixture();
  const pass = await tokens.scanner(request);
  const input = { ...request, ...extra };
  await expect(tokens.scanner(input)).rejects.toEqual(new Error('Scanner pass refused'));
  await expect(verifier.verifyScanner(pass.value, input)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it.each(extraInputs)('refuses request overrides and unknown input: %j', refusesRequestOverrides);

async function checksExpectedRequest() {
  const { tokens, verifier } = await fixture();
  const pass = await tokens.scanner(request);
  const otherPurpose = { ...request, purpose: 'image' };
  const otherRequest = { ...request, requestId: '3eb757d2-9d4f-439f-8d18-7619e279eb1d' };
  for (const expected of [otherPurpose, otherRequest]) {
    await expect(verifier.verifyScanner(pass.value, expected)).rejects.toEqual(
      new Error('Scanner pass refused'),
    );
  }
  now += 119;
  expect(await verifier.verifyScanner(pass.value, request)).toMatchObject(request);
  now += 1;
  await expect(verifier.verifyScanner(pass.value, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it('checks the exact expected purpose/request and expires at 120 seconds', checksExpectedRequest);

async function keepsDeploymentIdentity() {
  const { tokens, verifier, options, services } = await fixture();
  options.scannerIdentity.service = 'image-worker';
  options.scannerIdentity.silo = 'silo-two';
  services.server = 'silo-two';
  const pass = await tokens.scanner(request);
  expect(await verifier.verifyScanner(pass.value, request)).toMatchObject({
    service: 'server', silo: 'silo-one',
  });
  const unconfigured = { privateKeyPath: options.privateKeyPath, issuer: issuerName, now: clock };
  const plain = await tokenIssuer(unconfigured);
  await expect(plain.scanner(request)).rejects.toEqual(new Error('Scanner pass refused'));
  const noMapping = tokenVerifier(tokens.jwks, issuerName, clock);
  await expect(noMapping.verifyScanner(pass.value, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it('copies deployment identity and refuses absent identity or mapping', keepsDeploymentIdentity);

async function separatesAudiences() {
  const { tokens, verifier, key } = await fixture();
  const computer = { silo: 'silo-one', computerId: 'computer',
    assistantId: 'assistant', generation: 1 };
  const turn = { silo: 'silo-one', conversationId: 'chat', turnId: 'turn',
    requesterId: 'person', threadId: 'thread', task: 'chat_turn', model: 'model',
    assistantId: 'assistant' };
  for (const pass of [await tokens.computer(computer), await tokens.turn(turn)]) {
    await expect(verifier.verifyScanner(pass.value, request)).rejects.toEqual(
      new Error('Scanner pass refused'),
    );
  }
  const scanner = await tokens.scanner(request);
  for (const audience of ['agentgateway', 'decision-service', scannerTokenAudience]) {
    await expect(verifier.verify(scanner.value, audience)).rejects.toThrow();
    const claims = { ...decodeJwt(scanner.value), aud: audience };
    const changed = await signClaims(claims, key.privateKey);
    await expect(verifier.verify(changed, audience)).rejects.toEqual(
      new Error('Scanner pass refused'),
    );
  }
  const claims = { ...decodeJwt(scanner.value), typ: 'computer' };
  const changed = await signClaims(claims, key.privateKey);
  await expect(verifier.verify(changed, scannerTokenAudience)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
}
it('keeps scanner, computer and turn audiences separate', separatesAudiences);

async function hidesMalformedInput() {
  const { tokens, verifier, services, options } = await fixture();
  const pass = await tokens.scanner(request);
  for (const input of [null, {}, 'canary-input', { purpose: 'upload' }]) {
    await expect(tokens.scanner(input)).rejects.toEqual(new Error('Scanner pass refused'));
    await expect(verifier.verifyScanner(pass.value, input)).rejects.toEqual(
      new Error('Scanner pass refused'),
    );
  }
  await expect(verifier.verifyScanner('canary-token', request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
  function brokenClock(): number {
    throw new Error('canary-upstream-error');
  }
  const broken = tokenVerifier(tokens.jwks, issuerName, brokenClock, services);
  await expect(broken.verifyScanner(pass.value, request)).rejects.toEqual(
    new Error('Scanner pass refused'),
  );
  const brokenOptions = { ...options, now: brokenClock };
  const brokenIssuer = await tokenIssuer(brokenOptions);
  await expect(brokenIssuer.scanner(request)).rejects.toEqual(new Error('Scanner pass refused'));
}
it('never returns canary input, token or underlying errors', hidesMalformedInput);

const invalidIdentities = [
  null, {}, { service: 'server' }, { silo: 'silo-one' },
  { service: 'canary-service', silo: 'silo-one' },
  { service: 'server', silo: 'canary/invalid-silo' },
  { service: 'server', silo: 'silo-one', purpose: 'image' },
];
async function refusesInvalidDeployment(identity: unknown) {
  const { options } = await fixture();
  Object.assign(options, { scannerIdentity: identity });
  await expect(tokenIssuer(options)).rejects.toEqual(new Error('Scanner pass refused'));
}
it.each(invalidIdentities)('refuses invalid deployment identity %j', refusesInvalidDeployment);
