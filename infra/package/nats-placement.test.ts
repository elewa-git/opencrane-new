import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNatsPlacement } from './nats-placement.ts';

function fixture() {
  const startedAt = '2026-10-26T10:00:00Z';
  const createdAt = '2026-10-26T10:01:00Z';
  const expected = {
    namespace: 'opencrane-package-1', namespaceUid: 'namespace-new',
    releaseSecretUid: 'release-new', installId: 'install-new', targetId: 'target-new',
    worktree: '/fixture/worktree', slot: '1', startedAt, image: 'nats@sha256:reviewed',
    nodeUids: { 'node-0': 'node-id-0', 'node-1': 'node-id-1', 'node-2': 'node-id-2' },
  };
  const nodes = [];
  const pods = [];
  const claims = [];
  for (let index = 0; index < 3; index++) {
    nodes.push({ kind: 'Node', metadata: { name: `node-${index}`, uid: `node-id-${index}`,
      labels: { 'opencrane.dev/target-id': expected.targetId,
        'kubernetes.io/hostname': `host-${index}` } } });
    pods.push({ kind: 'Pod', metadata: { name: `nats-${index}-0`, uid: `pod-${index}`,
      namespace: expected.namespace, creationTimestamp: createdAt,
      labels: { app: 'nats', peer: `nats-${index}` } },
    spec: { nodeName: `node-${index}`, containers: [{ name: 'nats', image: expected.image }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `data-${index}` } }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] } });
    claims.push({ kind: 'PersistentVolumeClaim',
      metadata: { name: `data-${index}`, uid: `claim-${index}`,
        namespace: expected.namespace, creationTimestamp: createdAt },
      spec: { volumeName: `volume-${index}` }, status: { phase: 'Bound' } });
  }
  const evidence = {
    namespace: { kind: 'Namespace', metadata: { name: expected.namespace,
      uid: expected.namespaceUid, creationTimestamp: createdAt,
      annotations: { 'opencrane.dev/worktree': expected.worktree, 'opencrane.dev/slot': '1' } } },
    release: { metadata: { uid: expected.releaseSecretUid, namespace: expected.namespace,
      creationTimestamp: createdAt, labels: { 'opencrane.dev/install-id': expected.installId } } },
    nodes: { items: nodes }, pods: { items: pods }, claims: { items: claims },
    endpoints: { items: [{ kind: 'Service', spec: { type: 'ClusterIP' } }] },
    stream: { config: { name: 'EVENTS', num_replicas: 3, storage: 'file', retention: 'limits' },
      cluster: { leader: 'nats-0', replicas: [
        { name: 'nats-1', current: true, lag: 0, offline: false },
        { name: 'nats-2', current: true, lag: 0, offline: false },
      ] } },
    fresh: { installId: expected.installId, startedAt, previousPvcUids: [], pvClaims: [],
      pvcs: [{ uid: 'claim-new', createdAt }], events: [], storeId: 'store-new',
      memberIds: ['jente-rosseel'], siloEvents: [], rowCounts: {
        conversations: 0, conversation_files: 0, memory_facts: 0, memory_changes: 0,
        memory_dependencies: 0, memory_maintenance_runs: 0, memory_maintenance_bindings: 0,
      } },
  };
  return { evidence, expected };
}

test('accepts three Kubernetes placements and the inherited fresh-state check', function accepts() {
  const { evidence, expected } = fixture();
  checkNatsPlacement(evidence, expected);
});

const mutations: Array<[string, (state: ReturnType<typeof fixture>) => void]> = [
  ['repeated node name', function repeatNode({ evidence }) {
    evidence.pods.items[1]!.spec.nodeName = 'node-0';
  }],
  ['repeated node UID', function repeatNodeUid({ evidence }) {
    evidence.nodes.items[1]!.metadata.uid = 'node-id-0';
  }],
  ['repeated hostname', function repeatHostname({ evidence }) {
    evidence.nodes.items[1]!.metadata.labels['kubernetes.io/hostname'] = 'host-0';
  }],
  ['repeated peer identity', function repeatPeer({ evidence }) {
    evidence.pods.items[1]!.metadata.labels.peer = 'nats-0';
  }],
  ['repeated PVC UID', function repeatClaim({ evidence }) {
    evidence.claims.items[1]!.metadata.uid = 'claim-0';
  }],
  ['repeated volume', function repeatVolume({ evidence }) {
    evidence.claims.items[1]!.spec.volumeName = 'volume-0';
  }],
  ['shared claim', function shareClaim({ evidence }) {
    evidence.pods.items[1]!.spec.volumes[0]!.persistentVolumeClaim.claimName = 'data-0';
  }],
  ['R1', function r1({ evidence }) { evidence.stream.config.num_replicas = 1; }],
  ['lagging replica', function lagging({ evidence }) { evidence.stream.cluster.replicas[0]!.lag = 1; }],
  ['not current', function notCurrent({ evidence }) {
    evidence.stream.cluster.replicas[0]!.current = false;
  }],
  ['offline replica', function offline({ evidence }) {
    evidence.stream.cluster.replicas[0]!.offline = true;
  }],
  ['repeated stream peer', function repeatStreamPeer({ evidence }) {
    evidence.stream.cluster.replicas[0]!.name = evidence.stream.cluster.leader;
  }],
  ['foreign namespace', function foreignNamespace({ evidence }) {
    evidence.namespace.metadata.annotations['opencrane.dev/worktree'] = '/foreign';
  }],
  ['foreign target', function foreignTarget({ evidence }) {
    evidence.nodes.items[0]!.metadata.labels['opencrane.dev/target-id'] = 'foreign';
  }],
  ['foreign release', function foreignRelease({ evidence }) {
    evidence.release.metadata.labels['opencrane.dev/install-id'] = 'foreign';
  }],
  ['stale storage', function staleStorage({ evidence }) {
    evidence.claims.items[0]!.metadata.creationTimestamp = '2026-10-25T10:00:00Z';
  }],
  ['retained data', function retainedData({ evidence }) { evidence.fresh.rowCounts.memory_facts = 1; }],
  ['foreign freshness record', function foreignFreshness({ evidence }) {
    evidence.fresh.installId = 'other-install';
  }],
  ['public service', function publicService({ evidence }) {
    evidence.endpoints.items[0]!.spec.type = 'LoadBalancer';
  }],
  ['unreviewed image', function unreviewedImage({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.image = 'nats:latest';
  }],
  ['missing Kubernetes nodes', function missingNodes({ evidence }) { evidence.nodes.items = []; }],
];
for (const [name, mutate] of mutations) {
  test(`refuses ${name}`, function refuses() {
    const state = fixture();
    mutate(state);
    assert.throws(function check() { checkNatsPlacement(state.evidence, state.expected); });
  });
}
