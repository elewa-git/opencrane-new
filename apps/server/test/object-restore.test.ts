import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, onTestFinished } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { restoreEventBackup } from '../../../infra/package/event-restore.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import { restoreObjectBackup } from '../../../infra/package/object-restore.ts';
import { restoreStorage } from './support/restore-storage.ts';

let source: Awaited<ReturnType<typeof restoreStorage>>;
async function start() {
  source = await restoreStorage();
  await source.client.makeBucket('files');
}
async function stop() {
  await source.close();
}
beforeAll(start, 120_000);
afterAll(stop);

function digest(bytes: Buffer | string) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function fixture() {
  const target = await restoreStorage();
  onTestFinished(target.close);
  const events = await natsFixture();
  onTestFinished(events.close);
  const copied = await natsFixture({ provision: false });
  onTestFinished(copied.close);
  const restored = await natsFixture({ provision: false });
  onTestFinished(restored.close);
  const directory = await mkdtemp(join(tmpdir(), 'object-restore-'));
  async function clean() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(clean);
  const backupKeyFile = join(directory, 'key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  const eventDirectory = join(directory, 'events');
  const objectDirectory = join(directory, 'objects');
  const conversationId = randomUUID();
  const bytes = Buffer.from('private-restore-canary');
  const data = { conversationId, fileId: 'file-one', uploadedBy: 'member',
    name: 'private-name.txt', size: bytes.length, sha256: digest(bytes), mime: 'text/plain',
    objectKey: `test/${conversationId}/file-one/${digest(bytes)}` };
  const uploaded = envelope('test', `conversation-${conversationId}`, 'file.uploaded', data);
  uploaded.principal = { id: 'member', kind: 'human' };
  await events.connection.request(`ev.conversation.${conversationId}`, JSON.stringify(uploaded));
  await source.client.putObject('files', data.objectKey, bytes);
  await collectEventBackup(events.connection,
    { silo: 'test', attempt: 'copy', destination: eventDirectory });
  await collectObjectBackup(events.connection, copied.connection, source.client, {
    directory: eventDirectory, destination: objectDirectory, silo: 'test', attempt: 'copy',
    writersStopped: true, disposable: true, backupKeyFile,
  });
  const proof = await restoreEventBackup(events.connection, restored.connection,
    { directory: eventDirectory, silo: 'test', disposable: true });
  const options = { directory: objectDirectory, eventDirectory, backupKeyFile,
    silo: 'test', attempt: 'copy', targetSilo: 'test', stopped: true, exclusive: true,
    disposable: true, proof };
  async function restore() {
    await restoreObjectBackup(restored.connection, source.client, target.client, options);
  }
  const identity = digest(JSON.stringify(['test', conversationId, data.fileId]));
  return { target, restored, directory, options, restore, data, bytes, identity };
}

async function restoresCheckedBytes() {
  const setup = await fixture();
  await setup.restore();
  const response = await setup.target.client.getObject('files', setup.data.objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  expect(Buffer.concat(chunks)).toEqual(setup.bytes);
  const metadata = await setup.target.client.statObject('files', setup.data.objectKey);
  expect(metadata.metaData['content-type']).toBe('text/plain');
  await expect(setup.restore()).rejects.toThrow('Object restore refused; keep target isolated');
  const encrypted = await readFile(join(setup.options.directory, setup.identity));
  expect(encrypted.includes(setup.bytes)).toBe(false);
}
it('restores checked bytes and MIME facts once into disposable MinIO', restoresCheckedBytes);
