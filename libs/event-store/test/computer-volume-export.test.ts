import { createDecipheriv, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, onTestFinished } from 'vitest';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { collectComputerVolumeExport } from '../../../infra/package/computer-volume-export.ts';
import { event, natsFixture } from './testing.ts';

const canary = 'private-home-canary';
const bytes = Buffer.concat([Buffer.from(canary), Buffer.from([0, 255, 128, 10])]);
const key = Buffer.alloc(32, 71);
function digest(input: Buffer) {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest('hex');
}
async function fixture() {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'home-export-'));
  async function close() {
    await source.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  const identity = { assistantId: 'assistant-one', computerId: 'computer-one', generation: 1 };
  const records = [
    { type: 'assistant.created', subject: 'assistant-assistant-one',
      data: { assistantId: 'assistant-one', ownerId: 'alice', kind: 'personal' } },
    { type: 'computer.claimed', subject: 'computer-assistant-one',
      data: { ...identity, tokenId: 'token:one' } },
    { type: 'computer.ready', subject: 'computer-assistant-one',
      data: { ...identity, sandboxUid: 'sandbox-uid' } },
  ];
  for (const record of records) {
    const previous = await source.store.head(record.subject);
    const envelope = { ...event(record.type, record.subject, record.type), data: record.data };
    await source.store.append({ event: envelope, expectedSequence: previous });
  }
  const archive = join(directory, 'events');
  await collectEventBackup(source.connection, { silo: 'test', attempt: 'copy', destination: archive });
  const options = { directory: archive, silo: 'test', attempt: 'copy', disposable: true,
    namespace: 'owned', namespaceUid: 'namespace-uid', kubeconfig: '/private/config',
    context: 'owned', backupKeyFile: join(directory, canary),
    destination: join(directory, 'export'), writersStopped: true };
  await writeFile(options.backupKeyFile, key, { mode: 0o600 });
  const namespace = { kind: 'Namespace', metadata: {
    name: 'owned', uid: 'namespace-uid', resourceVersion: '10' } };
  const labels = { 'sandbox.users.io/computer': 'computer-one',
    'sandbox.users.io/assistant': 'assistant-one' };
  const sandbox = { kind: 'Sandbox', metadata: { name: 'computer-one', uid: 'sandbox-uid',
    namespace: 'owned', generation: 3, resourceVersion: '11' },
    spec: { operatingMode: 'Suspended', podTemplate: { metadata: { labels } } },
    status: { conditions: [{ type: 'Suspended', status: 'True', reason: 'PodTerminated',
      observedGeneration: 3 }] } };
  const home = { kind: 'PersistentVolumeClaim', metadata: { name: 'home-computer-one',
    namespace: 'owned', uid: 'home-uid', resourceVersion: '12', labels,
    ownerReferences: [{ kind: 'Sandbox', name: 'computer-one', uid: 'sandbox-uid',
      controller: true }] }, spec: { volumeName: 'volume-one' }, status: { phase: 'Bound' } };
  const volume = { kind: 'PersistentVolume', metadata: {
    name: 'volume-one', uid: 'volume-uid', resourceVersion: '13' },
    spec: { claimRef: { namespace: 'owned', name: 'home-computer-one', uid: 'home-uid' } },
    status: { phase: 'Bound' } };
  const resources: Record<string, object> = { namespace, persistentvolumes: volume,
    sandboxes: { metadata: { resourceVersion: '10' }, items: [sandbox] },
    persistentvolumeclaims: { metadata: { resourceVersion: '10' }, items: [home] },
    pods: { metadata: { resourceVersion: '10' }, items: [] } };
  async function read(request: { resource: string }) {
    return JSON.stringify(resources[request.resource]);
  }
  const stream = Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]);
  async function readExport() {
    return { stream, byteCount: bytes.length, sha256: digest(bytes) };
  }
  async function collect() {
    return collectComputerVolumeExport(source.connection, target.connection, options, readExport, read);
  }
  return { options, collect, stream, resources, namespace, sandbox, home, volume };
}
function decrypt(saved: Buffer, associated: unknown, material = key) {
  const decipher = createDecipheriv('aes-256-gcm', material, saved.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify(associated)));
  decipher.setAuthTag(saved.subarray(-16));
  return Buffer.concat([decipher.update(saved.subarray(12, -16)), decipher.final()]);
}

it('encrypts one checked home and independently recovers every byte', async function () {
  const setup = await fixture();
  const result = await setup.collect();
  expect(result.kind).toBe('volume-export-only');
  expect(result.byteCount).toBe(bytes.length);
  expect(result.sha256).toBe(digest(bytes));
  expect(result.binding.volumes[0]).toMatchObject({ generation: 1,
    sandbox: { uid: 'sandbox-uid' }, home: { uid: 'home-uid' }, volume: { uid: 'volume-uid' } });
  const saved = await readFile(join(setup.options.destination, 'home.enc'));
  expect(saved.includes(bytes)).toBe(false);
  expect(decrypt(saved, [result.binding, bytes.length, digest(bytes)])).toEqual(bytes);
  const descriptor = await readFile(join(setup.options.destination, 'descriptor.json'), 'utf8');
  expect(JSON.parse(descriptor)).toEqual(result);
  expect(descriptor).not.toContain(canary);
  expect(descriptor).not.toContain(setup.options.backupKeyFile);
  expect(descriptor).not.toContain(key.toString('hex'));
  expect(setup.stream.destroyed).toBe(true);
});
