import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export type K3dComputer = {
  kind: 'k3d';
  namespace: string;
  namespaceUid: string;
  podName: string;
  podUid: string;
  nodeName: string;
  nodeUid: string;
  nodeContainerId: string;
  containerName: 'computer';
  containerId: string;
  image: string;
  runtime: 'io.containerd.runsc.v1';
  startedAt: string;
  criStartedAt: string;
};

type Observations = {
  namespace: unknown;
  pod: unknown;
  node: unknown;
  dockerNode: unknown;
  criContainer: unknown;
  criPod: unknown;
};

const fullId = /^[a-f0-9]{64}$/u;
const imageRef = /^\S+@sha256:[a-f0-9]{64}$/u;
const safeName = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u;
const changed = 'private_process_identity_changed';
const unreadable = 'private_process_unreadable';

function field(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = Reflect.get(current, key) as unknown;
  }
  return current;
}

function matching(value: unknown, expected: unknown): void {
  if (value !== expected) {
    throw new Error(changed);
  }
}

function emptyArgument(value: string): boolean {
  return value === '';
}

function checkedTarget(target: K3dComputer): void {
  if (!safeName.test(target.namespace) || !safeName.test(target.podName) ||
      !safeName.test(target.nodeName) || !fullId.test(target.nodeContainerId) ||
      !fullId.test(target.containerId) || !imageRef.test(target.image) ||
      target.containerName !== 'computer' || target.runtime !== 'io.containerd.runsc.v1' ||
      !target.namespaceUid || !target.podUid || !target.nodeUid || !target.startedAt ||
      !target.criStartedAt) {
    throw new Error(unreadable);
  }
}

export function verifyK3dComputer(target: K3dComputer, seen: Observations): K3dComputer {
  checkedTarget(target);
  matching(field(seen.namespace, 'metadata', 'uid'), target.namespaceUid);
  matching(field(seen.pod, 'metadata', 'uid'), target.podUid);
  matching(field(seen.pod, 'metadata', 'namespace'), target.namespace);
  matching(field(seen.pod, 'spec', 'nodeName'), target.nodeName);
  matching(field(seen.pod, 'spec', 'runtimeClassName'), 'gvisor');
  matching(field(seen.node, 'metadata', 'uid'), target.nodeUid);
  matching(field(seen.node, 'metadata', 'name'), target.nodeName);
  matching(field(seen.dockerNode, 'Id'), target.nodeContainerId);
  matching(field(seen.dockerNode, 'State', 'Running'), true);
  matching(field(seen.pod, 'status', 'phase'), 'Running');
  const containers = field(seen.pod, 'spec', 'containers');
  const statuses = field(seen.pod, 'status', 'containerStatuses');
  if (!Array.isArray(containers) || containers.length !== 1 ||
      field(containers[0], 'name') !== target.containerName ||
      !Array.isArray(statuses) || statuses.length !== 1) {
    throw new Error(changed);
  }
  const status: unknown = statuses[0];
  matching(field(status, 'name'), target.containerName);
  matching(field(status, 'ready'), true);
  matching(field(status, 'restartCount'), 0);
  matching(field(status, 'containerID'), `containerd://${target.containerId}`);
  matching(field(status, 'imageID'), target.image);
  matching(field(status, 'state', 'running', 'startedAt'), target.startedAt);
  matching(field(seen.criContainer, 'status', 'id'), target.containerId);
  matching(field(seen.criContainer, 'status', 'state'), 'CONTAINER_RUNNING');
  matching(field(seen.criContainer, 'status', 'imageRef'), target.image);
  matching(field(seen.criContainer, 'status', 'startedAt'), target.criStartedAt);
  matching(field(seen.criContainer, 'status', 'labels', 'io.kubernetes.pod.uid'), target.podUid);
  matching(field(seen.criContainer, 'status', 'labels', 'io.kubernetes.container.name'),
    target.containerName);
  const sandboxId = field(seen.criContainer, 'info', 'sandboxID');
  if (typeof sandboxId !== 'string' || !fullId.test(sandboxId)) {
    throw new Error(changed);
  }
  matching(field(seen.criPod, 'status', 'id'), sandboxId);
  matching(field(seen.criPod, 'status', 'state'), 'SANDBOX_READY');
  matching(field(seen.criPod, 'status', 'metadata', 'uid'), target.podUid);
  matching(field(seen.criPod, 'status', 'metadata', 'namespace'), target.namespace);
  matching(field(seen.criPod, 'status', 'runtimeHandler'), 'runsc');
  matching(field(seen.criPod, 'info', 'runtimeType'), target.runtime);
  matching(field(seen.criContainer, 'info', 'runtimeType'), target.runtime);
  return target;
}

function readJson(program: string, args: string[]): unknown {
  const options = { timeout: 10_000, maxBuffer: 1_048_576, stdio: 'pipe' as const };
  const output = execFileSync(program, args, options);
  return JSON.parse(output.toString('utf8')) as unknown;
}

export function readK3dComputer(target: K3dComputer): K3dComputer {
  checkedTarget(target);
  try {
    const scope = ['--context=k3d-ocn', '-n', target.namespace];
    const namespace = readJson('/usr/local/bin/kubectl',
      ['--context=k3d-ocn', 'get', 'namespace', target.namespace, '-o', 'json']);
    const pod = readJson('/usr/local/bin/kubectl',
      [...scope, 'get', 'pod', target.podName, '-o', 'json']);
    const node = readJson('/usr/local/bin/kubectl',
      ['--context=k3d-ocn', 'get', 'node', target.nodeName, '-o', 'json']);
    const dockerNode = readJson('/usr/bin/docker',
      ['--host', 'unix:///var/run/docker.sock', 'inspect', '--type', 'container',
        target.nodeContainerId]);
    const criContainer = readJson('/usr/bin/docker',
      ['--host', 'unix:///var/run/docker.sock', 'exec', target.nodeContainerId,
        'crictl', 'inspect', target.containerId]);
    const sandboxId = field(criContainer, 'info', 'sandboxID');
    if (typeof sandboxId !== 'string' || !fullId.test(sandboxId)) {
      throw new Error(changed);
    }
    const criPod = readJson('/usr/bin/docker',
      ['--host', 'unix:///var/run/docker.sock', 'exec', target.nodeContainerId,
        'crictl', 'inspectp', sandboxId]);
    if (!Array.isArray(dockerNode) || dockerNode.length !== 1) {
      throw new Error(changed);
    }
    return verifyK3dComputer(target, {
      namespace, pod, node, dockerNode: dockerNode[0], criContainer, criPod,
    });
  } catch (error) {
    if (error instanceof Error && error.message === changed) {
      throw error;
    }
    throw new Error(unreadable, { cause: error });
  }
}

export function computerExecCommand(target: K3dComputer, args: string[]): string[] {
  checkedTarget(target);
  if (args.length === 0 || args.some(emptyArgument)) {
    throw new Error(unreadable);
  }
  return ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', target.nodeContainerId,
    'crictl', 'exec', '-i', target.containerId,
    '/usr/bin/timeout', '-s', 'KILL', '120',
    '/usr/bin/env', '-u', 'NODE_OPTIONS', '-u', 'NODE_PATH', '-u', 'LD_PRELOAD',
    '--', ...args];
}

export function spawnComputerExec(target: K3dComputer, args: string[]):
  ChildProcessWithoutNullStreams {
  readK3dComputer(target);
  const command = computerExecCommand(target, args);
  return spawn('/usr/bin/docker', command, { stdio: 'pipe' });
}
