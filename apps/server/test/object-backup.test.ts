import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { AssumeRoleProvider } from 'minio/dist/esm/AssumeRoleProvider.mjs';
import { storageClient } from '../src/files/storage.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { readBackupObject } from '../../../infra/package/event-restore.ts';
import { stalledStorage } from './support/stalled-storage.ts';
import { collectObjectBackup } from '../../../infra/package/object-backup.ts';
import { uploadServices } from './support/upload-services.ts';

let services: Awaited<ReturnType<typeof uploadServices>>;
async function startServices() {
  services = await uploadServices();
}
async function stopServices() {
  await services.close();
}
beforeAll(startServices, 180_000);
afterAll(stopServices);

function digest(bytes: Buffer) {
  const hash = createHash('sha256');
  hash.update(bytes);
  return hash.digest('hex');
}

async function fixture(fault = '') {
  const source = await natsFixture();
  onTestFinished(source.close);
  const target = await natsFixture({ provision: false });
  onTestFinished(target.close);
  const directory = await mkdtemp(join(tmpdir(), 'object-backup-'));
  async function cleanDirectory() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(cleanDirectory);
  const backupKeyFile = join(directory, 'backup-key');
  await writeFile(backupKeyFile, randomBytes(32), { mode: 0o600 });
  const archiveDirectory = join(directory, 'events');
  const destination = join(directory, 'objects');
  const conversationId = randomUUID();
  const bytes = Buffer.from('private-object-canary');
  const data = {
    conversationId, fileId: 'file-one', uploadedBy: 'member', name: 'private-name.txt',
    size: bytes.length, sha256: digest(bytes), mime: 'text/plain',
    objectKey: `test/${conversationId}/file-one/${digest(bytes)}`,
  };
  if (fault === 'foreign-address') data.objectKey = 'foreign/conversation/file/hash';
  if (fault === 'wrong-count') data.size++;
  if (fault === 'wrong-hash') data.sha256 = 'a'.repeat(64);
  if (fault === 'wrong-hash') {
    data.objectKey = `test/${conversationId}/file-one/${data.sha256}`;
  }
  const uploaded = envelope('test', `conversation-${conversationId}`, 'file.uploaded', data);
  uploaded.principal = { id: 'member', kind: 'human' };
  if (fault === 'foreign-subject') uploaded.subject = 'conversation-foreign';
  const published = await source.connection.request(
    `ev.conversation.${uploaded.subject.slice('conversation-'.length)}`, JSON.stringify(uploaded));
  expect(published.json<{ seq: number }>().seq).toBe(1);
  async function archive() {
    await collectEventBackup(source.connection,
      { silo: 'test', attempt: 'copy', destination: archiveDirectory });
  }
  const options = {
    directory: archiveDirectory, destination, silo: 'test', attempt: 'copy',
    writersStopped: true, disposable: true, backupKeyFile,
  };
  function restoreMocks() {
    vi.restoreAllMocks();
  }
  onTestFinished(restoreMocks);
  async function capture() {
    await collectObjectBackup(source.connection, target.connection, services.objects, options);
  }
  return { source, target, directory, destination, data, uploaded, bytes, archive, options, capture };
}

async function refusesMissingObject() {
  const setup = await fixture();
  await setup.archive();
  await expect(setup.capture()).rejects.toEqual(new Error('Object backup refused'));
  expect(await readdir(setup.directory)).toEqual(['backup-key', 'events']);
}
it('refuses completion when an archived upload has no object', refusesMissingObject);

const objectDescriptor = z.object({
  silo: z.string(), attempt: z.string(), eventArchiveSha256: z.string(),
  eventDescriptorSha256: z.string(),
  objects: z.array(z.object({ identity: z.string(), byteCount: z.number(), sha256: z.string() })),
});

