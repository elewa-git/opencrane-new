import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt } from 'jose';
import { afterEach, expect, it } from 'vitest';
import { computerTokenAudience, tokenIssuer, turnTokenAudience } from '../src/index.ts';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

it('signs short-lived computer and turn tokens and refuses rotated ids', async () => {
  directory = await mkdtemp(join(tmpdir(), 'opencrane-tokens-'));
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const path = join(directory, 'signing.pem');
  await writeFile(path, key.privateKey, { mode: 0o600 });
  let now = 1_800_000_000;
  const issuer = await tokenIssuer({ privateKeyPath: path, issuer: 'https://issuer.example/', now: () => now });
  const first = await issuer.computer({ silo: 'test', computerId: 'computer-1', assistantId: 'assistant-1', generation: 1 });
  expect(await issuer.verify(first.value, computerTokenAudience, first.id)).toMatchObject({
    typ: 'computer', silo: 'test', computer: 'computer-1', assistant: 'assistant-1', jti: first.id,
  });
  const turn = await issuer.turn({ silo: 'test', conversationId: 'conversation-1', turnId: 'turn-1',
    requesterId: 'alice', threadId: 'thread-one', task: 'chat_turn', model: 'gpt-6.1-sol', assistantId: 'assistant-1' });
  expect(await issuer.verify(turn.value, turnTokenAudience, turn.id)).toMatchObject({
    typ: 'turn', task: 'chat_turn', model: 'gpt-6.1-sol', requester: 'alice', delegation: ['alice'], jti: turn.id,
  });
  const rotated = await issuer.computer({ silo: 'test', computerId: 'computer-1', assistantId: 'assistant-1', generation: 1 });
  await expect(issuer.verify(first.value, computerTokenAudience, rotated.id)).rejects.toThrow('rotated');
  now += 601;
  await expect(issuer.verify(rotated.value, computerTokenAudience, rotated.id)).rejects.toThrow();
});

async function separatesVerificationAudience() {
  directory = await mkdtemp(join(tmpdir(), 'provider-token-'));
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
  const key = generateKeyPairSync('ec', keyOptions);
  const path = join(directory, 'signing.pem');
  await writeFile(path, key.privateKey, { mode: 0o600 });
  const issuerOptions = { privateKeyPath: path, issuer: 'https://provider-token.invalid/' };
  const issuer = await tokenIssuer(issuerOptions);
  const command = { silo: 'test', memberId: 'owner', commandDigest: 'fixture-digest' };
  const provider = await issuer.providerVerification(command);
  const budget = await issuer.budget(command);
  expect(await issuer.verify(provider.value, 'provider-verification')).toMatchObject({
    typ: 'provider-verification', silo: 'test', memberId: 'owner' });
  await expect(issuer.verify(provider.value, 'budget-admin')).rejects.toThrow();
  await expect(issuer.verify(budget.value, 'provider-verification')).rejects.toThrow();
}
it('provider verification and budget configuration tokens cannot share an audience',
  separatesVerificationAudience);

async function signsProviderChoice() {
  directory = await mkdtemp(join(tmpdir(), 'bound-turn-token-'));
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
  const key = generateKeyPairSync('ec', keyOptions);
  const path = join(directory, 'signing.pem');
  await writeFile(path, key.privateKey, { mode: 0o600 });
  const options = { privateKeyPath: path, issuer: 'https://bound-turn.invalid/' };
  const issuer = await tokenIssuer(options);
  const input = { silo: 'test', assistantId: 'assistant', conversationId: 'chat',
    turnId: 'turn', requesterId: 'alice', threadId: 'thread', task: 'chat_turn',
    model: 'gpt-6-luna', providerId: 'primary', bindingSequence: 42 };
  const token = await issuer.turn(input);
  expect(await issuer.verify(token.value, turnTokenAudience)).toMatchObject({
    providerId: 'primary', bindingSequence: 42, model: 'gpt-6-luna', task: 'chat_turn',
  });
  const incomplete = { ...input, bindingSequence: undefined };
  await expect(issuer.turn(incomplete)).rejects.toThrow();
  const invalid = { ...input, bindingSequence: 0 };
  await expect(issuer.turn(invalid)).rejects.toThrow();
}
it('signs a complete provider choice and refuses incomplete or invalid choices', signsProviderChoice);

it('caps memory passes at two seconds and keeps a shorter caller deadline',
  async function memoryDeadlines() {
    directory = await mkdtemp(join(tmpdir(), 'memory-token-'));
    const options = { namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
      publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
    const key = generateKeyPairSync('ec', options);
    const path = join(directory, 'signing.pem');
    await writeFile(path, key.privateKey, { mode: 0o600 });
    const issuerOptions = { privateKeyPath: path, issuer: 'https://memory-token.invalid/' };
    const issuer = await tokenIssuer(issuerOptions);
    const payload = { requester: 'alice' };
    const longToken = await issuer.memoryContext(payload, Date.now() + 60_000);
    const longClaims = decodeJwt(longToken);
    expect(Number(longClaims.exp) - Number(longClaims.iat)).toBe(2);
    const deadline = Date.now() + 500;
    const shortToken = await issuer.memoryContext(payload, deadline);
    expect(decodeJwt(shortToken).exp).toBe(deadline / 1000);
  });

async function refusesUnknownContextClass() {
  directory = await mkdtemp(join(tmpdir(), 'turn-class-validation-'));
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8' as const, format: 'pem' as const },
    publicKeyEncoding: { type: 'spki' as const, format: 'pem' as const } };
  const key = generateKeyPairSync('ec', keyOptions);
  const path = join(directory, 'signing.pem');
  await writeFile(path, key.privateKey, { mode: 0o600 });
  const options = { privateKeyPath: path, issuer: 'https://class.invalid/' };
  const issuer = await tokenIssuer(options);
  const input = { silo: 'test', assistantId: 'assistant', conversationId: 'child',
    turnId: 'turn', requesterId: 'alice', threadId: 'thread', task: 'chat_turn',
    model: 'gpt-6-luna', contextClass: 'shared_only' as const };
  Object.assign(input, { contextClass: 'private' });
  await expect(issuer.turn(input)).rejects.toThrow();
}
it('refuses an unknown context class before signing a turn pass', refusesUnknownContextClass);
