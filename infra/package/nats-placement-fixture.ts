import { readFileSync } from 'node:fs';

export function fixture() {
  const startedAt = '2026-10-26T10:00:00Z';
  const createdAt = '2026-10-26T10:01:00Z';
  const expected = {
    namespace: 'opencrane-package-1', namespaceUid: 'namespace-new',
    releaseSecretUid: 'release-new', installId: 'install-new', targetId: 'target-new',
    worktree: '/fixture/worktree', slot: '1', startedAt, image: 'nats@sha256:reviewed',
    clientConfig: readFileSync('infra/nats/nats.conf', 'utf8'),
    clusterConfig: readFileSync('infra/nats/cluster.conf', 'utf8'),
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
    spec: { nodeName: `node-${index}`, containers: [{ name: 'nats', image: expected.image,
      args: ['-c', '/etc/nats/cluster.conf'],
      env: [{ name: 'NATS_STORE_DIR', value: '/data' }],
      volumeMounts: [{ name: 'data', mountPath: '/data' },
        { name: 'config', mountPath: '/etc/nats', readOnly: true }],
    }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `data-${index}` } },
        { name: 'config', projected: { sources: [
          { configMap: { name: 'nats-cluster' } },
          { secret: { name: 'nats-settings', items: [{ key: 'nats.conf', path: 'nats.conf' }] } },
        ] } }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] } });
    claims.push({ kind: 'PersistentVolumeClaim',
      metadata: { name: `data-${index}`, uid: `claim-${index}`,
        namespace: expected.namespace, creationTimestamp: createdAt },
      spec: { volumeName: `volume-${index}` }, status: { phase: 'Bound' } });
  }
  function freshClaim(index: number) {
    return { uid: `claim-${index}`, createdAt };
  }
  const evidence = {
    namespace: { kind: 'Namespace', metadata: { name: expected.namespace,
      uid: expected.namespaceUid, creationTimestamp: createdAt,
      annotations: { 'opencrane.dev/worktree': expected.worktree, 'opencrane.dev/slot': '1' } } },
    release: { metadata: { uid: expected.releaseSecretUid, namespace: expected.namespace,
      creationTimestamp: createdAt, labels: { 'opencrane.dev/install-id': expected.installId } } },
    configuration: { cluster: expected.clusterConfig,
      clients: { 'nats-settings': expected.clientConfig } },
    nodes: { items: nodes }, pods: { items: pods }, claims: { items: claims },
    endpoints: { items: [{ kind: 'Service', metadata: {}, spec: { type: 'ClusterIP' } }] },
    stream: { config: { name: 'EVENTS', num_replicas: 3, storage: 'file', retention: 'limits',
      max_msgs: -1, max_bytes: -1, max_age: 0, max_msgs_per_subject: -1 },
      cluster: { leader: 'nats-0', replicas: [
        { name: 'nats-1', current: true, lag: 0, offline: false },
        { name: 'nats-2', current: true, lag: 0, offline: false },
      ] } },
    fresh: { installId: expected.installId, startedAt, previousPvcUids: [], pvClaims: [],
      pvcs: [0, 1, 2].map(freshClaim), events: [], storeId: 'store-new',
      memberIds: ['jente-rosseel'], siloEvents: [], rowCounts: {
        conversations: 0, conversation_files: 0, memory_facts: 0, memory_changes: 0,
        memory_dependencies: 0, memory_maintenance_runs: 0, memory_maintenance_bindings: 0,
      } },
  };
  return { evidence, expected };
}