async function savesReferencedBytes() {
  const setup = await fixture();
  const expected = new Map<string, Buffer>();
  for (let index = 0; index < 3; index++) {
    let bytes = Buffer.from(`private bytes ${index}`);
    if (index === 2) {
      bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAA' +
        'AAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64');
    }
    let conversationId: string = setup.data.conversationId;
    if (index === 2) conversationId = 'second-conversation';
    const fileId = `file-${index}`;
    const data = { ...setup.data, conversationId, fileId, size: bytes.length,
      sha256: digest(bytes), objectKey: `test/${conversationId}/${fileId}/${digest(bytes)}` };
    const screenshot = { computerId: 'computer', generation: 1,
      capturedAt: '2026-10-01T00:00:00Z', width: 1, height: 1 };
    let uploadData: object = data;
    if (index === 2) uploadData = { ...data, mime: 'image/png', screenshot };
    const uploaded = envelope('test', `conversation-${conversationId}`, 'file.uploaded', uploadData);
    uploaded.principal = { id: 'member', kind: 'human' };
    await setup.source.connection.request(`ev.conversation.${conversationId}`,
      JSON.stringify(uploaded));
    await services.objects.putObject('files', data.objectKey, bytes);
    expected.set(digest(bytes), bytes);
  }
  await services.objects.putObject('files', setup.data.objectKey, setup.bytes);
  expected.set(digest(setup.bytes), setup.bytes);
  const delivered = envelope('test', `conversation-${setup.data.conversationId}`, 'file.delivered', {
    conversationId: setup.data.conversationId, fileId: setup.data.fileId,
    computerId: 'computer', sha256: setup.data.sha256,
  });
  await setup.source.connection.request(`ev.conversation.${setup.data.conversationId}`,
    JSON.stringify(delivered));
  const duplicate = { ...setup.uploaded, id: randomUUID(), commandId: randomUUID() };
  await setup.source.connection.request(`ev.conversation.${setup.data.conversationId}`,
    JSON.stringify(duplicate));
  await services.objects.putObject('files', 'unreferenced-garbage', Buffer.from('ignored'));
  await setup.archive();
  await setup.capture();
  const description = await readFile(join(setup.destination, 'descriptor.json'));
  const descriptor = objectDescriptor.parse(JSON.parse(description.toString()));
  expect(descriptor).toMatchObject({ silo: 'test', attempt: 'copy' });
  expect(descriptor.eventArchiveSha256)
    .toBe(digest(await readFile(join(setup.options.directory, 'events.snapshot'))));
  expect(descriptor.eventDescriptorSha256)
    .toBe(digest(await readFile(join(setup.options.directory, 'descriptor.json'))));
  expect(descriptor.objects).toHaveLength(4);
  const nonces = new Set<string>();
  for (const entry of descriptor.objects) {
    expect(entry.identity).toMatch(/^[a-f0-9]{64}$/);
    const bytes = await readFile(join(setup.destination, entry.identity));
    nonces.add(bytes.subarray(0, 12).toString('hex'));
    expect(bytes).not.toEqual(expected.get(entry.sha256));
    expect(bytes.includes(expected.get(entry.sha256)!)).toBe(false);
    expect(bytes.length).toBe(entry.byteCount + 28);
    expect(readBackupObject(setup.destination, setup.options.backupKeyFile, entry))
      .toEqual(expected.get(entry.sha256));
  }
  expect(nonces.size).toBe(4);
  expect(description.toString()).not.toContain(setup.options.backupKeyFile);
  expect(description.toString()).not.toMatch(/private|conversation|objectKey|screenshot/);
  expect((await stat(setup.destination)).mode & 0o777).toBe(0o700);
  for (const name of await readdir(setup.destination)) {
    expect((await stat(join(setup.destination, name))).mode & 0o777).toBe(0o600);
  }
  expect(await readdir(setup.destination)).toHaveLength(5);
}
it('keeps delivered files, two conversations and a screenshot, without garbage', savesReferencedBytes);

const faults = ['denied', 'truncated', 'changed-bytes', 'wrong-count', 'wrong-hash',
  'foreign-address', 'foreign-subject', 'duplicate', 'mixed-attempt', 'changed-log',
  'changed-archive', 'corrupt-archive', 'cancelled', 'late-error', 'timeout', 'active-writers',
  'object-limit', 'byte-limit', 'oversize-limit', 'overlong-limit', 'over-object-limit',
  'wrong-silo'] as const;
