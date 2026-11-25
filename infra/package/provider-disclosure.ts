import assert from 'node:assert/strict';
import { z } from 'zod';

export function assertNoBrowserDisclosure(secrets: readonly string[], body: string): void {
  for (const secret of secrets) {
    assert(!body.includes(secret), 'An API reply disclosed a key');
  }
}

type ArtifactReader = {
  readLocalValues: () => Promise<string>;
  readInstalledValues: () => Promise<string>;
  kube: (args: string[]) => Promise<string>;
};

function checkArtifact(content: string, secrets: readonly string[], source: string,
  requireContent = true): void {
  assert(!requireContent || content.trim(), `Missing ${source} evidence`);
  for (const secret of secrets) {
    assert(!content.includes(secret), 'A public artifact disclosed a key');
  }
}

const resourceName = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/u);
const containerName = z.object({ name: resourceName });
const containerStatus = containerName.extend({ restartCount: z.int().nonnegative() });
const podList = z.object({
  items: z.array(z.object({
    metadata: z.object({ name: resourceName, labels: z.object({ app: z.string() }) }),
    spec: z.object({ containers: z.array(containerName), initContainers: z.array(containerName)
      .default([]) }),
    status: z.object({ containerStatuses: z.array(containerStatus),
      initContainerStatuses: z.array(containerStatus).default([]) }),
  })),
});
type Pod = z.infer<typeof podList>['items'][number];

async function checkPodLogs(pod: Pod, reader: ArtifactReader, secrets: readonly string[]) {
  const { spec, status } = pod;
  const containers = [...spec.containers, ...spec.initContainers];
  const statuses = [...status.containerStatuses, ...status.initContainerStatuses];
  let previousLogs = 0;
  for (const container of containers) {
    const { name } = container;
    function sameContainer(entry: z.infer<typeof containerStatus>) {
      return entry.name === name;
    }
    const current = statuses.find(sameContainer);
    assert(current, 'Missing container status evidence');
    const args = ['logs', pod.metadata.name, '-c', name, '--tail=-1'];
    const content = await reader.kube(args);
    // A successful read is enough for init containers that may write no output.
    const appContainer = spec.containers.includes(container);
    checkArtifact(content, secrets, 'current container log', appContainer);
    if (current.restartCount > 0) {
      const previousArgs = [...args, '--previous'];
      const previous = await reader.kube(previousArgs);
      checkArtifact(previous, secrets, 'previous container log');
      previousLogs++;
    }
  }
  return { currentLogs: containers.length, previousLogs };
}

function requireContainers(pods: Pod[], app: string, names: string[]): void {
  function belongsToApp(pod: Pod): boolean {
    return pod.metadata.labels.app === app;
  }
  const matching = pods.filter(belongsToApp);
  assert(matching.length > 0, 'Missing expected pod evidence');
  for (const pod of matching) {
    const namesInPod = Array.from(pod.spec.containers, containerNameOf);
    for (const name of names) {
      assert(namesInPod.includes(name), 'Missing expected container evidence');
    }
  }
}

function containerNameOf(container: z.infer<typeof containerName>): string {
  return container.name;
}

async function checkRunningLogs(reader: ArtifactReader, secrets: readonly string[]) {
  const args = ['get', 'pods', '-l', 'app in (server,model-qualification)', '-o', 'json'];
  const content = await reader.kube(args);
  checkArtifact(content, secrets, 'pod list');
  const { items } = podList.parse(JSON.parse(content));
  requireContainers(items, 'server', ['server', 'models']);
  requireContainers(items, 'model-qualification', ['stand-in']);
  let checkedCurrentLogs = 0;
  let checkedPreviousLogs = 0;
  for (const pod of items) {
    const checked = await checkPodLogs(pod, reader, secrets);
    checkedCurrentLogs += checked.currentLogs;
    checkedPreviousLogs += checked.previousLogs;
  }
  return { checkedCurrentLogs, checkedPreviousLogs };
}

const valuesEvidence = z.record(z.string(), z.unknown());
const manifestEvidence = z.object({ items: z.array(z.unknown()).min(1) });

function checkValues(content: string, secrets: readonly string[], source: string): void {
  checkArtifact(content, secrets, source);
  const values = valuesEvidence.parse(JSON.parse(content));
  assert(Object.keys(values).length > 0, `Missing ${source} evidence`);
}

export async function checkProviderArtifacts(reader: ArtifactReader, secrets: readonly string[]) {
  const values = await reader.readLocalValues();
  checkValues(values, secrets, 'local values');
  const installed = await reader.readInstalledValues();
  checkValues(installed, secrets, 'installed values');
  const manifests = await reader.kube(
    ['get', 'deployment,statefulset,cronjob,job,configmap', '-o', 'json']);
  checkArtifact(manifests, secrets, 'manifest');
  manifestEvidence.parse(JSON.parse(manifests));
  return checkRunningLogs(reader, secrets);
}
