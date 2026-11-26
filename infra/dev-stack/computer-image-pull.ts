import { ComputerImagePullRefused } from './package-error.ts';

type NodeIdentity = { name: string; uid: string };
type KubernetesNode = {
  metadata: NodeIdentity;
  spec?: { unschedulable?: boolean; taints?: Array<{ effect: string }> };
};
type NodeList = { items: KubernetesNode[] };

const perHookSeconds = 150;

function blocksComputerPod(taint: { effect: string }) {
  return taint.effect === 'NoSchedule' || taint.effect === 'NoExecute';
}

function acceptsComputerPods(node: KubernetesNode) {
  // Match nodes that accept ordinary Pods. Computers have no extra tolerations.
  return !node.spec?.unschedulable && !node.spec?.taints?.some(blocksComputerPod);
}

function nodeIdentity(node: KubernetesNode) {
  return node.metadata;
}

export function computerPullNodes(output: string) {
  const nodes = JSON.parse(output) as NodeList;
  const eligible = nodes.items.filter(acceptsComputerPods);
  return eligible.map(nodeIdentity);
}

function nodeName(node: NodeIdentity) {
  return node.name;
}

export function computerPullArguments(nodes: NodeIdentity[]) {
  const names = nodes.map(nodeName);
  const plannedNodes = JSON.stringify(names);
  return ['--set-json', `computerImagePullNodes=${plannedNodes}`, '--timeout', `${perHookSeconds}s`];
}

export function computerPullProcessTimeout(nodes: NodeIdentity[]) {
  // Give each serial hook time to clear an old Job, complete, and delete after success.
  const hookSeconds = nodes.length * perHookSeconds * 3;
  const releaseSeconds = 120;
  return (hookSeconds + releaseSeconds) * 1000;
}

export function checkComputerPullCoverage(planned: NodeIdentity[], current: NodeIdentity[]) {
  const pulledNodes = new Map<string, string>();
  for (const node of planned) {
    pulledNodes.set(node.name, node.uid);
  }
  if (current.length === 0) {
    throw new ComputerImagePullRefused({ reason: 'NoComputerNodes' });
  }
  for (const node of current) {
    if (pulledNodes.get(node.name) !== node.uid) {
      throw new ComputerImagePullRefused({ reason: 'NodeBecameAvailable' });
    }
  }
}
