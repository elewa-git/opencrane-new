import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import * as replay from '../../apps/ops/src/replay.ts';
import { restoreStorage } from '../../apps/server/test/support/restore-storage.ts';
import { recoveryEffectProbes } from './upgrade-recovery-files-effects.ts';
import { collectBackupCapture } from './backup-capture.ts';
import { natsFixture } from '@opencrane/event-store/testing';

vi.mock('node:fs', { spy: true });
const canary = 'private-capture-canary';
const bytes = Buffer.from(canary);
let storage: Awaited<ReturnType<typeof restoreStorage>>;
async function start() {
  storage = await restoreStorage();
  await storage.client.makeBucket('files');
}
async function stop() { await storage.close(); }
beforeAll(start, 180_000);
afterAll(stop);
function digest(input: Buffer) {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest('hex');
}
function homeResources(name: string) {
  const suffix = name === 'one' ? '' : '-two';
  const labels = { 'sandbox.users.io/computer': `computer-${name}`,
    'sandbox.users.io/assistant': `assistant-${name}` };
  const sandbox = { kind: 'Sandbox', metadata: { name: `computer-${name}`, uid: `sandbox${suffix}-uid`,
    namespace: 'owned', generation: 3, resourceVersion: '11' },
    spec: { operatingMode: 'Suspended', podTemplate: { metadata: { labels } } },
    status: { conditions: [{ type: 'Suspended', status: 'True', reason: 'PodTerminated',
      observedGeneration: 3 }] } };
  const home = { kind: 'PersistentVolumeClaim', metadata: { name: `home-computer-${name}`,
    namespace: 'owned', uid: `home${suffix}-uid`, resourceVersion: '12', labels,
    ownerReferences: [{ kind: 'Sandbox', name: `computer-${name}`, uid: `sandbox${suffix}-uid`,
      controller: true }] }, spec: { volumeName: `volume-${name}` }, status: { phase: 'Bound' } };
  const volume = { kind: 'PersistentVolume', metadata: {
    name: `volume-${name}`, uid: `volume${suffix}-uid`, resourceVersion: '13' },
    spec: { claimRef: { namespace: 'owned', name: `home-computer-${name}`, uid: `home${suffix}-uid` } },
    status: { phase: 'Bound' } };
  return { sandbox, home, volume };
}

type ReadHome = Parameters<typeof collectBackupCapture>[5];
async function fixture(homes = 2) {
  const source = await natsFixture();
  const objectTarget = await natsFixture({ provision: false });
  const homeTarget = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'capture-'));
  async function close() {
    vi.mocked(fs.fsyncSync).mockReset();
    vi.restoreAllMocks();
    await source.close();
    await objectTarget.close();
    await homeTarget.close();
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(close);
  const resources = [homeResources('one'), homeResources('two')].slice(0, homes);
  for (const resource of resources) {
    const computerId = resource.sandbox.metadata.name;
    const assistantId = resource.home.metadata.labels['sandbox.users.io/assistant'];
    const identity = { assistantId, computerId, generation: 1 };
    const assistant = { assistantId, ownerId: 'alice', kind: 'personal' };
    const claim = { ...identity, tokenId: `token:${computerId}` };
    const ready = { ...identity, sandboxUid: resource.sandbox.metadata.uid };
    const records = [
      envelope('test', `assistant-${assistantId}`, 'assistant.created', assistant),
      envelope('test', `computer-${assistantId}`, 'computer.claimed', claim),
      envelope('test', `computer-${assistantId}`, 'computer.ready', ready),
    ];
    await source.seed(records);
  }
  const objectKey = `test/chat/file/${digest(bytes)}`;
  await storage.client.putObject('files', objectKey, bytes);
  const file = {
    conversationId: 'chat', fileId: 'file', uploadedBy: 'alice', name: 'notes.txt',
    mime: 'text/plain', size: bytes.length, sha256: digest(bytes), objectKey,
  };
  const upload = envelope('test', 'conversation-chat', 'file.uploaded', file);
  await source.seed([upload]);
  const controller = new AbortController();
  const options = { silo: 'test', attempt: 'copy', disposable: true,
    namespace: 'owned', namespaceUid: 'namespace-uid', kubeconfig: '/private/config',
    context: 'owned', backupKeyFile: join(directory, canary),
    destination: join(directory, 'capture'), writersStopped: true, signal: controller.signal,
    timeoutMs: 10_000 };
  await writeFile(options.backupKeyFile, Buffer.alloc(32, 71), { mode: 0o600 });
  function readKubernetes(request: { resource: string; name?: string }) {
    if (request.resource === 'namespace') {
      const namespace = { kind: 'Namespace', metadata: {
        name: 'owned', uid: 'namespace-uid', resourceVersion: '10' } };
      return Promise.resolve(JSON.stringify(namespace));
    }
    const items = [];
    for (const resource of resources) {
      if (request.name === resource.volume.metadata.name) {
        return Promise.resolve(JSON.stringify(resource.volume));
      }
      if (request.resource === 'sandboxes') items.push(resource.sandbox);
      if (request.resource === 'persistentvolumeclaims') items.push(resource.home);
    }
    const list = { metadata: { resourceVersion: '10' }, items };
    return Promise.resolve(JSON.stringify(list));
  }
  const streams: Readable[] = [];
  const readHome: ReadHome = function readHome(_binding, _signal, home) {
    const content = Buffer.from(`${canary}-${home.computerId}`);
    const stream = Readable.from([content]);
    streams.push(stream);
    const input = { home, stream, byteCount: content.length, sha256: digest(content) };
    return Promise.resolve(input);
  };
  async function capture(reader = readHome, target = homeTarget.connection) {
    return collectBackupCapture(source.connection, objectTarget.connection, target,
      storage.client, options, reader, readKubernetes);
  }
  return { source, objectTarget, homeTarget, directory, resources, options, controller,
    streams, readHome, capture, objectKey };
}

