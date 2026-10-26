import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkNatsPlacement } from './nats-placement.ts';
import { fixture } from './nats-placement-fixture.ts';


function accepts() {
  const { evidence, expected } = fixture();
  const summary = checkNatsPlacement(evidence, expected);
  assert.deepEqual(Reflect.get(summary.stream, 'limits'), {
    max_msgs: -1, max_bytes: -1, max_age: 0, max_msgs_per_subject: -1,
  });
}
test('accepts three Kubernetes placements and the inherited fresh-state check', accepts);

const mutations: Array<[string, (state: ReturnType<typeof fixture>) => void]> = [
  ['missing data mount', function missingMount({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.volumeMounts.shift();
  }],
  ['wrong claim mount', function wrongMount({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.volumeMounts[0]!.name = 'other';
  }],
  ['ephemeral store directory', function ephemeralStore({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.env[0]!.value = '/tmp';
  }],
  ['store outside mounted claim', function outsideMount({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.volumeMounts[0]!.mountPath = '/elsewhere';
  }],
  ['store CLI override', function overrideStore({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.args.push('--store_dir', '/tmp');
  }],
  ['overridden server command', function overrideCommand({ evidence }) {
    Object.assign(evidence.pods.items[0]!.spec.containers[0], { command: ['/other-server'] });
  }],
  ['changed mounted configuration', function changedConfig({ evidence }) {
    evidence.configuration.clients['nats-settings'] = 'jetstream { store_dir: /tmp }';
  }],
  ['changed cluster configuration', function changedCluster({ evidence }) {
    evidence.configuration.cluster += '\njetstream { store_dir: /tmp }';
  }],
  ['different projected config', function differentConfig({ evidence }) {
    evidence.pods.items[0]!.spec.volumes[1]!.projected!.sources[0]!.configMap!.name = 'other';
  }],
  ['mount covering the store', function shadowStore({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.volumeMounts.push({
      name: 'other', mountPath: '/data/jetstream',
    });
  }],
  ['read-only data mount', function readOnlyStore({ evidence }) {
    Object.assign(evidence.pods.items[0]!.spec.containers[0]!.volumeMounts[0], { readOnly: true });
  }],
  ['message retention limit', function limitedMessages({ evidence }) {
    evidence.stream.config.max_msgs = 1;
  }],
  ['byte retention limit', function limitedBytes({ evidence }) {
    evidence.stream.config.max_bytes = 1;
  }],
  ['one-second retention', function limitedAge({ evidence }) {
    evidence.stream.config.max_age = 1_000_000_000;
  }],
  ['per-subject retention limit', function limitedSubject({ evidence }) {
    evidence.stream.config.max_msgs_per_subject = 1;
  }],
  ['missing retention limit', function missingLimit({ evidence }) {
    Reflect.deleteProperty(evidence.stream.config, 'max_msgs');
  }],
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
  ['R1', function r1({ evidence }) {
    evidence.stream.config.num_replicas = 1;
  }],
  ['lagging replica', function lagging({ evidence }) {
    evidence.stream.cluster.replicas[0]!.lag = 1;
  }],
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
  ['stale release', function staleRelease({ evidence }) {
    evidence.release.metadata.creationTimestamp = '2026-10-25T10:00:00Z';
  }],
  ['stale storage', function staleStorage({ evidence }) {
    evidence.claims.items[0]!.metadata.creationTimestamp = '2026-10-25T10:00:00Z';
  }],
  ['retained data', function retainedData({ evidence }) {
    evidence.fresh.rowCounts.memory_facts = 1;
  }],
  ['foreign freshness record', function foreignFreshness({ evidence }) {
    evidence.fresh.installId = 'other-install';
  }],
  ['public service', function publicService({ evidence }) {
    evidence.endpoints.items[0]!.spec.type = 'LoadBalancer';
  }],
  ['public address', function externalAddress({ evidence }) {
    Object.assign(evidence.endpoints.items[0]!.spec, { externalIPs: ['203.0.113.1'] });
  }],
  ['public ingress', function ingress({ evidence }) {
    evidence.endpoints.items[0]!.kind = 'Ingress';
  }],
  ['host listener', function hostListener({ evidence }) {
    Object.assign(evidence.pods.items[0]!.spec, { hostNetwork: true });
  }],
  ['unreviewed image', function unreviewedImage({ evidence }) {
    evidence.pods.items[0]!.spec.containers[0]!.image = 'nats:latest';
  }],
  ['missing Kubernetes nodes', function missingNodes({ evidence }) {
    evidence.nodes.items = [];
  }],
];
for (const [name, mutate] of mutations) {
  function refuses() {
    const state = fixture();
    mutate(state);
    function check() {
      checkNatsPlacement(state.evidence, state.expected);
    }
    assert.throws(check);
  }
  test(`refuses ${name}`, refuses);
}

function privateErrors() {
  const { evidence, expected } = fixture();
  evidence.fresh.memberIds = ['PRIVATE-CANARY'];
  function check() {
    checkNatsPlacement(evidence, expected);
  }
  assert.throws(check, { message: 'NATS placement evidence refused' });
}
test('withholds private input from refusal errors', privateErrors);

for (const id of ['owner', '1']) {
  function collectorGuard() {
    const temporary = mkdtempSync(join(tmpdir(), 'nats-placement-'));
    const destination = join(temporary, 'evidence.json');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: temporary, DEV_STACK_ID: id };
    delete env['DEV_STACK_DIR'];
    delete env['OPENCRANE_FLEET_TASK'];
    try {
      const args = ['--experimental-strip-types', 'infra/package/nats-placement-collect.ts',
        'PRIVATE-CANARY', 'PRIVATE-CANARY', destination];
      const result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 15_000 });
      assert.equal(result.status, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, 'NATS placement collection refused\n');
      assert.equal(existsSync(destination), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  test(`collector refuses ${id} without a recorded target`, collectorGuard);
}
