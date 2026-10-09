import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { tokenIssuer } from '../src/index.ts';

const malformedChoices = [
  { providerId: 'bad/provider', bindingSequence: 42 },
  { providerId: 'x'.repeat(201), bindingSequence: 42 },
  { providerId: 'primary', bindingSequence: 1.5 },
  { providerId: 'primary', bindingSequence: Number.MAX_SAFE_INTEGER + 1 },
];
async function refusesMalformedChoiceAtSigning(choice: {
  providerId: string; bindingSequence: number;
}) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-choice-validation-'));
  try {
    const keyOptions = {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    } as const;
    const key = generateKeyPairSync('ec', keyOptions);
    const privateKeyPath = join(directory, 'signing.pem');
    await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
    const options = { privateKeyPath, issuer: 'https://choice.invalid/' };
    const issuer = await tokenIssuer(options);
    const input = {
      silo: 'test', assistantId: 'assistant', conversationId: 'conversation',
      turnId: 'turn', requesterId: 'alice', threadId: 'thread', task: 'chat_turn',
      model: 'gpt-6-luna', ...choice,
    };
    await expect(issuer.turn(input)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it.each(malformedChoices)('refuses malformed provider choices before signing %j',
  refusesMalformedChoiceAtSigning);
