import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { serverEvent } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { sha256Hex } from '@opencrane/events/digest';
import { conversationKeys } from '@opencrane/projections';
import { approvedPersonaReader } from '../src/onboarding/approved-persona.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let directory: string;
let keys: ReturnType<typeof conversationKeys>;
let read: ReturnType<typeof approvedPersonaReader>;

async function append(type: string, data: object, id: string) {
  const event = serverEvent({ silo: 'test', subject: 'personal-alice', type, data,
    id, commandId: id, principal: { kind: 'human', id: 'alice' } });
  await nats.seed([event]);
}

async function start() {
  nats = await natsFixture();
  directory = mkdtempSync(`${tmpdir()}/approved-persona-`);
  keys = conversationKeys(directory);
  keys.provision('test', 'personal:alice');
  const member = envelope('test', 'member-alice', 'member.joined', {
    memberId: 'alice', email: 'alice@example.test', displayName: 'Alice', role: 'member' });
  const assistant = envelope('test', 'assistant-assistant', 'assistant.created', {
    assistantId: 'assistant', ownerId: 'alice', kind: 'personal' });
  await nats.seed([member, assistant]);
  read = approvedPersonaReader({ silo: 'test', store: nats.store, keys });
}
async function close() {
  await nats?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
}
beforeEach(start);
afterEach(close);

async function revision(text: string, number: number) {
  const encrypted = keys.encrypt('test', 'personal:alice', text);
  await append('onboarding.persona_revised', {
    schemaVersion: 1, memberId: 'alice', generation: 1, revision: number,
    rendererVersion: 'persona-v1', mode: 'replace', encrypted: encrypted.ciphertext,
    encryptedDigest: sha256Hex(Buffer.from(encrypted.ciphertext, 'base64')),
    keyRef: encrypted.keyId }, `revision-${number}`);
}

async function survey() {
  for (let step = 1; step <= 4; step++) {
    const encrypted = keys.encrypt('test', 'personal:alice', JSON.stringify({ step }));
    await append('onboarding.survey_step_saved', {
      schemaVersion: 1, memberId: 'alice', generation: 1, step, ...encrypted,
      ciphertextDigest: sha256Hex(Buffer.from(encrypted.ciphertext, 'base64')) }, `step-${step}`);
  }
}

async function loadsOnlyApprovedRevision() {
  expect(await read('alice', 'assistant')).toBeUndefined();
  await survey();
  await revision('Your name is Willow. Be warm and careful.', 1);
  expect(await read('alice', 'assistant')).toBeUndefined();
  await append('onboarding.persona_approved', {
    schemaVersion: 1, memberId: 'alice', generation: 1, revision: 1,
    revisionId: 'revision-1' }, 'approval');
  expect(await read('alice', 'assistant')).toBe('Your name is Willow. Be warm and careful.');
  await revision('Your name is an unapproved name.', 2);
  expect(await read('alice', 'assistant')).toBe('Your name is Willow. Be warm and careful.');
}
it('loads the approved onboarding persona, with a default until approval', loadsOnlyApprovedRevision);

async function keepsPersonaWithItsOwner() {
  await survey();
  await revision('Your name is Willow.', 1);
  await append('onboarding.persona_approved', {
    schemaVersion: 1, memberId: 'alice', generation: 1, revision: 1,
    revisionId: 'revision-1' }, 'approval');
  const other = envelope('test', 'assistant-other', 'assistant.created', {
    assistantId: 'other', ownerId: 'bob', kind: 'personal' });
  const shared = envelope('test', 'assistant-shared', 'assistant.created', {
    assistantId: 'shared', ownerId: 'team', kind: 'team' });
  await nats.seed([other, shared]);
  expect(await read('alice', 'other')).toBeUndefined();
  expect(await read('alice', 'shared')).toBeUndefined();
  const removed = envelope('test', 'member-alice', 'member.removed', {
    memberId: 'alice', removedBy: 'owner' });
  await nats.seed([removed]);
  await expect(read('alice', 'assistant')).rejects.toThrow();
}
it('keeps the persona with its owner and refuses a removed member', keepsPersonaWithItsOwner);
