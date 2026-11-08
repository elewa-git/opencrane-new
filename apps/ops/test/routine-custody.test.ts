import { afterEach, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { conversationKeys } from '@opencrane/projections';
import { loadRoutineCustody } from '../src/routine-custody.ts';

let directory: string;

async function fixture() {
  directory = await mkdtemp('/tmp/routine-custody-');
  const keyDirectory = `${directory}/conversation-keys`;
  const wrappingKeyFile = `${directory}/wrap-key`;
  await mkdir(keyDirectory);
  await writeFile(wrappingKeyFile, randomBytes(32), { mode: 0o600 });
  const writer = conversationKeys(keyDirectory, wrappingKeyFile);
  writer.provision('silo-a', 'routine-orders');
  writer.provision('silo-b', 'routine-orders');
  const privateText = 'private-routine-custody-canary';
  const encrypted = writer.encrypt('silo-a', 'routine-orders', privateText);
  const otherEncrypted = writer.encrypt('silo-b', 'routine-orders', privateText);
  return { keyDirectory, wrappingKeyFile, encrypted, otherEncrypted, privateText };
}

async function cleanup() {
  if (directory) await rm(directory, { recursive: true, force: true });
}
afterEach(cleanup);

async function readsSavedInputAfterRestart() {
  const saved = await fixture();
  const restarted = loadRoutineCustody('silo-a', saved.keyDirectory,
    saved.wrappingKeyFile);
  expect(restarted.decrypt('silo-a', 'routine-orders', saved.encrypted))
    .toBe(saved.privateText);
  const otherSilo = conversationKeys(saved.keyDirectory, saved.wrappingKeyFile);
  expect(otherSilo.decrypt('silo-b', 'routine-orders', saved.otherEncrypted))
    .toBe(saved.privateText);
  expect(() => restarted.provision('silo-b', 'routine-orders'))
    .toThrow(/^Routine custody unavailable$/u);
  expect(() => restarted.encrypt('silo-b', 'routine-orders', saved.privateText))
    .toThrow(/^Routine custody unavailable$/u);
  expect(() => restarted.decrypt('silo-b', 'routine-orders', saved.otherEncrypted))
    .toThrow(/^Routine custody unavailable$/u);
  expect(JSON.stringify(saved.encrypted)).not.toContain(saved.privateText);
}
it('reads saved encrypted input after restart only in its original silo',
  readsSavedInputAfterRestart);

async function refusesMissingMaterial() {
  const saved = await fixture();
  const invalidFile = `${directory}/invalid-wrap-key`;
  await writeFile(invalidFile, 'private-routine-custody-canary');
  for (const [keyDirectory, wrappingKeyFile] of [
    [undefined, saved.wrappingKeyFile],
    [`${directory}/missing`, saved.wrappingKeyFile],
    [saved.keyDirectory, `${directory}/missing-wrap-key`],
    [saved.keyDirectory, invalidFile],
    [saved.keyDirectory, undefined],
  ]) {
    expect(() => loadRoutineCustody('silo-a', keyDirectory, wrappingKeyFile))
      .toThrow(/^Routine custody unavailable$/u);
  }
  await chmod(saved.wrappingKeyFile, 0o000);
  expect(() => loadRoutineCustody('silo-a', saved.keyDirectory, saved.wrappingKeyFile))
    .toThrow(/^Routine custody unavailable$/u);
}
it('refuses absent directory and missing or unreadable wrapping material',
  refusesMissingMaterial);
