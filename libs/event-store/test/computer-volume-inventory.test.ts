import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { collectEventBackup, descriptorSchema } from '../../../infra/package/event-backup.ts';
import { collectComputerVolumeInventory } from '../../../infra/package/computer-volume-inventory.ts';
import { event, natsFixture } from './testing.ts';

const canary = 'private-volume-contents-credential-dependency-output';
const refused = new Error('Computer volume inventory refused');
const namespace = 'owned-test';
function metadata(name: string, uid = `${name}-uid`) {
  return { name, uid, namespace, resourceVersion: '10', generation: 3,
    labels: { 'sandbox.users.io/computer': 'computer-one' } };
}
function resources() {
  const labels = { 'sandbox.users.io/computer': 'computer-one',
    'sandbox.users.io/assistant': 'assistant-one' };
  const sandbox = { kind: 'Sandbox', metadata: metadata('computer-one'),
    spec: { operatingMode: 'Suspended', podTemplate: { metadata: { labels } } },
    status: { conditions: [{ type: 'Suspended', status: 'True', reason: 'PodTerminated',
      observedGeneration: 3 }] } };
  const owner = { kind: 'Sandbox', name: 'computer-one', uid: 'computer-one-uid',
    controller: true };
  const pvc = { kind: 'PersistentVolumeClaim', metadata: {
    ...metadata('home-computer-one'), ownerReferences: [owner] },
    spec: { volumeName: 'volume-one' }, status: { phase: 'Bound' } };
  const pv = { kind: 'PersistentVolume',
    metadata: { name: 'volume-one', uid: 'volume-one-uid', resourceVersion: '20' },
    spec: { claimRef: { namespace, name: 'home-computer-one', uid: 'home-computer-one-uid' } },
    status: { phase: 'Bound' } };
  const podMetadata = metadata('other-pod');
  podMetadata.labels['sandbox.users.io/computer'] = 'unrelated';
  const pod = { kind: 'Pod', metadata: podMetadata,
    spec: { volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'home-computer-one' } }] } };
  return { sandbox, pvc, pv, pod };
}
async function fixture(empty = false, fault = '') {
  const source = await natsFixture();
  const target = await natsFixture({ provision: false });
  const directory = await mkdtemp(join(tmpdir(), 'volume-inventory-'));
  const archive = join(directory, 'events');
  let ordinal = 0;
  async function append(type: string, data: object, subject = 'computer-assistant-one') {
    const previous = await source.store.head(subject);
    const envelope = { ...event(`entry-${ordinal++}`, subject, type), data };
    expect(await source.store.append({ event: envelope, expectedSequence: previous }))
      .toMatchObject({ status: 'appended' });
  }
  await source.store.append({ event: event('member'), expectedSequence: 0 });
  const identity = { assistantId: 'assistant-one', computerId: 'computer-one' };
  if (!empty) {
    const assistant = { assistantId: 'assistant-one', ownerId: 'alice', kind: 'personal' };
    if (fault !== 'missing-assistant') {
      await append('assistant.created', assistant, 'assistant-assistant-one');
    }
    await append('computer.claimed', { ...identity, generation: 1, tokenId: 'token:one' });
    await append('computer.ready', { ...identity, generation: 1, sandboxUid: 'old-sandbox' });
    await append('computer.lost', identity);
    await append('computer.claimed', { ...identity, generation: 2, tokenId: 'token:two' });
    const generation = fault === 'event-generation' ? 1 : 2;
    const sandboxUid = fault === 'missing-binding' ? {} : { sandboxUid: 'computer-one-uid' };
    const currentGeneration = fault === 'missing-generation' ? {} : { generation };
    await append('computer.ready', { ...identity, ...currentGeneration, ...sandboxUid });
    await append('computer.suspended', identity);
    if (fault === 'retired') await append('computer.retired', identity);
    if (fault === 'conflicting-claim') {
      await append('computer.claimed', { ...identity, generation: 2, tokenId: 'token:three' });
    }
    if (fault === 'duplicate-assistant') {
      await append('assistant.created', assistant, 'assistant-assistant-one');
    }
    if (fault === 'multiple' || fault === 'duplicate-computer') {
      await append('assistant.created', { ...assistant, assistantId: 'assistant-two' },
        'assistant-assistant-two');
      const computerId = fault === 'multiple' ? 'computer-two' : 'computer-one';
      await append('computer.claimed', { assistantId: 'assistant-two', computerId, generation: 1,
        sandboxUid: `${computerId}-uid`, tokenId: 'token:other' }, 'computer-assistant-two');
    }
  }
  await collectEventBackup(source.connection, { silo: 'test', attempt: 'copy', destination: archive });
  const options = { directory: archive, silo: 'test', attempt: 'copy', disposable: true,
    namespace, namespaceUid: 'namespace-uid', kubeconfig: '/private/config', context: 'owned' };
  const { sandbox, pvc, pv, pod } = resources();
  const persistentVolumes = new Map([[pv.metadata.name, pv]]);
  const namespaceResource = { kind: 'Namespace', metadata: metadata(namespace, 'namespace-uid') };
  const lists = {
    sandboxes: { metadata: { resourceVersion: '10', continue: '' }, items: [sandbox] },
    persistentvolumeclaims: { metadata: { resourceVersion: '10', continue: '' }, items: [pvc] },
    pods: { metadata: { resourceVersion: '10', continue: '' }, items: [] as object[] },
  };
  if (fault === 'multiple') {
    const secondSandbox = structuredClone(sandbox);
    secondSandbox.metadata = metadata('computer-two');
    secondSandbox.spec.podTemplate.metadata.labels = {
      'sandbox.users.io/computer': 'computer-two', 'sandbox.users.io/assistant': 'assistant-two' };
    const secondHome = structuredClone(pvc);
    Object.assign(secondHome.metadata, metadata('home-computer-two'));
    secondHome.metadata.labels['sandbox.users.io/computer'] = 'computer-two';
    secondHome.metadata.ownerReferences[0]!.name = 'computer-two';
    secondHome.metadata.ownerReferences[0]!.uid = 'computer-two-uid';
    secondHome.spec.volumeName = 'volume-two';
    const secondVolume = structuredClone(pv);
    secondVolume.metadata = { name: 'volume-two', uid: 'volume-two-uid', resourceVersion: '20' };
    secondVolume.spec.claimRef.name = 'home-computer-two';
    secondVolume.spec.claimRef.uid = 'home-computer-two-uid';
    persistentVolumes.set('volume-two', secondVolume);
    lists.sandboxes.items.push(secondSandbox);
    lists.persistentvolumeclaims.items.push(secondHome);
  }
  const requests: string[] = [];
  let observations = 0;
  async function read(request: { resource: string; name?: string; namespace: string; signal: AbortSignal }) {
    expect(request.namespace).toBe(namespace);
    requests.push(request.resource);
    if (fault === 'denied') throw new Error(canary);
    if (fault === 'timeout') {
      const pending = Promise.withResolvers<string>();
      function abort() { pending.reject(new Error(canary)); }
      request.signal.addEventListener('abort', abort, { once: true });
      return pending.promise;
    }
    if (request.resource === 'namespace') observations++;
    if (request.resource === 'namespace' && observations === 2) {
      if (fault === 'pv-namespace-race') pv.spec.claimRef.namespace = 'foreign';
      if (fault === 'pv-uid-race') pv.spec.claimRef.uid = 'old-pvc-uid';
      if (fault === 'pv-released-race') pv.status.phase = 'Released';
      if (fault === 'pvc-pending-race') pvc.status.phase = 'Pending';
      if (fault === 'pv-replacement') pv.metadata.uid = 'replacement';
      if (fault === 'pv-version') pv.metadata.resourceVersion = '21';
      if (fault === 'binding-race') {
        pvc.spec.volumeName = 'replacement-volume';
        pv.metadata.name = 'replacement-volume';
        persistentVolumes.set('replacement-volume', pv);
      }
      if (fault === 'replace-pvc') pvc.metadata.uid = 'replacement';
      if (fault === 'replace-sandbox') sandbox.metadata.uid = 'replacement';
      if (fault === 'resume') sandbox.spec.operatingMode = 'Running';
      if (fault === 'namespace-race') namespaceResource.metadata.uid = 'replacement';
      if (fault === 'version') pvc.metadata.resourceVersion = '11';
      if (fault === 'late-pod') lists.pods.items.push(pod);
      if (fault === 'archive-race') await writeFile(join(archive, 'events.snapshot'), canary);
      if (fault === 'descriptor-race') {
        const path = join(archive, 'descriptor.json');
        const descriptor = descriptorSchema.parse(JSON.parse(await readFile(path, 'utf8')));
        await writeFile(path, JSON.stringify({ ...descriptor, attempt: 'other' }));
      }
      if (fault === 'event-resume') {
        await append('computer.resumed', { ...identity, generation: 2, tokenId: 'token:resume' });
      }
    }
    if (request.resource === 'namespace') return JSON.stringify(namespaceResource);
    if (request.resource === 'persistentvolumes') {
      if (fault === 'pv-denied') throw new Error(canary);
      return JSON.stringify(persistentVolumes.get(request.name ?? '') ?? {});
    }
    return JSON.stringify(Reflect.get(lists, request.resource));
  }
  async function collect() {
    return collectComputerVolumeInventory(source.connection, target.connection, options, read);
  }
  async function close() {
    await source.close();
    await target.close();
    await rm(directory, { recursive: true, force: true });
  }
  return { collect, close, options, sandbox, pvc, pv, pod, namespaceResource, lists, requests, archive };
}

