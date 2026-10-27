import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import * as replay from '../../../apps/ops/src/replay.ts';
import { restoreStorage } from '../../../apps/server/test/support/restore-storage.ts';
import { recoveryEffectProbes } from '../../../infra/package/upgrade-recovery-files-effects.ts';
import { collectBackupCapture } from '../../../infra/package/backup-capture.ts';
import { natsFixture } from './testing.ts';

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
    await source.seed([
      envelope('test', `assistant-${assistantId}`, 'assistant.created',
        { assistantId, ownerId: 'alice', kind: 'personal' }),
      envelope('test', `computer-${assistantId}`, 'computer.claimed',
        { ...identity, tokenId: `token:${computerId}` }),
      envelope('test', `computer-${assistantId}`, 'computer.ready',
        { ...identity, sandboxUid: resource.sandbox.metadata.uid }),
    ]);
  }
  const objectKey = `test/chat/file/${digest(bytes)}`;
  await storage.client.putObject('files', objectKey, bytes);
  await source.seed([envelope('test', 'conversation-chat', 'file.uploaded', {
    conversationId: 'chat', fileId: 'file', uploadedBy: 'alice', name: 'notes.txt',
    mime: 'text/plain', size: bytes.length, sha256: digest(bytes), objectKey,
  })]);
  const controller = new AbortController();
  const options = { silo: 'test', attempt: 'copy', disposable: true,
    namespace: 'owned', namespaceUid: 'namespace-uid', kubeconfig: '/private/config',
    context: 'owned', backupKeyFile: join(directory, canary),
    destination: join(directory, 'capture'), writersStopped: true, signal: controller.signal,
    timeoutMs: 10_000 };
  await writeFile(options.backupKeyFile, Buffer.alloc(32, 71), { mode: 0o600 });
  async function readKubernetes(request: { resource: string; name?: string }) {
    if (request.resource === 'namespace') {
      return JSON.stringify({ kind: 'Namespace', metadata: {
        name: 'owned', uid: 'namespace-uid', resourceVersion: '10' } });
    }
    const items = [];
    for (const resource of resources) {
      if (request.name === resource.volume.metadata.name) return JSON.stringify(resource.volume);
      if (request.resource === 'sandboxes') items.push(resource.sandbox);
      if (request.resource === 'persistentvolumeclaims') items.push(resource.home);
    }
    return JSON.stringify({ metadata: { resourceVersion: '10' }, items });
  }
  const streams: Readable[] = [];
  const readHome: ReadHome = async function readHome(_binding, _signal, home) {
    const content = Buffer.from(`${canary}-${home.computerId}`);
    const stream = Readable.from([content]);
    streams.push(stream);
    return { home, stream, byteCount: content.length, sha256: digest(content) };
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
  const homeText = fs.readFileSync(join(setup.options.destination, 'homes/descriptor.json'), 'utf8');
  expect(homeText).toContain(result.eventArchiveSha256);
  expect(homeText).toContain(result.eventDescriptorSha256);
  expect(JSON.stringify(result)).not.toContain(canary);
  expect(JSON.stringify(result)).not.toContain(setup.directory);
  for (const stream of setup.streams) expect(stream.destroyed).toBe(true);
  effects();
  expect(replayProbe).not.toHaveBeenCalled();
}
it('captures matching event, object and two-home evidence without product effects',
  capturesMatchingComponents);
