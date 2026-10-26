import { createDecipheriv, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { collectComputerVolumeExport } from '../../../infra/package/computer-volume-export.ts';
import { event, natsFixture } from './testing.ts';

vi.mock('node:fs', { spy: true });
const canary = 'private-home-canary';
const bytes = Buffer.concat([Buffer.from(canary), Buffer.from([0, 255, 128, 10])]);
const key = Buffer.alloc(32, 71);
function digest(input: Buffer) {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest('hex');
}
async function fixture(fault = '') {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'home-export-'));
  async function close() {
    vi.restoreAllMocks();
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
  let opened = false;
  async function read(request: { resource: string }) {
    if (opened && request.resource === 'namespace') {
      if (fault === 'late-namespace') namespace.metadata.uid = 'changed';
      if (fault === 'late-sandbox') sandbox.metadata.uid = 'changed';
      if (fault === 'late-generation') sandbox.metadata.generation++;
      if (fault === 'late-home') home.metadata.uid = 'changed';
      if (fault === 'late-volume') volume.metadata.uid = 'changed';
      if (fault === 'late-binding') volume.spec.claimRef.uid = 'changed';
      if (fault === 'resume') sandbox.spec.operatingMode = 'Running';
      if (fault === 'late-writer') options.writersStopped = false;
      if (fault === 'late-archive') {
        await writeFile(join(archive, 'events.snapshot'), canary);
      }
      if (fault === 'late-attempt') {
        const path = join(archive, 'descriptor.json');
        const text = await readFile(path, 'utf8');
        await writeFile(path, text.replace('"attempt":"copy"', '"attempt":"other"'));
      }
    }
    return JSON.stringify(resources[request.resource]);
  }
  function cancel() { controller.abort(new Error(canary)); }
  function idle() {
    if (fault === 'cancel-active') setImmediate(cancel);
  }
  let stream = Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]);
  if (fault === 'truncated') stream = Readable.from([bytes.subarray(0, -1)]);
  if (fault === 'overflow') stream = Readable.from([bytes, bytes]);
  if (fault === 'checksum') stream = Readable.from([Buffer.alloc(bytes.length)]);
  if (['stall', 'cancel', 'cancel-active'].includes(fault)) stream = new Readable({ read: idle });
  const controller = new AbortController();
  function readExport() {
    opened = true;
    if (fault === 'missing') throw new Error(canary);
    if (fault === 'cancel') controller.abort(new Error(canary));
    const byteCount = fault === 'size-limit' ? 64 * 1024 * 1024 + 1 : bytes.length;
    return Promise.resolve({ stream, byteCount, sha256: digest(bytes) });
  }
  async function collect() {
    const settings = Object.assign(options, { signal: controller.signal });
    return collectComputerVolumeExport(source.connection, target.connection, settings, readExport, read);
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

it('authenticates ownership, generation, archive, attempt, count and hash independently',
  async function () {
    const setup = await fixture();
    const result = await setup.collect();
    const saved = await readFile(join(setup.options.destination, 'home.enc'));
    const changes = [
      ['silo'], ['attempt'], ['eventArchiveSha256'], ['eventDescriptorSha256'],
      ['namespace', 'uid'], ['namespace', 'name'], ['namespace', 'resourceVersion'],
      ['volumes', '0', 'generation'], ['volumes', '0', 'assistantId'],
      ['volumes', '0', 'computerId'],
    ];
    for (const resource of ['sandbox', 'home', 'volume']) {
      for (const field of ['uid', 'name', 'resourceVersion']) {
        changes.push(['volumes', '0', resource, field]);
      }
    }
    for (const path of changes) {
      const binding = structuredClone(result.binding);
      let object: object = binding;
      for (const field of path.slice(0, -1)) {
        const next: unknown = Reflect.get(object, field);
        if (!next || typeof next !== 'object') throw new Error('Invalid fixture');
        object = next;
      }
      Reflect.set(object, path.at(-1)!, 'changed');
      function changed() { return decrypt(saved, [binding, bytes.length, digest(bytes)]); }
      expect(changed).toThrow();
    }
    function wrongCount() { return decrypt(saved, [result.binding, 1, result.sha256]); }
    function wrongHash() { return decrypt(saved, [result.binding, bytes.length, 'a'.repeat(64)]); }
    function wrongKey() {
      return decrypt(saved, [result.binding, bytes.length, result.sha256], Buffer.alloc(32, 72));
    }
    const other = await fixture();
    other.options.attempt = 'other';
    const descriptorPath = join(other.options.directory, 'descriptor.json');
    const descriptor = await readFile(descriptorPath, 'utf8');
    await writeFile(descriptorPath, descriptor.replace('"attempt":"copy"', '"attempt":"other"'));
    const otherResult = await other.collect();
    function swapped() { return decrypt(saved, [otherResult.binding, bytes.length, result.sha256]); }
    for (const refuses of [wrongCount, wrongHash, wrongKey, swapped]) expect(refuses).toThrow();
  });

const faults = ['missing', 'truncated', 'overflow', 'checksum', 'stall', 'cancel', 'cancel-active',
  'late-namespace', 'late-sandbox', 'late-generation', 'late-home', 'late-volume',
  'late-binding', 'resume', 'late-writer', 'late-archive', 'late-attempt',
  'key', 'key-link', 'foreign-output', 'output-link', 'existing', 'disk-write', 'disk-flush',
  'attempt', 'silo', 'active-writer', 'size-limit', 'timeout-limit'];
async function refusesFault(fault: string) {
  const setup = await fixture(fault);
  const options = setup.options;
  if (fault === 'stall') Object.assign(options, { timeoutMs: 1_000 });
  if (fault === 'timeout-limit') Object.assign(options, { timeoutMs: 60_001 });
  if (fault === 'attempt') options.attempt = 'other';
  if (fault === 'silo') options.silo = 'other';
  if (fault === 'active-writer') options.writersStopped = false;
  if (fault === 'key') await writeFile(options.backupKeyFile, canary);
  if (fault === 'key-link') {
    const link = `${options.backupKeyFile}-link`;
    await symlink(options.backupKeyFile, link);
    options.backupKeyFile = link;
  }
  const foreign = join(options.directory, 'foreign');
  if (fault === 'output-link' || fault === 'foreign-output' || fault === 'existing') {
    await mkdir(foreign, { mode: 0o700 });
    await writeFile(join(foreign, 'keep'), canary);
    if (fault === 'output-link') await symlink(foreign, options.destination);
    if (fault === 'foreign-output') {
      await chmod(foreign, 0o755);
      options.destination = join(foreign, 'export');
    }
    if (fault === 'existing') options.destination = foreign;
  }
  function diskFailure() { throw new Error(canary); }
  if (fault === 'disk-write') vi.spyOn(fs, 'writeSync').mockImplementation(diskFailure);
  if (fault === 'disk-flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(diskFailure);
  const logs = vi.spyOn(console, 'log');
  const errors = vi.spyOn(console, 'error');
  const started = performance.now();
  await expect(setup.collect()).rejects.toEqual(new Error('Computer volume export refused'));
  expect(logs).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(fs.existsSync(join(options.destination, 'descriptor.json'))).toBe(false);
  if (['stall', 'cancel', 'cancel-active'].includes(fault)) {
    expect(setup.stream.destroyed).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  }
  if (fs.existsSync(foreign)) expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe(canary);
}
it.each(faults)('withholds completion and private diagnostics: %s', refusesFault);