async function capturesMatchingComponents() {
  const setup = await fixture();
  const effects = recoveryEffectProbes();
  const replayProbe = vi.spyOn(replay, 'replay');
  function refuseReplay(): never { throw new Error('Replay reached'); }
  replayProbe.mockImplementation(refuseReplay);
  function exercise() { Reflect.apply(replayProbe, undefined, []); }
  expect(exercise).toThrow('Replay reached');
  replayProbe.mockClear();
  const result = await setup.capture();
  expect(result).toMatchObject({ kind: 'capture-components-only', silo: 'test', attempt: 'copy',
    events: { kind: 'event-bytes-only', count: 7 },
    objects: { kind: 'event-referenced-objects-only', count: 1 },
    homes: { kind: 'volume-export-only', count: 2 } });
  for (const component of ['objects', 'homes']) {
    const path = join(setup.options.destination, component, 'descriptor.json');
    const text = fs.readFileSync(path, 'utf8');
    expect(text).toContain(result.eventArchiveSha256);
    expect(text).toContain(result.eventDescriptorSha256);
  }
  expect(JSON.stringify(result)).not.toContain(canary);
  expect(JSON.stringify(result)).not.toContain(setup.directory);
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
  effects();
  expect(replayProbe).not.toHaveBeenCalled();
}
it('captures matching event, object and two-home evidence without product effects',
  capturesMatchingComponents);

const refused = new Error('Backup capture refused; completion unknown; keep targets isolated');
const faults = ['second-missing', 'attempt', 'archive', 'source', 'pvc', 'pv',
  'writers', 'corrupt-object', 'flush', 'object-description', 'saved-object'];
for (const fault of faults) {
  async function refusesChangedCapture() {
    const setup = await fixture();
    if (fault === 'corrupt-object') {
      await storage.client.putObject('files', setup.objectKey, Buffer.alloc(bytes.length));
    }
    const read: ReadHome = async function read(binding, signal, home) {
      if (fault === 'second-missing' && home.computerId === 'computer-two') {
        throw new Error(canary);
      }
      const input = await setup.readHome(binding, signal, home);
      if (home.computerId !== 'computer-two') return input;
      const events = join(setup.options.destination, 'events');
      if (fault === 'attempt') {
        const path = join(events, 'descriptor.json');
        const text = fs.readFileSync(path, 'utf8');
        fs.writeFileSync(path, text.replace('"attempt":"copy"', '"attempt":"other"'));
      }
      if (fault === 'archive') fs.writeFileSync(join(events, 'events.snapshot'), bytes);
      if (fault === 'source') {
        const data = { assistantId: 'extra', ownerId: 'alice', kind: 'personal' };
        const extra = envelope('test', 'assistant-extra', 'assistant.created', data);
        await setup.source.seed([extra]);
      }
      if (fault === 'pvc') setup.resources[1]!.home.spec.volumeName = 'foreign';
      if (fault === 'pv') setup.resources[1]!.volume.spec.claimRef.uid = 'foreign';
      if (fault === 'writers') setup.options.writersStopped = false;
      if (fault === 'flush') {
        function failFlush(): never { throw new Error(canary); }
        vi.mocked(fs.fsyncSync).mockImplementation(failFlush);
      }
      const objects = join(setup.options.destination, 'objects');
      if (fault === 'object-description') {
        const path = join(objects, 'descriptor.json');
        const text = fs.readFileSync(path, 'utf8');
        fs.writeFileSync(path, text.replace('"attempt":"copy"', '"attempt":"other"'));
      }
      if (fault === 'saved-object') {
        for (const name of fs.readdirSync(objects)) {
          if (name !== 'descriptor.json') fs.writeFileSync(join(objects, name), bytes);
        }
      }
      return input;
    };
    await expect(setup.capture(read)).rejects.toEqual(refused);
    expect(fs.existsSync(join(setup.options.destination, 'descriptor.json'))).toBe(false);
  }
  it(`withholds combined evidence after ${fault}`, refusesChangedCapture);
}

async function emptyHomes() {
  const setup = await fixture(0);
  const result = await setup.capture();
  expect(result.homes.count).toBe(0);
  expect(setup.streams).toHaveLength(0);
}
it('accepts zero homes only with an empty event-derived inventory', emptyHomes);

