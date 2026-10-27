import { createDecipheriv, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { expect, it, onTestFinished, vi } from 'vitest';
import { collectEventBackup } from '../../../infra/package/event-backup.ts';
import { collectComputerVolumeExport, volumeExportDescriptorSchema } from '../../../infra/package/computer-volume-export.ts';
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
type Inventory = Parameters<Parameters<typeof collectComputerVolumeExport>[3]>[0];
async function fixture(fault = '', homes = 1,
  beforeRead?: (index: number) => void | Promise<void>) {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'home-export-'));
  async function close() {
    vi.mocked(fs.writeSync).mockReset();
    vi.mocked(fs.fsyncSync).mockReset();
    vi.mocked(fs.lstatSync).mockReset();
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
  if (homes === 2) {
    const second = JSON.stringify(records).replaceAll('one', 'two').replaceAll('sandbox-uid',
      'sandbox-two-uid');
    records.push(...JSON.parse(second) as typeof records);
  }
  if (homes === 0) records.splice(1);
  if (fault === 'lost' || fault === 'retired') {
    for (const name of ['one', 'two']) {
      records.push({ type: `computer.${fault}`, subject: `computer-assistant-${name}`,
        data: { ...identity, assistantId: `assistant-${name}`, computerId: `computer-${name}`,
          reason: 'fixture' } } as typeof records[number]);
    }
  }
  for (const record of records) {
    const previous = await source.store.head(record.subject);
    const envelope = { ...event(`${record.type}-${record.subject}`, record.subject, record.type), data: record.data };
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
  const secondSandbox = structuredClone(sandbox);
  const secondHome = structuredClone(home);
  const secondVolume = structuredClone(volume);
  function secondIdentity<Value>(value: Value): Value {
    const text = JSON.stringify(value).replaceAll('one', 'two').replaceAll('-uid', '-two-uid');
    return JSON.parse(text) as Value;
  }
  Object.assign(secondSandbox, secondIdentity(sandbox));
  Object.assign(secondHome, secondIdentity(home));
  Object.assign(secondVolume, secondIdentity(volume));
  if (homes === 2) {
    resources.sandboxes = { metadata: { resourceVersion: '10' }, items: [sandbox, secondSandbox] };
    resources.persistentvolumeclaims = { metadata: { resourceVersion: '10' },
      items: [home, secondHome] };
  }
  const streams: Readable[] = [];
  let opened = false;
  async function read(request: { resource: string; name?: string }) {
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
    if (request.name === 'volume-two') return JSON.stringify(secondVolume);
    return JSON.stringify(resources[request.resource]);
  }
  function cancel() { controller.abort(new Error(canary)); }
  function idle() {
    if (fault === 'cancel-active') setImmediate(cancel);
    if (fault === 'reader-error') stream.destroy(new Error(canary));
  }
  let stream = Readable.from([bytes.subarray(0, 5), bytes.subarray(5)]);
  if (fault === 'truncated') stream = Readable.from([bytes.subarray(0, -1)]);
  if (fault === 'overflow') stream = Readable.from([bytes, bytes]);
  if (fault === 'checksum') stream = Readable.from([Buffer.alloc(bytes.length)]);
  if (['stall', 'cancel', 'cancel-active'].includes(fault)) stream = new Readable({ read: idle });
  if (fault === 'reader-error' || fault === 'destroy-error') {
    function destroy(_error: Error | null, done: (error?: Error | null) => void) {
      done(new Error(canary));
    }
    stream = new Readable({ read: idle, destroy });
  }
  const controller = new AbortController();
  async function readExport(_binding: Inventory, _signal: AbortSignal,
    home: Inventory['volumes'][number]) {
    opened = true;
    await beforeRead?.(streams.length);
    if (fault === 'missing') throw new Error(canary);
    if (fault === 'cancel' || fault === 'destroy-error') controller.abort(new Error(canary));
    let byteCount = fault === 'size-limit' ? 64 * 1024 * 1024 + 1 : bytes.length;
    let content = bytes;
    if (home.computerId === 'computer-two') {
      content = Buffer.from('second-private-home');
      byteCount = content.length;
      stream = Readable.from([content]);
      if (fault === 'second-missing') throw new Error(canary);
      if (fault === 'second-duplicate') home = _binding.volumes[0]!;
      if (fault === 'second-substituted') home.home.uid = 'foreign';
      if (fault === 'second-generation') home.generation++;
      if (fault === 'second-truncated') stream = Readable.from([content.subarray(1)]);
      if (fault === 'second-overflow') stream = Readable.from([content, content]);
      if (fault === 'second-stall' || fault === 'second-cancel') {
        function stall() {
          if (fault === 'second-cancel') setImmediate(cancel);
        }
        stream = new Readable({ read: stall });
      }
    }
    if (fault.startsWith('aggregate-')) {
      let size = 32 * 1024 * 1024;
      if (home.computerId === 'computer-two') size += Number(fault.slice(10));
      content = Buffer.alloc(size, 97);
      byteCount = content.length;
      stream = Readable.from([content]);
    }
    streams.push(stream);
    return { home, stream, byteCount, sha256: digest(content) };
  }
  async function collect() {
    const settings = Object.assign(options, { signal: controller.signal });
    return collectComputerVolumeExport(source.connection, target.connection, settings, readExport, read);
  }
  return { options, collect, stream, streams, resources, namespace, sandbox, home, volume };
}
function decrypt(saved: Buffer, associated: unknown, material = key) {
  const decipher = createDecipheriv('aes-256-gcm', material, saved.subarray(0, 12));
  decipher.setAAD(Buffer.from(JSON.stringify(associated)));
  decipher.setAuthTag(saved.subarray(-16));
  return Buffer.concat([decipher.update(saved.subarray(12, -16)), decipher.final()]);
}

async function roundTripsEveryByte() {
  const setup = await fixture();
  const result = await setup.collect();
  const entry = result.exports[0]!;
  expect(result.kind).toBe('volume-export-only');
  expect(entry.byteCount).toBe(bytes.length);
  expect(entry.sha256).toBe(digest(bytes));
  expect(result.binding.volumes[0]).toMatchObject({ generation: 1,
    sandbox: { uid: 'sandbox-uid' }, home: { uid: 'home-uid' }, volume: { uid: 'volume-uid' } });
  const saved = await readFile(join(setup.options.destination, 'home-0000.enc'));
  expect(saved.includes(bytes)).toBe(false);
  expect(decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', result.binding, entry])).toEqual(bytes);
  const descriptor = await readFile(join(setup.options.destination, 'descriptor.json'), 'utf8');
  expect(JSON.parse(descriptor)).toEqual(result);
  expect(descriptor).not.toContain(canary);
  expect(descriptor).not.toContain(setup.options.backupKeyFile);
  expect(descriptor).not.toContain(key.toString('hex'));
  expect(setup.stream.destroyed).toBe(true);
}
it('encrypts one checked home and independently recovers every byte', roundTripsEveryByte);

async function authenticatesBinding() {
  const setup = await fixture();
  const result = await setup.collect();
  const saved = await readFile(join(setup.options.destination, 'home-0000.enc'));
  const entry = result.exports[0]!;
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
    function changed() { return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', binding, entry]); }
    expect(changed).toThrow();
  }
  function wrongCount() { return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', result.binding, { ...entry, byteCount: 1 }]); }
  function wrongHash() { return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', result.binding, { ...entry, sha256: 'a'.repeat(64) }]); }
  function wrongKey() {
    return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', result.binding, entry], Buffer.alloc(32, 72));
  }
  const other = await fixture();
  other.options.attempt = 'other';
  const descriptorPath = join(other.options.directory, 'descriptor.json');
  const descriptor = await readFile(descriptorPath, 'utf8');
  await writeFile(descriptorPath, descriptor.replace('"attempt":"copy"', '"attempt":"other"'));
  const otherResult = await other.collect();
  function swapped() { return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', otherResult.binding, entry]); }
  for (const refuses of [wrongCount, wrongHash, wrongKey, swapped]) expect(refuses).toThrow();
}
it('authenticates ownership, generation, archive, attempt, count and hash independently',
  authenticatesBinding);

const faults = ['missing', 'truncated', 'overflow', 'checksum', 'stall', 'cancel', 'cancel-active',
  'late-namespace', 'late-sandbox', 'late-generation', 'late-home', 'late-volume',
  'late-binding', 'resume', 'late-writer', 'late-archive', 'late-attempt',
  'key', 'key-link', 'foreign-output', 'foreign-owner', 'output-link', 'existing',
  'disk-write', 'disk-flush',
  'attempt', 'silo', 'active-writer', 'size-limit', 'timeout-limit', 'reader-error', 'destroy-error'];
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
  function diskFailure(): never { throw new Error(canary); }
  if (fault === 'foreign-owner') {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    function foreignMetadata(path: fs.PathLike) {
      const result = actual.lstatSync(path);
      if (path === dirname(options.destination)) result.uid++;
      return result;
    }
    vi.mocked(fs.lstatSync).mockImplementation(foreignMetadata);
  }
  if (fault === 'disk-write') vi.spyOn(fs, 'writeSync').mockImplementation(diskFailure);
  if (fault === 'disk-flush') vi.spyOn(fs, 'fsyncSync').mockImplementation(diskFailure);
  const logs = vi.spyOn(console, 'log');
  const errors = vi.spyOn(console, 'error');
  const started = performance.now();
  await expect(setup.collect()).rejects.toEqual(new Error('Computer volume export refused'));
  expect(logs).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
  expect(fs.existsSync(join(options.destination, 'descriptor.json'))).toBe(false);
  if (fault === 'size-limit') expect(setup.stream.readableDidRead).toBe(false);
  if (['stall', 'cancel', 'cancel-active'].includes(fault)) {
    expect(setup.stream.destroyed).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  }
  if (fs.existsSync(foreign)) expect(await readFile(join(foreign, 'keep'), 'utf8')).toBe(canary);
}
it.each(faults)('withholds completion and private diagnostics: %s', refusesFault);

async function roundTripsTwoHomes() {
  const setup = await fixture('', 2);
  const result = await setup.collect();
  expect(result.version).toBe(2);
  expect(result.exports).toHaveLength(2);
  const expected = [bytes, Buffer.from('second-private-home')];
  for (let index = 0; index < 2; index++) {
    const entry = result.exports[index]!;
    const saved = await readFile(join(setup.options.destination, entry.file));
    const associated = [2, 'volume-export-only', 'aes-256-gcm', result.binding, entry];
    expect(decrypt(saved, associated)).toEqual(expected[index]);
    for (const plaintext of expected) expect(saved.includes(plaintext)).toBe(false);
  }
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
}
it('encrypts every checked home in one set and independently recovers both', roundTripsTwoHomes);

async function refusesSecondHome(fault: string) {
  const setup = await fixture(fault, 2);
  if (fault === 'second-stall') Object.assign(setup.options, { timeoutMs: 1_000 });
  if (fault === 'second-flush') {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let flushes = 0;
    function flush(output: number) {
      flushes++;
      if (flushes === 2) throw new Error(canary);
      actual.fsyncSync(output);
    }
    vi.mocked(fs.fsyncSync).mockImplementation(flush);
  }
  await expect(setup.collect()).rejects.toEqual(new Error('Computer volume export refused'));
  expect(fs.existsSync(setup.options.destination)).toBe(false);
  expect(setup.streams.length).toBe(fault === 'second-missing' ? 1 : 2);
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
}
it.each(['second-missing', 'second-duplicate', 'second-substituted', 'second-generation',
  'second-truncated', 'second-overflow', 'second-stall', 'second-cancel', 'second-flush'])
  ('withholds the whole set and closes readers: %s', refusesSecondHome);

async function checksDescriptor() {
  const setup = await fixture('', 2);
  const result = await setup.collect();
  expect(volumeExportDescriptorSchema.safeParse(result).success).toBe(true);
  const changes = [
    { ...result, version: 1 }, { ...result, version: 3 }, { ...result, extra: true },
    { ...result, encryption: 'unknown' }, { ...result, exports: [] },
    { ...result, exports: [result.exports[0], result.exports[0]] },
    { ...result, exports: [...result.exports, result.exports[1]] },
  ];
  for (const patch of changes) {
    expect(volumeExportDescriptorSchema.safeParse(patch).success).toBe(false);
  }
  const first = result.exports[0]!;
  const second = result.exports[1]!;
  const saved = await readFile(join(setup.options.destination, first.file));
  const altered = [second, { ...first, file: second.file },
    { ...first, home: second.home }, { ...first, home: { ...first.home, generation: 2 } },
    { ...first, file: '../home.enc' }, { ...first, extra: true }];
  for (const entry of altered) {
    function decryptChanged() {
      return decrypt(saved, [2, 'volume-export-only', 'aes-256-gcm', result.binding, entry]);
    }
    expect(decryptChanged).toThrow();
    const descriptor = { ...result, exports: [entry, second] };
    expect(volumeExportDescriptorSchema.safeParse(descriptor).success).toBe(false);
  }
}
it('refuses unknown or incomplete descriptors and authenticates file and home identities',
  checksDescriptor);

async function emptyInventory() {
  const setup = await fixture('', 0);
  const result = await setup.collect();
  expect(result.binding.volumes).toEqual([]);
  expect(result.exports).toEqual([]);
  expect(setup.streams).toHaveLength(0);
  expect(fs.readdirSync(setup.options.destination)).toEqual(['descriptor.json']);
}
it('completes zero homes only with an empty event-derived inventory', emptyInventory);

async function retainedHomes(state: string) {
  const setup = await fixture(state, 2);
  const result = await setup.collect();
  expect(result.exports).toHaveLength(2);
}
it.each(['lost', 'retired'])('still exports both retained homes after %s', retainedHomes);

async function aggregateBoundary(extra: number) {
  const setup = await fixture(`aggregate-${extra}`, 2);
  if (extra > 0) {
    await expect(setup.collect()).rejects.toThrow('Computer volume export refused');
    expect(fs.existsSync(setup.options.destination)).toBe(false);
  } else {
    const result = await setup.collect();
    expect(result.exports[0]!.byteCount + result.exports[1]!.byteCount)
      .toBe(64 * 1024 * 1024 + extra);
  }
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
}
it.each([-1, 0, 1])('shares the exact aggregate byte boundary: %s', aggregateBoundary);

async function deadlineBoundary(elapsed: number) {
  let now = 0;
  function clock() { return now; }
  function advance(index: number) { now = index === 0 ? 30_000 : elapsed; }
  const setup = await fixture('', 2, advance);
  vi.spyOn(performance, 'now').mockImplementation(clock);
  if (elapsed < 60_000) {
    const result = await setup.collect();
    expect(result.exports).toHaveLength(2);
  } else {
    await expect(setup.collect()).rejects.toThrow('Computer volume export refused');
    expect(fs.existsSync(setup.options.destination)).toBe(false);
  }
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
}
it.each([59_999, 60_000, 60_001])('shares the exact overall deadline: %s', deadlineBoundary);

async function changesDuringCopy([index, fault]: readonly [number, string]) {
  async function change(current: number) {
    if (current !== index) return;
    if (fault === 'namespace') setup.namespace.metadata.uid = 'changed';
    if (fault === 'home') setup.home.metadata.uid = 'changed';
    if (fault === 'volume') setup.volume.metadata.uid = 'changed';
    if (fault === 'resume') setup.sandbox.spec.operatingMode = 'Running';
    if (fault === 'writer') setup.options.writersStopped = false;
    if (fault === 'history') {
      await writeFile(join(setup.options.directory, 'events.snapshot'), canary);
    }
  }
  const setup = await fixture('', 2, change);
  await expect(setup.collect()).rejects.toThrow('Computer volume export refused');
  expect(fs.existsSync(setup.options.destination)).toBe(false);
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
}
const copyChanges: [number, string][] = [];
for (const index of [0, 1]) {
  for (const fault of ['namespace', 'home', 'volume', 'resume', 'writer', 'history']) {
    copyChanges.push([index, fault]);
  }
}
it.each(copyChanges)('refuses identity or writer changes during copy %s: %s',
  async function refusesChange(index, fault) { await changesDuringCopy([index, fault]); });
