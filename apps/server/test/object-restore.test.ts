import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { chmod, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { restoreEventBackup } from '../../../infra/package/event-restore.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import { restoreObjectBackup } from '../../../infra/package/object-restore.ts';
import { until } from '@opencrane/authz/testing';
import { stalledStorage } from './support/stalled-storage.ts';
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

function restoreMocks() {
  vi.restoreAllMocks();
}

function digest(bytes: Buffer | string) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function fixture(conflictingMime = false) {
  onTestFinished(restoreMocks);
  const target = await restoreStorage(onTestFinished);
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
  const second = { ...data, fileId: 'file-two',
    objectKey: `test/${conversationId}/file-two/${data.sha256}` };
  if (conflictingMime) Object.assign(second, data, { mime: 'image/png' });
  const duplicate = { ...uploaded, id: randomUUID(), commandId: randomUUID(), data: second };
  await events.connection.request(`ev.conversation.${conversationId}`, JSON.stringify(duplicate));
  await source.client.putObject('files', second.objectKey, bytes);
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
  const identity = digest(JSON.stringify(['test', conversationId, second.fileId]));
  return { target, restored, directory, options, restore, data, bytes, identity };
}

async function restoresCheckedBytes() {
  const setup = await fixture();
  const reads = vi.spyOn(setup.target.client, 'getObjectBounded');
  await setup.restore();
  expect(reads).toHaveBeenCalledTimes(2);
  const response = await setup.target.client.getObject('files', setup.data.objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid fixture response');
    chunks.push(chunk);
  }
  expect(Buffer.concat(chunks)).toEqual(setup.bytes);
  const metadata = await setup.target.client.statObject('files', setup.data.objectKey);
  expect(metadata.metaData['content-type']).toBe('text/plain');
  await expect(setup.restore()).rejects.toThrow('Object restore refused; keep target isolated');
  const encrypted = await readFile(join(setup.options.directory, setup.identity));
  expect(encrypted.includes(setup.bytes)).toBe(false);
}
it('restores checked bytes and MIME facts once into disposable MinIO', restoresCheckedBytes);

async function refusesConflictingEvents() {
  const setup = await fixture(true);
  await expect(setup.restore()).rejects.toThrow('Object restore refused; keep target isolated');
  expect(await setup.target.client.bucketExists('files')).toBe(false);
}
it('refuses conflicting upload MIME facts before creation', refusesConflictingEvents);

const privateFaults = ['missing', 'corrupt', 'symlink', 'mode', 'owner', 'directory-link',
  'escape', 'mixed-events', 'mixed-descriptor', 'attempt', 'silo', 'count', 'hash',
  'duplicate', 'missing-entry', 'key-link'] as const;
async function refusesPrivateFault(fault: typeof privateFaults[number]) {
  const setup = await fixture();
  const path = join(setup.options.directory, setup.identity);
  const descriptorPath = join(setup.options.directory, 'descriptor.json');
  const parsed: unknown = JSON.parse(await readFile(descriptorPath, 'utf8'));
  const saved = z.object({ silo: z.string(), attempt: z.string(),
    eventArchiveSha256: z.string(), eventDescriptorSha256: z.string(),
    objects: z.array(z.object({ identity: z.string(), byteCount: z.number(), sha256: z.string() })),
  }).passthrough().parse(parsed);
  if (fault === 'missing') await rm(path);
  if (fault === 'corrupt') await writeFile(path, 'private-corruption-canary');
  if (fault === 'mode') await chmod(path, 0o644);
  if (fault === 'symlink' || fault === 'key-link') {
    let original = path;
    if (fault === 'key-link') original = setup.options.backupKeyFile;
    await rename(original, `${original}-original`);
    await symlink(`${original}-original`, original);
  }
  if (fault === 'owner') {
    const execute = promisify(execFile);
    await execute('docker', ['run', '--rm', '--user', '0:0', '-v',
      `${setup.options.directory}:/fixture`, '--entrypoint', 'chown',
      'mirror.gcr.io/alpine/minio:RELEASE.2025-10-15T17-29-55Z@sha256:cf23643a6cf9ce159c57643ceb88279e431262282428c9e0bf3a7ef1a97e84b4',
      '65534', `/fixture/${setup.identity}`]);
  }
  if (fault === 'directory-link') {
    const link = join(setup.directory, 'linked');
    await symlink(setup.options.directory, link);
    setup.options.directory = link;
  }
  if (fault === 'escape') saved.objects[0]!.identity = '../key';
  if (fault === 'mixed-events') saved.eventArchiveSha256 = 'a'.repeat(64);
  if (fault === 'mixed-descriptor') saved.eventDescriptorSha256 = 'a'.repeat(64);
  if (fault === 'attempt') saved.attempt = 'foreign';
  if (fault === 'silo') saved.silo = 'foreign';
  if (fault === 'count') saved.objects[0]!.byteCount++;
  if (fault === 'hash') saved.objects[0]!.sha256 = 'a'.repeat(64);
  if (fault === 'duplicate') saved.objects.push({ ...saved.objects[0]! });
  if (fault === 'missing-entry') saved.objects.pop();
  await writeFile(descriptorPath, JSON.stringify(saved));
  await expect(setup.restore()).rejects.toEqual(
    new Error('Object restore refused; keep target isolated'));
  expect(await setup.target.client.bucketExists('files')).toBe(false);
}
it.each(privateFaults)('refuses %s before bucket creation', refusesPrivateFault, 60_000);

const targetFaults = ['source', 'existing', 'foreign', 'serving', 'shared', 'retained', 'race'];
async function refusesTarget(fault: string) {
  const setup = await fixture();
  let target = setup.target.client;
  if (fault === 'source') target = source.client;
  if (fault === 'foreign') setup.options.targetSilo = 'foreign';
  if (fault === 'serving') setup.options.stopped = false;
  if (fault === 'shared') setup.options.exclusive = false;
  if (fault === 'retained') setup.options.disposable = false;
  if (fault === 'existing') await target.makeBucket('files');
  if (fault === 'race') {
    async function racingCreator() {
      await target.makeBucket('files');
      return false;
    }
    vi.spyOn(target, 'bucketExists').mockImplementationOnce(racingCreator);
  }
  await expect(restoreObjectBackup(setup.restored.connection, source.client, target, setup.options))
    .rejects.toEqual(new Error('Object restore refused; keep target isolated'));
  const exists = ['source', 'existing', 'race'].includes(fault);
  expect(await target.bucketExists('files')).toBe(exists);
}
it.each(targetFaults)('refuses a %s target without deleting it', refusesTarget);

const transferFaults = ['denied', 'partial', 'lost', 'cancelled', 'timeout',
  'read-corrupt', 'read-truncated', 'read-mime', 'object-race'] as const;
async function leavesUncertainTarget(fault: typeof transferFaults[number]) {
  const setup = await fixture();
  const client = setup.target.client;
  const controller = new AbortController();
  const options = { ...setup.options, signal: controller.signal, timeoutMs: 2_000 };
  const put = client.putObject.bind(client);
  async function brokenWrite(...args: Parameters<typeof put>) {
    if (fault === 'denied') throw new Error('private-denial-canary');
    if (fault === 'partial') {
      await put('files', setup.data.objectKey, setup.bytes.subarray(0, 2));
      throw new Error('private-partial-canary');
    }
    if (fault === 'object-race') {
      await put('files', setup.data.objectKey, Buffer.from('competing-object'));
    }
    const result = await put(...args);
    if (fault === 'cancelled') controller.abort();
    if (fault === 'lost') throw new Error('private-completion-canary');
    if (fault === 'timeout') return new Promise<never>(neverCompletes);
    return result;
  }
  function neverCompletes() {
    // Model a lost completion after the storage server accepted the bytes.
  }
  const writes = vi.spyOn(client, 'putObject').mockImplementation(brokenWrite);
  const get = client.getObjectBounded.bind(client);
  const stat = client.statObject.bind(client);
  async function brokenMetadata(...args: Parameters<typeof stat>) {
    const result = await stat(...args);
    if (fault === 'read-mime') result.metaData['content-type'] = 'image/png';
    return result;
  }
  vi.spyOn(client, 'statObject').mockImplementation(brokenMetadata);
  async function brokenRead(...args: Parameters<typeof get>) {
    const response = await get(...args);
    if (fault === 'read-corrupt' || fault === 'read-truncated') {
      response.destroy();
      let bytes = Buffer.alloc(setup.bytes.length, 65);
      if (fault === 'read-truncated') bytes = setup.bytes.subarray(0, 2);
      return Object.assign(Readable.from([bytes]), { headers: { 'content-type': 'text/plain' } });
    }
    return response;
  }
  vi.spyOn(client, 'getObjectBounded').mockImplementation(brokenRead);
  await expect(restoreObjectBackup(setup.restored.connection, source.client, client, options))
    .rejects.toEqual(new Error('Object restore refused; keep target isolated'));
  expect(writes).toHaveBeenCalledTimes(1);
  expect(await client.bucketExists('files')).toBe(true);
  if (fault === 'object-race') {
    const metadata = await client.statObject('files', setup.data.objectKey);
    expect(metadata.size).toBe(16);
  }
  await expect(setup.restore()).rejects.toThrow('Object restore refused; keep target isolated');
  expect(writes).toHaveBeenCalledTimes(1);
}
it.each(transferFaults)('leaves %s transfer isolated without a resend', leavesUncertainTarget);

async function cancelsStorageWrites() {
  const target = await stalledStorage('headers');
  onTestFinished(target.close);
  const signal = AbortSignal.timeout(200);
  function write() {
    return target.client.putObject('files', 'private-address', Buffer.from('private-canary'));
  }
  await expect(target.client.withBounds({ signal, timeoutMs: 200 }, write)).rejects.toThrow();
  await until(target.closed, 1_000);
  expect(target.closed()).toBe(true);
  expect(target.requests()).toBe(2);
}
it('cancels the underlying write request before headers arrive', cancelsStorageWrites);

async function refusesSwappedDestination() {
  const setup = await fixture();
  const foreign = await restoreStorage(onTestFinished);
  await foreign.client.makeBucket('opencrane-restore');
  const marker = Buffer.from(JSON.stringify({ silo: 'another-silo' }));
  await foreign.client.putObject('opencrane-restore', 'owner', marker);
  await expect(restoreObjectBackup(setup.restored.connection, source.client,
    foreign.client, setup.options)).rejects.toThrow('Object restore refused; keep target isolated');
  expect(await foreign.client.bucketExists('files')).toBe(false);
  expect(await setup.target.client.bucketExists('files')).toBe(false);
}
it('refuses an endpoint and lease swap with unchanged declarations', refusesSwappedDestination);

async function refusesRunningProcess() {
  const setup = await fixture();
  const execute = promisify(execFile);
  await execute('docker', ['exec', '-d', setup.target.name, 'sleep', '300']);
  await expect(setup.restore()).rejects.toThrow('Object restore refused; keep target isolated');
  expect(await setup.target.client.bucketExists('files')).toBe(false);
}
it('checks that the destination has no other running process', refusesRunningProcess);
