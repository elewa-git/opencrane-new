import { checkFresh } from './fresh-twice.ts';

type ExpectedPlacement = {
  namespace: string; namespaceUid: string; releaseSecretUid: string; installId: string;
  targetId: string; worktree: string; slot: string; startedAt: string; image: string;
  nodeUids: Record<string, string>;
};
type ObjectValue = Record<string, unknown>;

function requireEvidence(condition: unknown): asserts condition {
  if (!condition) throw new Error('NATS placement evidence refused');
}

function object(value: unknown): ObjectValue {
  requireEvidence(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as ObjectValue;
}

function array(value: unknown): unknown[] {
  requireEvidence(Array.isArray(value));
  return value as unknown[];
}

function items(value: unknown) {
  const values = array(object(value)['items']);
  return values.map(object);
}

function text(value: unknown): string {
  requireEvidence(typeof value === 'string' && value.length > 0);
  return value;
}

function metadata(value: ObjectValue) {
  return object(value['metadata']);
}

function unique(values: unknown[], count = 3) {
  requireEvidence(values.length === count && new Set(values).size === count);
  for (const value of values) text(value);
}

function recent(value: unknown, startedAt: string) {
  const timestamp = Date.parse(text(value));
  const start = Date.parse(startedAt);
  requireEvidence(Number.isFinite(start) && Number.isFinite(timestamp) && timestamp >= start);
}

function checkOwnership(input: ObjectValue, expected: ExpectedPlacement) {
  const namespace = metadata(object(input['namespace']));
  const annotations = object(namespace['annotations']);
  requireEvidence(namespace['name'] === expected.namespace &&
    namespace['uid'] === expected.namespaceUid &&
    annotations['opencrane.dev/worktree'] === expected.worktree &&
    annotations['opencrane.dev/slot'] === expected.slot);
  recent(namespace['creationTimestamp'], expected.startedAt);
  const release = metadata(object(input['release']));
  const labels = object(release['labels']);
  requireEvidence(release['uid'] === expected.releaseSecretUid &&
    release['namespace'] === expected.namespace &&
    labels['opencrane.dev/install-id'] === expected.installId);
  recent(release['creationTimestamp'], expected.startedAt);
}

function checkNodes(input: ObjectValue, expected: ExpectedPlacement) {
  const names: string[] = [];
  const uids: string[] = [];
  const hostnames: string[] = [];
  requireEvidence(Object.keys(expected.nodeUids).length === 3);
  for (const node of items(input['nodes'])) {
    requireEvidence(node['kind'] === 'Node');
    const details = metadata(node);
    const labels = object(details['labels']);
    const name = text(details['name']);
    const uid = text(details['uid']);
    requireEvidence(expected.nodeUids[name] === uid &&
      labels['opencrane.dev/target-id'] === expected.targetId);
    names.push(name);
    uids.push(uid);
    hostnames.push(text(labels['kubernetes.io/hostname']));
  }
  unique(names);
  unique(uids);
  unique(hostnames);
  return names;
}

function checkPrivate(input: ObjectValue) {
  const endpoints = items(input['endpoints']);
  requireEvidence(endpoints.length > 0);
  for (const endpoint of endpoints) {
    requireEvidence(endpoint['kind'] === 'Service');
    const spec = object(endpoint['spec']);
    requireEvidence(spec['type'] === 'ClusterIP' && !spec['loadBalancerIP']);
    requireEvidence(spec['externalIPs'] === undefined || array(spec['externalIPs']).length === 0);
    const annotations = metadata(endpoint)['annotations'];
    if (annotations) requireEvidence(!object(annotations)['tailscale.com/funnel']);
  }
  for (const pod of items(input['pods'])) {
    const spec = object(pod['spec']);
    requireEvidence(!spec['hostNetwork']);
    for (const value of array(spec['containers'])) {
      const ports = object(value)['ports'];
      if (!ports) continue;
      for (const port of array(ports)) requireEvidence(!object(port)['hostPort']);
    }
  }
}

function isNatsPod(pod: ObjectValue) {
  return object(metadata(pod)['labels'])['app'] === 'nats';
}

function ready(value: unknown) {
  const condition = object(value);
  return condition['type'] === 'Ready' && condition['status'] === 'True';
}

function checkPods(input: ObjectValue, expected: ExpectedPlacement, nodes: string[]) {
  const allPods = items(input['pods']);
  const pods = allPods.filter(isNatsPod);
  const placements: string[] = [];
  const peers: string[] = [];
  const claims: string[] = [];
  const podUids: string[] = [];
  const placementsByPeer = [];
  for (const pod of pods) {
    requireEvidence(pod['kind'] === 'Pod');
    const details = metadata(pod);
    requireEvidence(details['namespace'] === expected.namespace);
    recent(details['creationTimestamp'], expected.startedAt);
    const peer = text(object(details['labels'])['peer']);
    requireEvidence(details['name'] === `${peer}-0`);
    const spec = object(pod['spec']);
    const node = text(spec['nodeName']);
    requireEvidence(nodes.includes(node));
    const containers = array(spec['containers']);
    requireEvidence(containers.length === 1 && object(containers[0])['image'] === expected.image);
    const volumes = array(spec['volumes']);
    const data = volumes.filter(isDataVolume);
    requireEvidence(data.length === 1);
    const claim = object(object(data[0])['persistentVolumeClaim']);
    claims.push(text(claim['claimName']));
    requireEvidence(array(object(pod['status'])['conditions']).some(ready));
    placements.push(node);
    peers.push(peer);
    const podUid = text(details['uid']);
    podUids.push(podUid);
    placementsByPeer.push({ peer, node, podUid, claimName: text(claim['claimName']) });
  }
  unique(placements);
  unique(peers);
  unique(claims);
  unique(podUids);
  return { peers, claims, placementsByPeer };
}

function isDataVolume(value: unknown) {
  return object(value)['name'] === 'data';
}

function checkClaims(input: ObjectValue, expected: ExpectedPlacement, names: string[]) {
  const uids: string[] = [];
  const volumes: string[] = [];
  for (const claim of items(input['claims'])) {
    const details = metadata(claim);
    if (!names.includes(text(details['name']))) continue;
    requireEvidence(claim['kind'] === 'PersistentVolumeClaim' &&
      details['namespace'] === expected.namespace && object(claim['status'])['phase'] === 'Bound');
    recent(details['creationTimestamp'], expected.startedAt);
    uids.push(text(details['uid']));
    volumes.push(text(object(claim['spec'])['volumeName']));
  }
  unique(uids);
  unique(volumes);
  return uids;
}

function checkStream(value: unknown, peers: string[]) {
  const stream = object(value);
  const config = object(stream['config']);
  requireEvidence(config['name'] === 'EVENTS' && config['num_replicas'] === 3 &&
    config['storage'] === 'file' && config['retention'] === 'limits');
  const cluster = object(stream['cluster']);
  const names = [text(cluster['leader'])];
  for (const value of array(cluster['replicas'])) {
    const replica = object(value);
    requireEvidence(replica['current'] === true && replica['lag'] === 0 && replica['offline'] !== true);
    names.push(text(replica['name']));
  }
  unique(names);
  for (const name of names) requireEvidence(peers.includes(name));
  return { leader: names[0], replicas: names.slice(1) };
}

export function checkNatsPlacement(value: unknown, expected: ExpectedPlacement) {
  try {
    const input = object(value);
    checkOwnership(input, expected);
    const nodes = checkNodes(input, expected);
    checkPrivate(input);
    const { peers, claims, placementsByPeer } = checkPods(input, expected, nodes);
    const claimUids = checkClaims(input, expected, claims);
    const stream = checkStream(input['stream'], peers);
    const fresh = object(input['fresh']);
    requireEvidence(fresh['installId'] === expected.installId &&
      fresh['startedAt'] === expected.startedAt);
    // Reuse the check for old data; keep the browser journey as a separate requirement.
    checkFresh(fresh as Parameters<typeof checkFresh>[0]);
    const freshClaims = array(fresh['pvcs']);
    const freshUids = freshClaims.map(freshClaimUid);
    for (const uid of claimUids) requireEvidence(freshUids.includes(uid));
    return { namespaceUid: expected.namespaceUid, releaseSecretUid: expected.releaseSecretUid,
      installId: expected.installId, image: expected.image, nodeUids: Object.values(expected.nodeUids),
      placementsByPeer, claimUids, stream, replicas: 3, storage: 'file', retention: 'limits' };
  } catch {
    throw new Error('NATS placement evidence refused');
  }
}

function freshClaimUid(value: unknown) {
  return text(object(value)['uid']);
}
