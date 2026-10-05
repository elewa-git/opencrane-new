import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { providerSecrets } from '../src/index.ts';

async function recordedFilesystem() {
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises');
  const recordedWrite = vi.fn(filesystem.writeFile);
  const recorded = { ...filesystem, writeFile: recordedWrite };
  return recorded;
}
vi.mock('node:fs/promises', recordedFilesystem);

async function keepsFirstSecretWithoutComparing() {
  const directory = await mkdtemp(`${tmpdir()}/provider-secret-retry-`);
  const secrets = providerSecrets(directory);
  const reference = `secret:provider-${'a'.repeat(64)}`;
  try {
    await secrets.save(reference, 'fixture-first');
    await expect(secrets.save(reference, 'fixture-retry')).resolves.toBeUndefined();
    expect(await secrets.read(reference)).toBe('fixture-first');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it('the first exclusive secret write survives a retry with different transient input',
  keepsFirstSecretWithoutComparing);

async function onlyAcceptsCompleteSecrets() {
  const directory = await mkdtemp(`${tmpdir()}/provider-secret-publication-`);
  const secrets = providerSecrets(directory);
  const reference = `secret:provider-${'b'.repeat(64)}`;
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises');
  const opened = Promise.withResolvers<void>();
  const finishWrite = Promise.withResolvers<void>();
  async function writeInParts(...parameters: Parameters<typeof writeFile>) {
    const [filename, , options] = parameters;
    await filesystem.writeFile(filename, '', options);
    opened.resolve();
    await finishWrite.promise;
    await filesystem.writeFile(filename, 'fixture-first', { flag: 'a' });
  }
  const writer = vi.mocked(writeFile);
  writer.mockImplementationOnce(writeInParts);
  const firstSave = secrets.save(reference, 'fixture-first');
  try {
    await opened.promise;
    await secrets.save(reference, 'fixture-retry');
    expect(await secrets.read(reference)).toBe('fixture-retry');
    finishWrite.resolve();
    await firstSave;
    expect(await secrets.read(reference)).toBe('fixture-retry');
  } finally {
    finishWrite.resolve();
    await firstSave;
    writer.mockReset();
    writer.mockImplementation(filesystem.writeFile);
    await rm(directory, { recursive: true, force: true });
  }
}
it('a retry publishes a complete secret while another write is still incomplete',
  onlyAcceptsCompleteSecrets);