async function refusesFault(fault: typeof faults[number]) {
  const setup = await fixture(fault);
  await services.objects.putObject('files', setup.data.objectKey, setup.bytes);
  if (fault === 'duplicate' || fault === 'object-limit') {
    const data = { ...setup.data, size: setup.data.size + 1 };
    if (fault === 'object-limit') {
      data.size = setup.bytes.length;
      data.fileId = 'second';
      data.objectKey = `test/${data.conversationId}/second/${data.sha256}`;
      await services.objects.putObject('files', data.objectKey, setup.bytes);
    }
    const duplicate = { ...setup.uploaded, id: randomUUID(), commandId: randomUUID(), data };
    await setup.source.connection.request(`ev.conversation.${data.conversationId}`,
      JSON.stringify(duplicate));
  }
  await setup.archive();
  const controller = new AbortController();
  const options = { ...setup.options, signal: controller.signal };
  if (fault === 'mixed-attempt') options.attempt = 'different';
  if (fault === 'wrong-silo') options.silo = 'foreign';
  if (fault === 'active-writers') options.writersStopped = false;
  if (fault === 'corrupt-archive') {
    await writeFile(join(options.directory, 'events.snapshot'), 'private corruption');
  }
  let objects = services.objects;
  if (fault === 'denied') {
    const signed = await services.client.presignedGetObject('files', setup.data.objectKey);
    const endpoint = new URL(signed).origin;
    const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow',
      Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::files/another-object'] }] };
    const provider = new AssumeRoleProvider({ stsEndpoint: endpoint, accessKey: 'upload-test',
      secretKey: 'disposable-upload-test', durationSeconds: 900, policy: JSON.stringify(policy) });
    const lease = await provider.getCredentials();
    const leaseFile = join(setup.directory, 'lease');
    await writeFile(leaseFile, JSON.stringify({ ...lease, expiresAt: Date.now() + 840_000 }),
      { mode: 0o600 });
    objects = storageClient(endpoint, leaseFile);
  }
  if (fault === 'truncated' || fault === 'changed-bytes') {
    let bytes = Buffer.alloc(setup.bytes.length, 65);
    if (fault === 'truncated') bytes = setup.bytes.subarray(0, -1);
    await services.objects.putObject('files', setup.data.objectKey, bytes);
  }
  const getObject = objects.getObject.bind(objects);
  async function intercept(bucket: string, address: string) {
    const response = await getObject(bucket, address);
    if (fault === 'changed-log') {
      const added = { ...setup.uploaded, id: randomUUID(), commandId: randomUUID() };
      await setup.source.connection.request(`ev.conversation.${setup.data.conversationId}`,
        JSON.stringify(added));
    }
    if (fault === 'changed-archive') {
      await writeFile(join(options.directory, 'events.snapshot'), 'private corruption');
    }
    if (fault === 'cancelled') controller.abort();
    if (fault === 'late-error' || fault === 'timeout') {
      response.destroy();
      async function* interrupted() {
        yield setup.bytes;
        function pause(resolve: () => void) { setTimeout(resolve, 500); }
        if (fault === 'timeout') await new Promise<void>(pause);
        throw new Error('private diagnostic, private-name.txt, private-object-canary');
      }
      return Readable.from(interrupted());
    }
    return response;
  }
  const download = vi.spyOn(objects, 'getObject').mockImplementation(intercept);
  let maxObjects = 1_000;
  let maxBytes = 64 * 1024 * 1024;
  let timeoutMs = 60_000;
  if (fault === 'object-limit') maxObjects = 1;
  if (fault === 'over-object-limit') maxObjects++;
  if (fault === 'byte-limit') maxBytes = 1;
  if (fault === 'oversize-limit') maxBytes++;
  if (fault === 'overlong-limit') timeoutMs++;
  if (fault === 'timeout') timeoutMs = 300;
  const limits = { ...options, maxObjects, maxBytes, timeoutMs };
  await expect(collectObjectBackup(setup.source.connection, setup.target.connection,
    objects, limits)).rejects.toEqual(new Error('Object backup refused'));
  if (fault === 'late-error' || fault === 'timeout') expect(download).toHaveBeenCalled();
  if (fault === 'denied') await rm(join(setup.directory, 'lease'));
  expect(await readdir(setup.directory)).toEqual(['backup-key', 'events']);
}
it.each(faults)('refuses %s without publishing a descriptor', refusesFault);