async function includesRetainedHome(fault: string) {
  const setup = await fixture(false, fault);
  try {
    const result = await setup.collect();
    const saved = await readFile(join(setup.archive, 'descriptor.json'), 'utf8');
    const descriptor = descriptorSchema.parse(JSON.parse(saved));
    expect({ ...result, volumes: result.volumes.slice(0, 1) }).toMatchObject({ silo: 'test', attempt: 'copy',
      eventArchiveSha256: descriptor.sha256, namespace: { uid: 'namespace-uid' },
      volumes: [{ assistantId: 'assistant-one', computerId: 'computer-one', generation: 2,
        sandbox: { uid: 'computer-one-uid', resourceVersion: '10' },
        home: { uid: 'home-computer-one-uid', resourceVersion: '10' },
        volume: { name: 'volume-one', uid: 'volume-one-uid', resourceVersion: '20' } }] });
    expect(result.volumes).toHaveLength(fault === 'multiple' ? 2 : 1);
    expect(JSON.stringify(result)).not.toMatch(/private|token|conditions|podTemplate/);
    expect(setup.requests).toHaveLength(fault === 'multiple' ? 12 : 10);
  } finally { await setup.close(); }
}
it.each(['suspended', 'retired', 'multiple'])('includes the current retained home once: %s', includesRetainedHome);