async function missingInventory() {
  const setup = await fixture();
  setup.resources.pop();
  await expect(setup.capture()).rejects.toEqual(refused);
  expect(setup.streams).toHaveLength(0);
}
it('refuses missing Kubernetes homes even when its reader could return no bytes', missingInventory);

async function distinctTargets() {
  const setup = await fixture();
  await expect(setup.capture(setup.readHome, setup.objectTarget.connection)).rejects.toEqual(refused);
  await expect(setup.objectTarget.store.head()).rejects.toThrow('stream not found');
}
it('requires two distinct disposable targets before capture', distinctTargets);

async function populatedTarget() {
  const setup = await fixture();
  await setup.homeTarget.store.ensureStream({ replicas: 1 });
  const data = { assistantId: 'existing', ownerId: 'alice', kind: 'personal' };
  const existing = envelope('test', 'assistant-existing', 'assistant.created', data);
  await setup.homeTarget.seed([existing]);
  await expect(setup.capture()).rejects.toEqual(refused);
  expect(await setup.homeTarget.store.head()).toBe(1);
}
it('preserves a populated target and refuses its reuse', populatedTarget);

for (const targetName of ['objectTarget', 'homeTarget'] as const) {
  async function lostCompletion() {
    const setup = await fixture();
    const connection = setup[targetName].connection;
    const request = connection.request.bind(connection);
    const requests: string[] = [];
    let delivery = '';
    async function intercept(...args: Parameters<typeof request>) {
      const [subject, data] = args;
      requests.push(subject);
      const reply = await request(...args);
      if (subject === '$JS.API.STREAM.RESTORE.EVENTS') {
        delivery = reply.json<{ deliver_subject: string }>().deliver_subject;
      }
      if (subject === delivery && !data?.length) throw new Error(canary);
      return reply;
    }
    vi.spyOn(connection, 'request').mockImplementation(intercept);
    await expect(setup.capture()).rejects.toEqual(refused);
    expect(await setup[targetName].store.head()).toBe(7);
    function restore(subject: string) { return subject === '$JS.API.STREAM.RESTORE.EVENTS'; }
    expect(requests.filter(restore)).toHaveLength(1);
    for (const subject of requests) {
      expect(subject).not.toContain('.DELETE.');
      expect(subject).not.toContain('.PURGE.');
    }
  }
  it(`keeps ${targetName} intact after unknown completion without resending`, lostCompletion);
}

async function originalDeadline() {
  const setup = await fixture();
  setup.options.timeoutMs = 1_000;
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
  const get = storage.client.getObjectBounded.bind(storage.client);
  async function spendTime(...args: Parameters<typeof get>) {
    const stream = await get(...args);
    clock.mockReturnValue(600);
    return stream;
  }
  vi.spyOn(storage.client, 'getObjectBounded').mockImplementation(spendTime);
  const read: ReadHome = async function read(binding, signal, home) {
    clock.mockReturnValue(1_001);
    return setup.readHome(binding, signal, home);
  };
  await expect(setup.capture(read)).rejects.toEqual(refused);
  expect(setup.streams).toHaveLength(1);
  expect(setup.streams[0]!.destroyed).toBe(true);
}
it('gives the later home stage only the time left from the original deadline', originalDeadline);

async function cancellationClosesReaders() {
  const setup = await fixture();
  const opened: Readable[] = [];
  const signals: AbortSignal[] = [];
  const get = storage.client.getObjectBounded.bind(storage.client);
  async function record(...args: Parameters<typeof get>) {
    signals.push(args[2].signal);
    const stream = await get(...args);
    opened.push(stream);
    return stream;
  }
  vi.spyOn(storage.client, 'getObjectBounded').mockImplementation(record);
  const read: ReadHome = function read(_binding, signal, home) {
    signals.push(signal);
    function idle() { setup.controller.abort(new Error(canary)); }
    const stream = new Readable({ read: idle });
    opened.push(stream);
    const input = { home, stream, byteCount: bytes.length, sha256: digest(bytes) };
    return Promise.resolve(input);
  };
  await expect(setup.capture(read)).rejects.toEqual(refused);
  expect(opened).toHaveLength(2);
  for (const stream of opened) expect(stream.destroyed).toBe(true);
  for (const signal of signals) expect(signal.aborted).toBe(true);
}
it('cancellation closes the object reader and active home reader', cancellationClosesReaders);

async function changesDuringFinalCheck() {
  const setup = await fixture();
  const request = setup.source.connection.request.bind(setup.source.connection);
  async function intercept(...args: Parameters<typeof request>) {
    const reply = await request(...args);
    const homes = join(setup.options.destination, 'homes');
    if (fs.existsSync(join(homes, 'descriptor.json'))) {
      fs.writeFileSync(join(homes, 'home-0000.enc'), bytes);
    }
    return reply;
  }
  vi.spyOn(setup.source.connection, 'request').mockImplementation(intercept);
  await expect(setup.capture()).rejects.toEqual(refused);
}
it('rechecks copied archives after the final asynchronous source check', changesDuringFinalCheck);
