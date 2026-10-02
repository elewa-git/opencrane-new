import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
