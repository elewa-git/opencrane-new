import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { event, natsFixture } from '@opencrane/event-store/testing';
import { collectComputerVolumeExport } from '../../../../infra/package/computer-volume-export.ts';

type Source = Awaited<ReturnType<typeof natsFixture>>;
type Options = { eventDirectory: string; volumeDirectory: string; backupKeyFile: string;
  silo: string; attempt: string };

export async function recoveryHomes(source: Source, names: string[]) {
  const sandboxes: object[] = [];
  const claims: object[] = [];
  const volumes = new Map<string, object>();
  for (const name of names) {
    const identity = { assistantId: name, computerId: `computer-${name}`, generation: 1 };
    const sandboxUid = `sandbox-${name}`;
    const records = [
      { ...event(`assistant-${name}`, `assistant-${name}`, 'assistant.created'),
        data: { assistantId: name, ownerId: 'alice', kind: 'personal' } },
      { ...event(`claim-${name}`, `computer-${name}`, 'computer.claimed'),
        data: { ...identity, tokenId: `token:${name}` } },
      { ...event(`ready-${name}`, `computer-${name}`, 'computer.ready'),
        data: { ...identity, sandboxUid } },
    ];
    for (const record of records) await source.seed([record]);
    const labels = { 'sandbox.users.io/computer': identity.computerId,
      'sandbox.users.io/assistant': name };
    const metadata = { namespace: 'owned', resourceVersion: '1' };
    sandboxes.push({ kind: 'Sandbox', metadata: { ...metadata, name: identity.computerId,
      uid: sandboxUid, generation: 1 },
      spec: { operatingMode: 'Suspended', podTemplate: { metadata: { labels } } },
      status: { conditions: [{ type: 'Suspended', status: 'True', reason: 'PodTerminated',
        observedGeneration: 1 }] } });
    const homeName = `home-${identity.computerId}`;
    const volumeName = `volume-${name}`;
    claims.push({ kind: 'PersistentVolumeClaim', metadata: { ...metadata, name: homeName,
      uid: homeName, labels, ownerReferences: [{ kind: 'Sandbox', name: identity.computerId,
        uid: sandboxUid, controller: true }] },
      spec: { volumeName }, status: { phase: 'Bound' } });
    volumes.set(volumeName, { kind: 'PersistentVolume',
      metadata: { name: volumeName, uid: volumeName, resourceVersion: '1' },
      spec: { claimRef: { namespace: 'owned', name: homeName, uid: homeName } },
      status: { phase: 'Bound' } });
  }
  function read(request: { resource: string; name?: string }) {
    if (request.resource === 'persistentvolumes') {
      return Promise.resolve(JSON.stringify(volumes.get(request.name!)));
    }
    if (request.resource === 'namespace') {
      const namespace = { kind: 'Namespace',
        metadata: { name: 'owned', uid: 'owned', resourceVersion: '1' } };
      return Promise.resolve(JSON.stringify(namespace));
    }
    let items: object[] = [];
    if (request.resource === 'sandboxes') items = sandboxes;
    if (request.resource === 'persistentvolumeclaims') items = claims;
    const list = { metadata: { resourceVersion: '1' }, items };
    return Promise.resolve(JSON.stringify(list));
  }
  type Binding = Parameters<Parameters<typeof collectComputerVolumeExport>[3]>[0];
  function contents(_binding: Binding, _signal: AbortSignal,
    home: Binding['volumes'][number]) {
    const bytes = Buffer.from(`private-home-canary-${home.computerId}`);
    const hash = createHash('sha256');
    hash.update(bytes);
    const input = { home, stream: Readable.from([bytes]), byteCount: bytes.length,
      sha256: hash.digest('hex') };
    return Promise.resolve(input);
  }
  async function collect(options: Options) {
    const scratch = await natsFixture({ provision: false });
    try {
      const settings = { ...options, directory: options.eventDirectory,
        destination: options.volumeDirectory, disposable: true, writersStopped: true,
        namespace: 'owned', namespaceUid: 'owned', kubeconfig: '/synthetic', context: 'owned' };
      return await collectComputerVolumeExport(source.connection, scratch.connection,
        settings, contents, read);
    } finally {
      await scratch.close();
    }
  }
  return collect;
}
