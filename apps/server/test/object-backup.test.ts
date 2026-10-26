import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import { uploadServices } from './support/upload-services.ts';

let services: Awaited<ReturnType<typeof uploadServices>>;
async function startServices() { services = await uploadServices(); }
async function stopServices() { await services.close(); }
beforeAll(startServices, 180_000);
afterAll(stopServices);

function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function fixture() {
  const source = await natsFixture();
  onTestFinished(source.close);
  const target = await natsFixture({ provision: false });
  onTestFinished(target.close);
  const directory = await mkdtemp(join(tmpdir(), 'object-backup-'));
  async function cleanDirectory() { await rm(directory, { recursive: true, force: true }); }
  onTestFinished(cleanDirectory);
  const archiveDirectory = join(directory, 'events');
  const destination = join(directory, 'objects');
  const conversationId = randomUUID();
  const bytes = Buffer.from('private-object-canary');
  const data = {
    conversationId, fileId: 'file-one', uploadedBy: 'member', name: 'private-name.txt',
    size: bytes.length, sha256: digest(bytes), mime: 'text/plain',
    objectKey: `test/${conversationId}/file-one/${digest(bytes)}`,
  };
  const uploaded = envelope('test', `conversation-${conversationId}`, 'file.uploaded', data);
  uploaded.principal = { id: 'member', kind: 'human' };
  expect(await source.store.append({ event: uploaded, expectedSequence: 0 }))
    .toMatchObject({ status: 'appended' });
  async function archive() {
    await collectEventBackup(source.connection,
      { silo: 'test', attempt: 'copy', destination: archiveDirectory });
  }
  const options = {
    directory: archiveDirectory, destination, silo: 'test', attempt: 'copy',
    writersStopped: true, disposable: true,
  };
  async function capture() {
    await collectObjectBackup(source.connection, target.connection, services.objects, options);
  }
  return { source, target, directory, destination, data, bytes, archive, options, capture };
}

async function refusesMissingObject() {
  const setup = await fixture();
  await setup.archive();
  await expect(setup.capture()).rejects.toEqual(new Error('Object backup refused'));
  expect(await readdir(setup.directory)).toEqual(['events']);
}
it('refuses completion when an archived upload has no object', refusesMissingObject);