async function emptyInventory() {
  const setup = await fixture(true);
  try {
    setup.lists.sandboxes.items = [];
    setup.lists.persistentvolumeclaims.items = [];
    expect((await setup.collect()).volumes).toEqual([]);
  } finally { await setup.close(); }
}
it('returns an empty inventory only for an archive requiring no homes', emptyInventory);

const faults = ['missing-pvc', 'missing-sandbox', 'foreign-pvc', 'foreign-sandbox',
  'wrong-assistant', 'wrong-namespace', 'wrong-generation', 'stale-suspension', 'running',
  'false-suspension', 'wrong-reason', 'mounting-pod', 'named-pod', 'owned-pod',
  'partial-list', 'missing-items', 'duplicate-pvc', 'duplicate-sandbox', 'extra-home',
  'wrong-owner-name', 'wrong-owner-kind', 'non-controller', 'multiple-owners',
  'namespace-uid', 'denied', 'timeout', 'replace-pvc', 'replace-sandbox', 'resume',
  'version', 'late-pod', 'archive-race', 'descriptor-race', 'event-resume', 'event-generation',
  'missing-binding', 'missing-generation', 'missing-assistant', 'namespace-race', 'remaining-list',
  'conflicting-claim', 'duplicate-assistant', 'duplicate-computer',
  'attempt', 'silo', 'corrupt-archive', 'oversized-reply',
  'pvc-pending', 'pvc-unbound', 'pvc-no-status', 'pv-missing', 'pv-denied',
  'pv-foreign-namespace', 'pv-stale-uid', 'pv-wrong-claim-name', 'pv-no-claim',
  'pv-released', 'pv-available', 'pv-no-status', 'pv-wrong-name', 'pv-wrong-kind',
  'pv-namespace-race', 'pv-uid-race', 'pv-released-race', 'pvc-pending-race',
  'pv-replacement', 'pv-version', 'binding-race'] as const;
