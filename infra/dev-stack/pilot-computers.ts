import { setTimeout as delay } from 'node:timers/promises';
import { assertComputerLabels, assertHomeOwnership, isFullySuspended } from
  '../../apps/ops/src/kubernetes.ts';
import { ownedKubectl, type PackageOwner } from './packaged.ts';

type Computer = {
  metadata: { name: string; uid: string; resourceVersion: string };
  spec: { operatingMode?: string; podTemplate: { metadata: { labels: Record<string, string> };
    spec: { containers: Array<{ name: string; image: string }> } } };
};
export type SavedComputer = { name: string; uid: string; image: string; mode: string };

async function readComputer(owner: PackageOwner, saved: SavedComputer) {
  const text = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'sandbox', saved.name,
    '-o', 'json']);
  const computer = JSON.parse(text) as Computer;
  if (computer.metadata.uid !== saved.uid) throw new Error('The computer identity changed');
  return computer;
}

export async function recordComputers(owner: PackageOwner): Promise<SavedComputer[]> {
  const text = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'sandboxes', '-o', 'json']);
  const list = JSON.parse(text) as { items: Computer[] };
  const result: SavedComputer[] = [];
  for (const computer of list.items) {
    const { name, uid } = computer.metadata;
    const labels = computer.spec.podTemplate.metadata.labels;
    assertComputerLabels(computer, name, labels['sandbox.users.io/assistant'] ?? '');
    const mode = computer.spec.operatingMode ?? 'Running';
    const container = computer.spec.podTemplate.spec.containers[0];
    if (!container || container.name !== 'computer' || !['Running', 'Suspended'].includes(mode)) {
      throw new Error('The computer has an unsupported container or operating mode');
    }
    const saved = { name, uid, image: container.image, mode };
    result.push(saved);
  }
  return result;
}

async function patchComputer(owner: PackageOwner, saved: SavedComputer, patch: object) {
  const computer = await readComputer(owner, saved);
  const metadata = { uid: saved.uid, resourceVersion: computer.metadata.resourceVersion };
  const replacement = { metadata, spec: patch };
  const contents = JSON.stringify(replacement);
  await ownedKubectl(owner, ['-n', owner.namespace, 'patch', 'sandbox', saved.name,
    '--type=merge', '-p', contents]);
}

async function suspendedComputer(owner: PackageOwner, saved: SavedComputer) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const computer = await readComputer(owner, saved);
    const pod = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pod', saved.name,
      '--ignore-not-found', '-o', 'name']);
    if (isFullySuspended(computer) && !pod) return computer;
    await delay(500);
  }
  throw new Error('The computer did not stop before its image update');
}

export async function replaceComputerImages(owner: PackageOwner, saved: SavedComputer[],
  image?: string) {
  // Stop the watcher so it cannot resume a computer halfway through its replacement.
  await ownedKubectl(owner, ['-n', owner.namespace, 'scale', 'deployment/worker-computers',
    '--replicas=0']);
  await ownedKubectl(owner, ['-n', owner.namespace, 'wait', '--for=delete', 'pod',
    '-l', 'app=worker-computers', '--timeout=60s'], 70_000);
  for (const computer of saved) {
    const paused = { operatingMode: 'Suspended' };
    await patchComputer(owner, computer, paused);
    const stopped = await suspendedComputer(owner, computer);
    const pvc = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pvc',
      `home-${computer.name}`, '-o', 'json']);
    assertHomeOwnership(JSON.parse(pvc), stopped, computer.name);
    const podTemplate = structuredClone(stopped.spec.podTemplate);
    podTemplate.spec.containers[0]!.image = image ?? computer.image;
    const replacement = { podTemplate };
    await patchComputer(owner, computer, replacement);
  }
  // Let the restarted worker choose Running or Suspended from the saved lifecycle events.
}

export async function checkComputerImages(owner: PackageOwner, saved: SavedComputer[],
  image?: string) {
  for (const computer of saved) {
    const current = await readComputer(owner, computer);
    if (current.spec.podTemplate.spec.containers[0]?.image !== (image ?? computer.image)) {
      throw new Error('The computer image differs from the recorded update');
    }
    if ((current.spec.operatingMode ?? 'Running') === 'Running') {
      await ownedKubectl(owner, ['-n', owner.namespace, 'wait', '--for=condition=Ready',
        `pod/${computer.name}`, '--timeout=120s'], 130_000);
      const actual = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pod', computer.name,
        '-o', 'jsonpath={.status.containerStatuses[0].imageID}']);
      const expected = (image ?? computer.image).split('@')[1];
      if (!expected || !actual.endsWith(expected)) throw new Error('The running computer image differs');
    }
  }
}