const destinations = ['existing', 'symlink', 'unsafe-parent', 'relative', 'ancestor-symlink'] as const;
async function refusesDestination(fault: typeof destinations[number]) {
  const setup = await fixture();
  await setup.archive();
  const sentinel = join(setup.directory, 'keep');
  await writeFile(sentinel, 'keep');
  if (fault === 'existing') await writeFile(setup.destination, 'keep');
  if (fault === 'symlink') await symlink(sentinel, setup.destination);
  if (fault === 'unsafe-parent') await chmod(setup.directory, 0o755);
  if (fault === 'relative') setup.options.destination = 'unsafe-relative-output';
  if (fault === 'ancestor-symlink') {
    const alias = join(setup.directory, 'alias');
    await symlink(setup.directory, alias);
    setup.options.destination = join(alias, 'output');
  }
  await expect(setup.capture()).rejects.toEqual(new Error('Object backup refused'));
  expect(await readFile(sentinel, 'utf8')).toBe('keep');
  if (fault === 'existing' || fault === 'symlink') {
    expect(await readFile(setup.destination, 'utf8')).toBe('keep');
  }
}
it.each(destinations)('preserves foreign output at a %s destination', refusesDestination);

const keyFaults = ['missing', 'public', 'short', 'long', 'symlink'] as const;
async function refusesKey(fault: typeof keyFaults[number]) {
  const setup = await fixture();
  await services.objects.putObject('files', setup.data.objectKey, setup.bytes);
  await setup.archive();
  const keyFile = setup.options.backupKeyFile;
  if (fault === 'missing') await rm(keyFile);
  if (fault === 'public') await chmod(keyFile, 0o644);
  if (fault === 'short') await writeFile(keyFile, randomBytes(31));
  if (fault === 'long') await writeFile(keyFile, randomBytes(33));
  if (fault === 'symlink') {
    setup.options.backupKeyFile = join(setup.directory, 'alias');
    await symlink(keyFile, setup.options.backupKeyFile);
  }
  await expect(setup.capture()).rejects.toEqual(new Error('Object backup refused'));
  await expect(stat(setup.destination)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(keyFaults)('refuses a %s backup key before capture', refusesKey);

const encryptedFaults = ['ciphertext', 'nonce', 'tag', 'identity', 'hash', 'key'] as const;
async function refusesEncryptedChange(fault: typeof encryptedFaults[number]) {
  const setup = await fixture();
  await services.objects.putObject('files', setup.data.objectKey, setup.bytes);
  await setup.archive();
  await setup.capture();
  const description = await readFile(join(setup.destination, 'descriptor.json'), 'utf8');
  const descriptor = objectDescriptor.parse(JSON.parse(description));
  const entry = descriptor.objects[0]!;
  const file = join(setup.destination, entry.identity);
  const bytes = await readFile(file);
  let offset = 12;
  if (fault === 'nonce') offset = 0;
  if (fault === 'tag') offset = bytes.length - 1;
  if (fault === 'ciphertext' || fault === 'nonce' || fault === 'tag') {
    bytes[offset] = bytes[offset]! ^ 1;
    await writeFile(file, bytes);
  }
  if (fault === 'identity') {
    entry.identity = 'b'.repeat(64);
    await writeFile(join(setup.destination, entry.identity), bytes, { mode: 0o600 });
  }
  if (fault === 'hash') entry.sha256 = 'b'.repeat(64);
  if (fault === 'key') await writeFile(setup.options.backupKeyFile, randomBytes(32));
  function restore() {
    return readBackupObject(setup.destination, setup.options.backupKeyFile, entry);
  }
  expect(restore).toThrow('Object restore refused');
}
it.each(encryptedFaults)('refuses changed encrypted %s without returning bytes',
  refusesEncryptedChange);

const transportFaults = ['headers', 'error-large', 'error-endless', 'region-large',
  'region-endless'] as const;
async function closesFailedRequest(fault: typeof transportFaults[number]) {
  const setup = await fixture();
  await setup.archive();
  const storage = await stalledStorage(fault);
  onTestFinished(storage.close);
  const options = { ...setup.options, timeoutMs: 1_000 };
  await expect(collectObjectBackup(setup.source.connection, setup.target.connection,
    storage.client, options)).rejects.toEqual(new Error('Object backup refused'));
  await expect.poll(storage.closed, { timeout: 500 }).toBe(true);
  expect(storage.requests()).toBeGreaterThan(0);
  await expect(stat(setup.destination)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(transportFaults)('closes %s requests and removes incomplete output', closesFailedRequest);