async function refusesFault(fault: typeof faults[number]) {
  const setup = await fixture(false, fault);
  try {
    const { sandbox, pvc, pv, pod, lists } = setup;
    if (fault === 'pvc-pending') pvc.status.phase = 'Pending';
    if (fault === 'pvc-unbound') Reflect.deleteProperty(pvc.spec, 'volumeName');
    if (fault === 'pvc-no-status') Reflect.deleteProperty(pvc, 'status');
    if (fault === 'pv-missing') pvc.spec.volumeName = 'missing';
    if (fault === 'pv-foreign-namespace') pv.spec.claimRef.namespace = 'foreign';
    if (fault === 'pv-stale-uid') pv.spec.claimRef.uid = 'old-pvc-uid';
    if (fault === 'pv-wrong-claim-name') pv.spec.claimRef.name = 'other-home';
    if (fault === 'pv-no-claim') Reflect.deleteProperty(pv.spec, 'claimRef');
    if (fault === 'pv-released') pv.status.phase = 'Released';
    if (fault === 'pv-available') pv.status.phase = 'Available';
    if (fault === 'pv-no-status') Reflect.deleteProperty(pv, 'status');
    if (fault === 'pv-wrong-name') pv.metadata.name = 'other-volume';
    if (fault === 'pv-wrong-kind') pv.kind = 'PersistentVolumeClaim';
    const condition = sandbox.status.conditions[0]!;
    const owner = pvc.metadata.ownerReferences[0]!;
    if (fault === 'missing-pvc') lists.persistentvolumeclaims.items = [];
    if (fault === 'missing-sandbox') lists.sandboxes.items = [];
    if (fault === 'foreign-pvc') pvc.metadata.labels['sandbox.users.io/computer'] = 'other';
    if (fault === 'foreign-sandbox') owner.uid = 'other';
    if (fault === 'wrong-assistant') {
      sandbox.spec.podTemplate.metadata.labels['sandbox.users.io/assistant'] = 'other';
    }
    if (fault === 'wrong-namespace') pvc.metadata.namespace = 'other';
    if (fault === 'wrong-generation') sandbox.metadata.generation++;
    if (fault === 'stale-suspension') condition.observedGeneration--;
    if (fault === 'running') sandbox.spec.operatingMode = 'Running';
    if (fault === 'false-suspension') condition.status = 'False';
    if (fault === 'wrong-reason') condition.reason = 'Requested';
    if (fault === 'mounting-pod') lists.pods.items.push(pod);
    if (fault === 'named-pod' || fault === 'owned-pod') {
      pod.spec.volumes = [];
      if (fault === 'named-pod') pod.metadata.name = 'computer-one';
      else Reflect.set(pod.metadata, 'ownerReferences', [{ uid: 'computer-one-uid' }]);
      lists.pods.items.push(pod);
    }
    if (fault === 'partial-list') lists.pods.metadata.continue = 'next';
    if (fault === 'remaining-list') Reflect.set(lists.pods.metadata, 'remainingItemCount', 1);
    if (fault === 'missing-items') Reflect.deleteProperty(lists.pods, 'items');
    if (fault === 'duplicate-pvc') lists.persistentvolumeclaims.items.push(structuredClone(pvc));
    if (fault === 'duplicate-sandbox') lists.sandboxes.items.push(structuredClone(sandbox));
    if (fault === 'extra-home') {
      const extra = structuredClone(pvc);
      extra.metadata.name = 'other-home';
      extra.metadata.uid = 'other-uid';
      lists.persistentvolumeclaims.items.push(extra);
    }
    if (fault === 'wrong-owner-name') owner.name = 'other';
    if (fault === 'wrong-owner-kind') owner.kind = 'Pod';
    if (fault === 'non-controller') owner.controller = false;
    if (fault === 'multiple-owners') pvc.metadata.ownerReferences.push({ ...owner });
    if (fault === 'namespace-uid') setup.namespaceResource.metadata.uid = 'other';
    if (fault === 'timeout') setup.options = Object.assign(setup.options, { timeoutMs: 1_000 });
    if (fault === 'attempt') setup.options.attempt = 'other';
    if (fault === 'silo') setup.options.silo = 'other';
    if (fault === 'corrupt-archive') await writeFile(join(setup.archive, 'events.snapshot'), canary);
    if (fault === 'oversized-reply') Reflect.set(pvc, 'private', canary.repeat(100_000));
    await expect(setup.collect()).rejects.toEqual(refused);
    if (fault === 'pvc-unbound') {
      expect(setup.requests).not.toContain('persistentvolumes');
    }
  } finally { await setup.close(); }
}
it.each(faults)('refuses without private output: %s', refusesFault);
