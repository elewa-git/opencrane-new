import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { sharedCertificates, certificates, issueCertificate }
  from '../../libs/event-store/test/certificates.ts';
import { parseAllDocuments } from 'yaml';

const execute = promisify(execFile);

function chartValues() {
  const digest = 'a'.repeat(64);
  const images = {};
  const secrets = {};
  for (const name of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer', 'objects', 'scanner']) {
    images[name] = `example.invalid/${name}@sha256:${digest}`;
  }
  for (const name of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap', 'objects', 'scanner']) {
    secrets[name] = `chart-test-${name.toLowerCase()}`;
  }
  const exposure = { ingress: false, loadBalancer: false, funnel: false };
  return { chartVersion: '0.1.0', images, secrets, exposure,
    scanner: { approvedSha: 'c'.repeat(64) } };
}

function rendersOnlyManifests() {
  const values = chartValues();
  const options = { encoding: 'utf8', input: JSON.stringify(values) };
  const argumentsList = ['template', 'chart-test', 'infra/package/chart', '--values', '-'];
  const result = spawnSync('helm', argumentsList, options);
  assert.equal(result.error, undefined, 'Helm must be installed to check the real package chart.');
  assert.equal(result.status, 0, result.stderr);

  const sources = result.stdout.matchAll(/^# Source: (.+)$/gm);
  let sourceCount = 0;
  for (const source of sources) {
    assert.match(source[1], /\/templates\/.+\.ya?ml$/u);
    sourceCount++;
  }
  assert.ok(sourceCount > 0, 'The chart must render Kubernetes resources.');

  const documents = parseAllDocuments(result.stdout);
  for (const document of documents) {
    assert.deepEqual(document.errors, []);
    const resource = document.toJS();
    assert.equal(typeof resource?.apiVersion, 'string');
    assert.equal(typeof resource?.kind, 'string');
    assert.equal(typeof resource?.metadata?.name, 'string');
    if (resource.metadata.name === 'worker-dispatcher') {
      const worker = resource.spec.template.spec.containers[0];
      const bindings = new Map();
      for (const setting of worker.env) bindings.set(setting.name, setting.valueFrom);
      assert.equal(bindings.get('DATABASE_URL').secretKeyRef.key, 'HANDLER_DATABASE_URL');
      assert.deepEqual(bindings.get('CONTENT_DATABASE_URL').secretKeyRef,
        { name: values.secrets.runtime, key: 'DATABASE_URL' });
    }
  }
}

test('the real package chart renders only Kubernetes manifests', rendersOnlyManifests);

function upgradeKeepsTheFinishedBootstrapImage() {
  const values = chartValues();
  const priorImage = `example.invalid/server@sha256:${'b'.repeat(64)}`;
  values.bootstrapImage = priorImage;
  const resources = renderedResources(values, ['--is-upgrade']);
  const bootstrap = resources.get('Job/bootstrap').spec.template.spec;
  assert.equal(bootstrap.initContainers[0].image, priorImage);
  assert.equal(bootstrap.containers[0].image, priorImage);
  const backup = resources.get('CronJob/pilot-backup').spec.jobTemplate.spec.template.spec;
  assert.equal(backup.containers[0].image, values.images.server);
  const server = resources.get('Deployment/server').spec.template.spec.containers[0];
  const scannerDigest = server.env.find(function scannerBinding(setting) {
    return setting.name === 'SCANNER_MANIFEST_DIGEST';
  });
  assert.equal(scannerDigest?.value, `sha256:${values.scanner.approvedSha}`);
}

test('an application update keeps the finished bootstrap Job on its original image',
  upgradeKeepsTheFinishedBootstrapImage);

function updateStopsWritersBeforeRestartingComputers() {
  const values = chartValues();
  values.pilotUpdatePaused = true;
  const resources = renderedResources(values, ['--is-upgrade']);
  for (const [name, resource] of resources) {
    if (name === 'Deployment/server' || name.startsWith('Deployment/worker-')) {
      assert.equal(resource.spec.replicas, 0, `${name} stays stopped during computer replacement`);
    }
  }
  assert.equal(resources.get('Deployment/web').spec.replicas, 1);
  assert.equal(resources.get('StatefulSet/postgres').spec.replicas, 1);
}

test('the update keeps writers stopped while replacing computer images',
  updateStopsWritersBeforeRestartingComputers);

function cnpgValues() {
  const values = chartValues();
  values.postgres = {
    mode: 'cnpg', operatorContract: '1.30',
    superuserSecret: 'cnpg-superuser', applicationSecret: 'cnpg-projection',
  };
  values.images.postgres = `example.invalid/cnpg-postgres:17.6@sha256:${'b'.repeat(64)}`;
  return values;
}

function clusterValues() {
  const values = chartValues();
  values.natsCluster = {
    enabled: true, renderOnly: true, routeCASecret: 'route-issuer',
    peerCertificateSecrets: ['route-peer-0', 'route-peer-1', 'route-peer-2'],
  };
  return values;
}

function renderChart(values, chart = 'infra/package/chart', flags = []) {
  const options = { encoding: 'utf8', input: JSON.stringify(values) };
  const args = ['template', 'chart-test', chart,
    '--namespace', 'cluster-test', '--values', '-', ...flags];
  const result = spawnSync('helm', args, options);
  assert.equal(result.error, undefined);
  return result;
}

function renderedResources(values, flags = []) {
  const result = renderChart(values, 'infra/package/chart', flags);
  assert.equal(result.status, 0, result.stderr);
  return chartResources(result.stdout);
}

function chartResources(render) {
  const resources = new Map();
  for (const document of parseAllDocuments(render)) {
    assert.deepEqual(document.errors, []);
    const resource = document.toJS();
    resources.set(`${resource.kind}/${resource.metadata.name}`, resource);
  }
  return resources;
}

function checkPullJob(job, image) {
  const annotations = job.metadata.annotations;
  assert.equal(annotations['helm.sh/hook'], 'pre-install');
  assert.equal(annotations['helm.sh/hook-delete-policy'], 'before-hook-creation,hook-succeeded');
  assert.equal(job.spec.backoffLimit, 0);
  assert.equal(job.spec.activeDeadlineSeconds, 120);
  assert.equal(job.spec.ttlSecondsAfterFinished, 120);
  const pod = job.spec.template.spec;
  assert.equal(pod.runtimeClassName, 'gvisor');
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.serviceAccountName, undefined);
  assert.equal(pod.volumes, undefined);
  assert.equal(pod.restartPolicy, 'Never');
  const [puller] = pod.containers;
  assert.equal(puller.image, image);
  assert.equal(puller.imagePullPolicy, 'IfNotPresent');
  assert.deepEqual(puller.command, ['/bin/true']);
  const security = puller.securityContext;
  assert.equal(security.runAsUser, 65534);
  assert.equal(security.runAsNonRoot, true);
  assert.equal(security.allowPrivilegeEscalation, false);
  assert.equal(security.readOnlyRootFilesystem, true);
  assert.deepEqual(security.capabilities, { drop: ['ALL'] });
  assert.equal(puller.volumeMounts, undefined);
}

function pullsOnInstall() {
  const values = chartValues();
  const resources = renderedResources(values);
  const computerTemplate = resources.get('SandboxTemplate/computer');
  const computer = computerTemplate.spec.podTemplate.spec;
  assert.equal(computer.runtimeClassName, 'gvisor');
  assert.equal(computer.containers[0].image, values.images.computer);
  const container = computer.containers[0];
  assert.match(container.image, /@sha256:[a-f0-9]{64}$/u);
  // Kubernetes defaults a digest-pinned container to IfNotPresent.
  const policy = container.imagePullPolicy ?? 'IfNotPresent';
  assert.equal(policy, 'IfNotPresent');
  const job = resources.get('Job/computer-image-prepull');
  assert.ok(job, 'Offline approval checks must see the Job image');
  checkPullJob(job, values.images.computer);
}

function skipsPullOnUpgrade() {
  const values = chartValues();
  const flags = ['--is-upgrade'];
  const resources = renderedResources(values, flags);
  for (const name of resources.keys()) {
    assert.ok(!name.startsWith('Job/computer-image-prepull'),
      'The install-only image pull Jobs must be absent on upgrade');
  }
}

test('the chart pulls the pinned computer image before install', pullsOnInstall);
test('the chart omits the install-only pull Jobs on upgrade', skipsPullOnUpgrade);

function checkJobPlacement(job, pulledNodes) {
  const affinity = job.spec.template.spec.affinity.nodeAffinity;
  const selector = affinity.requiredDuringSchedulingIgnoredDuringExecution;
  const [term] = selector.nodeSelectorTerms;
  const [field] = term.matchFields;
  assert.equal(field.key, 'metadata.name');
  assert.equal(field.operator, 'In');
  assert.equal(field.values.length, 1);
  pulledNodes.push(field.values[0]);
}

function pullsOnAllComputerNodes() {
  const values = chartValues();
  const plannedNodes = ['node-a', 'node-b'];
  const flags = ['--set-json', `computerImagePullNodes=${JSON.stringify(plannedNodes)}`];
  const resources = renderedResources(values, flags);
  const pulledNodes = [];
  for (const [name, job] of resources) {
    if (!name.startsWith('Job/computer-image-prepull')) {
      continue;
    }
    assert.match(job.metadata.name, /^computer-image-prepull-[a-f0-9]{12}$/u);
    checkPullJob(job, values.images.computer);
    checkJobPlacement(job, pulledNodes);
  }
  assert.deepEqual(pulledNodes.sort(), plannedNodes);
}

function refusesWhenThereAreNoComputerNodes() {
  const values = chartValues();
  const flags = ['--set-json', 'computerImagePullNodes=[]'];
  const result = renderChart(values, 'infra/package/chart', flags);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Computer image pre-pull needs a node that accepts computer Pods/u);
}

test('the install chart renders a hardened Job on each planned node', pullsOnAllComputerNodes);
test('the install chart refuses an empty node list', refusesWhenThereAreNoComputerNodes);

function dispatcherCpuBudget() {
  const resources = renderedResources(chartValues());
  const dispatcher = resources.get('Deployment/worker-dispatcher');
  const dispatcherWorker = dispatcher.spec.template.spec.containers[0];
  assert.equal(dispatcherWorker.resources.limits.cpu, '1000m');
  assert.equal(dispatcherWorker.resources.requests.cpu, '100m');

  const conversations = resources.get('Deployment/worker-conversations');
  const conversationWorker = conversations.spec.template.spec.containers[0];
  assert.equal(conversationWorker.resources.limits.cpu, '300m');
  assert.equal(conversationWorker.resources.requests.cpu, '20m');
}

test('the packaged dispatcher can use a full CPU while projection workers keep their budget',
  dispatcherCpuBudget);

function postgresStatefulSet(resource) {
  return resource.kind === 'StatefulSet' && resource.metadata.name === 'postgres';
}

function cnpgCluster(resource) {
  return resource.kind === 'Cluster' && resource.apiVersion === 'postgresql.cnpg.io/v1';
}

function defaultPostgresRemains() {
  const resources = renderedResources(chartValues());
  const databases = [...resources.values()].filter(postgresStatefulSet);
  assert.equal(databases.length, 1);
  assert.equal(databases[0].spec.replicas, 1);
  assert.equal([...resources.values()].filter(cnpgCluster).length, 0);
}
test('the default still runs one PostgreSQL StatefulSet', defaultPostgresRemains);

function twoInstanceCluster() {
  const values = cnpgValues();
  const resources = renderedResources(values);
  assert.equal([...resources.values()].filter(postgresStatefulSet).length, 0);
  const clusters = [...resources.values()].filter(cnpgCluster);
  assert.equal(clusters.length, 1);
  const cluster = clusters[0];
  assert.equal(cluster.metadata.name, 'postgres');
  assert.equal(cluster.spec.instances, 2);
  assert.equal(cluster.spec.imageName, values.images.postgres);
  assert.deepEqual(cluster.spec.storage, {
    size: '1Gi', pvcTemplate: { accessModes: ['ReadWriteOnce'] },
  });
  assert.deepEqual(cluster.spec.affinity, {
    enablePodAntiAffinity: true, podAntiAffinityType: 'required',
    topologyKey: 'kubernetes.io/hostname',
  });
  assert.deepEqual(cluster.spec.resources, {
    requests: { cpu: '50m', memory: '64Mi' }, limits: { cpu: '500m', memory: '384Mi' },
  });
  assert.equal(cluster.spec.enableSuperuserAccess, true);
  assert.deepEqual(cluster.spec.superuserSecret, { name: 'cnpg-superuser' });
  assert.deepEqual(cluster.spec.bootstrap.initdb, {
    database: 'projections', owner: 'projection', secret: { name: 'cnpg-projection' },
  });
  const writer = resources.get('Service/postgres');
  assert.equal(writer.spec.type, 'ClusterIP');
  assert.deepEqual(writer.spec.ports, [{ port: 5432, targetPort: 5432 }]);
  assert.deepEqual(writer.spec.selector, {
    'cnpg.io/cluster': 'postgres', 'cnpg.io/instanceRole': 'primary',
  });
  const primary = { 'cnpg.io/cluster': 'postgres', 'cnpg.io/instanceRole': 'primary' };
  const standby = { ...primary, 'cnpg.io/instanceRole': 'replica' };
  const foreign = { ...primary, 'cnpg.io/cluster': 'other' };
  assert.equal(matchesSelector(writer.spec.selector, primary), true);
  assert.equal(matchesSelector(writer.spec.selector, standby), false);
  assert.equal(matchesSelector(writer.spec.selector, foreign), false);
  for (const resource of resources.values()) {
    if (resource.kind === 'Service') {
      assert.equal(resource.spec.type, 'ClusterIP');
    }
    assert.notEqual(resource.kind, 'Secret');
  }
}

function matchesSelector(selector, labels) {
  for (const [name, value] of Object.entries(selector)) {
    if (labels[name] !== value) {
      return false;
    }
  }
  return true;
}
test('CNPG requires separate claims and nodes and sends writers only to primary', twoInstanceCluster);

const renderRefusals = [
  ['operatorContract', '', /Unsupported CNPG operator contract/u],
  ['operatorContract', 'unknown', /Unsupported CNPG operator contract/u],
  ['operatorContract', '1.28', /Unsupported CNPG operator contract/u],
  ['superuserSecret', '', /Missing CNPG credential reference/u],
  ['applicationSecret', '', /Missing CNPG credential reference/u],
  ['superuserSecret', 'chart-test-postgres', /Separate CNPG credential references/u],
  ['mode', 'unknown', /Unsupported PostgreSQL mode/u],
  ['storage', null, /Unsupported PostgreSQL setting/u],
  ['affinity', { podAntiAffinityType: 'preferred' }, /Unsupported PostgreSQL setting/u],
];
for (const [field, value, expected] of renderRefusals) {
  function refusesIncompleteCluster() {
    const values = cnpgValues();
    values.postgres[field] = value;
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  test(`Helm refuses CNPG with invalid ${field}: ${JSON.stringify(value)}`, refusesIncompleteCluster);
}

for (const exposure of ['ingress', 'loadBalancer', 'funnel', 'mutable']) {
  function refusesUnsafeCluster() {
    const values = cnpgValues();
    let expected = /Public ingress/u;
    if (exposure === 'mutable') {
      values.images.postgres = 'example.invalid/cnpg-postgres:latest';
      expected = /Missing immutable image pin/u;
    } else {
      values.exposure[exposure] = true;
    }
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  test(`Helm refuses CNPG ${exposure}`, refusesUnsafeCluster);
}

function peerEnvironment(peer) {
  const env = {};
  for (const setting of peer.spec.template.spec.containers[0].env) {
    env[setting.name] = setting.value;
  }
  return env;
}

function peerDns(index) {
  return `nats-${index}-0.nats-routes.cluster-test.svc.cluster.local`;
}

function threePrivatePeers() {
  const values = clusterValues();
  const resources = renderedResources(values);
  const claims = new Set();
  const names = new Set();
  for (let index = 0; index < 3; index++) {
    const peer = resources.get(`StatefulSet/nats-${index}`);
    assert.ok(peer, 'Each named peer must exist');
    const spec = peer.spec.template.spec;
    assert.equal(peer.spec.replicas, 1);
    assert.equal(peer.spec.serviceName, 'nats-routes');
    assert.deepEqual(peer.spec.selector.matchLabels, { app: 'nats', peer: `nats-${index}` });
    assert.deepEqual(peer.spec.template.metadata.labels, peer.spec.selector.matchLabels);
    assert.equal(peer.spec.volumeClaimTemplates.length, 1);
    const claim = peer.spec.volumeClaimTemplates[0];
    assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
    assert.equal(claim.spec.resources.requests.storage, '1Gi');
    claims.add(`${claim.metadata.name}-${peer.metadata.name}-0`);
    const placement = spec.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution;
    assert.deepEqual(placement, [{ topologyKey: 'kubernetes.io/hostname',
      labelSelector: { matchLabels: { app: 'nats' } } }]);
    const container = spec.containers[0];
    assert.deepEqual(container.args, ['-c', '/etc/nats/cluster.conf']);
    assert.ok(container.volumeMounts.some(isDataMount));
    assert.deepEqual(container.readinessProbe.tcpSocket, { port: 4222 });
    const mountedSecrets = new Map();
    for (const volume of spec.volumes) {
      if (volume.secret) mountedSecrets.set(volume.name, volume.secret.secretName);
    }
    assert.equal(mountedSecrets.get('route-ca'), values.natsCluster.routeCASecret);
    assert.equal(mountedSecrets.get('route-identity'), values.natsCluster.peerCertificateSecrets[index]);
    assert.equal(mountedSecrets.size, 3);
    assert.deepEqual(container.volumeMounts, [
      { name: 'data', mountPath: '/data' },
      { name: 'config', mountPath: '/etc/nats', readOnly: true },
      { name: 'settings', mountPath: '/tls', readOnly: true },
      { name: 'route-ca', mountPath: '/route-ca', readOnly: true },
      { name: 'route-identity', mountPath: '/route-identity', readOnly: true },
    ]);
    for (const mount of container.volumeMounts) {
      if (mount.name !== 'data') assert.equal(mount.readOnly, true);
    }
    const configuration = spec.volumes.find(isConfigurationVolume);
    assert.deepEqual(configuration.projected.sources, [
      { configMap: { name: 'nats-cluster' } },
      { secret: { name: values.secrets.nats, items: [{ key: 'nats.conf', path: 'nats.conf' }] } },
    ]);
    const env = peerEnvironment(peer);
    names.add(env.NATS_SERVER_NAME);
    assert.equal(env.NATS_ROUTE_ADVERTISE, `${peerDns(index)}:6222`);
    const routes = [];
    for (let other = 0; other < 3; other++) {
      if (other !== index) routes.push(`nats-route://${peerDns(other)}:6222`);
    }
    assert.deepEqual([env.NATS_ROUTE_1, env.NATS_ROUTE_2], routes);
    assert.equal(env.NATS_STORE_DIR, '/data');
    assert.equal(env.NATS_ROUTE_CA_FILE, '/route-ca/ca.crt');
    assert.equal(env.NATS_ROUTE_CERT_FILE, '/route-identity/tls.crt');
    assert.equal(env.NATS_ROUTE_KEY_FILE, '/route-identity/tls.key');
  }
  assert.equal(claims.size, 3);
  assert.equal(names.size, 3);
  assert.equal(resources.has('StatefulSet/nats'), false);
  const bootstrap = resources.get('Job/bootstrap');
  assert.ok(bootstrap, 'The cluster preview needs the complete bootstrap Job');
  const ordinary = renderedResources(chartValues()).get('Job/bootstrap');
  assert.deepEqual(bootstrap, ordinary);
  const pod = bootstrap.spec.template.spec;
  assert.equal(pod.serviceAccountName, 'package-bootstrap');
  assert.deepEqual(pod.containers[0].command,
    ['node', '--experimental-strip-types', 'infra/package/bootstrap.ts']);
  assert.deepEqual(pod.containers[0].envFrom, [
    { secretRef: { name: values.secrets.runtime } },
    { secretRef: { name: values.secrets.bootstrap } },
  ]);
  assert.deepEqual(pod.containers[0].volumeMounts, [
    { name: 'runtime', mountPath: '/run/opencrane', readOnly: true },
    { name: 'runtime-files', mountPath: '/run/opencrane/files', readOnly: true },
  ]);
  assert.deepEqual(pod.volumes, [
    { name: 'runtime', secret: { secretName: values.secrets.runtime } },
    { name: 'runtime-files', emptyDir: { medium: 'Memory' } },
    { name: 'runtime-file-source',
      secret: { secretName: values.secrets.runtimeFiles, defaultMode: 256 } },
  ]);
  assert.equal(pod.initContainers[0].name, 'copy-private-files');
  const discovery = resources.get('Service/nats-routes');
  assert.equal(discovery.spec.clusterIP, 'None');
  assert.equal(discovery.spec.publishNotReadyAddresses, true);
  assert.deepEqual(discovery.spec.selector, { app: 'nats' });
  assert.deepEqual(discovery.spec.ports, [{ name: 'routes', port: 6222, targetPort: 6222 }]);
  const budget = resources.get('PodDisruptionBudget/nats');
  assert.equal(budget.spec.minAvailable, 2);
  assert.deepEqual(budget.spec.selector.matchLabels, { app: 'nats' });
  for (const resource of resources.values()) {
    if (resource.kind === 'Service') assert.equal(resource.spec.type, 'ClusterIP');
    assert.notEqual(resource.kind, 'Ingress');
    assert.notEqual(resource.kind, 'Gateway');
  }
}

function isConfigurationVolume(volume) {
  return volume.name === 'config';
}

function isDataMount(mount) {
  return mount.name === 'data' && mount.mountPath === '/data';
}

test('three private peers have separate claims, identities and required node placement',
  threePrivatePeers);

function defaultPeerUnchanged() {
  const resources = renderedResources(chartValues());
  const peer = resources.get('StatefulSet/nats');
  assert.equal(peer.spec.replicas, 1);
  assert.deepEqual(peer.spec.template.spec.containers[0].args, ['-c', '/etc/nats/nats.conf']);
  assert.equal(resources.has('Service/nats-routes'), false);
  assert.equal(resources.has('PodDisruptionBudget/nats'), false);
  assert.equal(resources.has('Job/bootstrap'), true);
}
test('default rendering retains one peer and the ordinary bootstrap', defaultPeerUnchanged);

const invalidClusters = [
  { renderOnly: "false" },
  { routeCASecret: '' },
  { routeCASecret: 'chart-test-nats' },
  { peerCertificateSecrets: [] },
  { peerCertificateSecrets: ['same', 'same', 'same'] },
  { peerCertificateSecrets: ['chart-test-nats', 'peer-1', 'peer-2'] },
  { peerCertificateSecrets: ['route-issuer', 'peer-1', 'peer-2'] },
  { peerCertificateSecrets: ['peer-0', '', 'peer-2'] },
];
for (const invalid of invalidClusters) {
  function refusesIncompleteCluster() {
    const values = clusterValues();
    Object.assign(values.natsCluster, invalid);
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NATS cluster/u);
  }
  test(`cluster rendering refuses ${JSON.stringify(invalid)}`, refusesIncompleteCluster);
}

async function validatesRenderedConfiguration() {
  const fetched = spawnSync('sh', ['scripts/fetch-nats.sh'], { encoding: 'utf8' });
  assert.equal(fetched.status, 0, 'The pinned NATS test server must be available');
  const resources = renderedResources(clusterValues());
  const config = resources.get('ConfigMap/nats-cluster').data['cluster.conf'];
  assert.equal(config, await readFile('infra/nats/cluster.conf', 'utf8'));
  assert.match(config, /verify_cert_and_check_known_urls: true/u);
  assert.doesNotMatch(config, /insecure|verify: false/u);
  const directory = await mkdtemp(join(tmpdir(), 'chart-nats-'));
  try {
    await sharedCertificates(directory);
    await mkdir(`${directory}/routes`, { mode: 0o700 });
    await certificates(`${directory}/routes`);
    await writeFile(`${directory}/cluster.conf`, config);
    await copyFile('infra/nats/nats.conf', `${directory}/nats.conf`);
    const clientEnv = { ...process.env, NATS_LISTEN: '0.0.0.0:4222',
      NATS_CA_FILE: `${directory}/ca.crt`, NATS_CERT_FILE: `${directory}/server.crt`,
      NATS_KEY_FILE: `${directory}/server.key` };
    for (const role of ['command', 'projection', 'dispatcher', 'computer', 'gateway']) {
      clientEnv[`NATS_${role.toUpperCase()}_NKEY`] = await readFile(`${directory}/${role}.pub`, 'utf8');
    }
    for (let index = 0; index < 3; index++) {
      const peer = resources.get(`StatefulSet/nats-${index}`);
      const env = { ...clientEnv, ...peerEnvironment(peer) };
      const extensions = `subjectAltName=DNS:${peerDns(index)}\n` +
        'extendedKeyUsage=serverAuth,clientAuth\n';
      await issueCertificate(`${directory}/routes`, `peer-${index}`, '/CN=peer', extensions);
      // Replace only mounted paths; keep the rendered names and route addresses verbatim.
      env.NATS_STORE_DIR = `${directory}/data-${index}`;
      env.NATS_ROUTE_CA_FILE = `${directory}/routes/ca.crt`;
      env.NATS_ROUTE_CERT_FILE = `${directory}/routes/peer-${index}.crt`;
      env.NATS_ROUTE_KEY_FILE = `${directory}/routes/peer-${index}.key`;
      const args = ['-t', '-c', `${directory}/cluster.conf`];
      const result = spawnSync('.tools/nats-server', args, { env, encoding: 'utf8' });
      assert.equal(result.status, 0, 'Pinned NATS must accept the rendered DNS and TLS configuration');
      env.NATS_ROUTE_CA_FILE = `${directory}/absent.crt`;
      assert.notEqual(spawnSync('.tools/nats-server', args, { env }).status, 0);
      env.NATS_ROUTE_CA_FILE = `${directory}/routes/ca.crt`;
      for (const name of ['NATS_ROUTE_CA_FILE', 'NATS_ROUTE_CERT_FILE', 'NATS_ROUTE_KEY_FILE',
        'NATS_ROUTE_1', 'NATS_ROUTE_2', 'NATS_CA_FILE']) {
        const incomplete = { ...env };
        delete incomplete[name];
        const refused = spawnSync('.tools/nats-server', args, { env: incomplete });
        assert.notEqual(refused.status, 0, `NATS must refuse missing ${name}`);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('pinned NATS validates rendered DNS and refuses missing route trust',
  validatesRenderedConfiguration);

async function refusesClusterInstallation() {
  const directory = await mkdtemp(join(tmpdir(), 'chart-install-'));
  try {
    const values = clusterValues();
    const review = { chartVersion: values.chartVersion, images: values.images,
      requiredSecrets: Object.keys(values.secrets) };
    await writeFile(`${directory}/values.json`, JSON.stringify(values));
    await writeFile(`${directory}/review.json`, JSON.stringify(review));
    const args = ['infra/package/preflight.mjs', `${directory}/values.json`,
      `${directory}/review.json`];
    const result = spawnSync('node', args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported NATS cluster setting/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('ordinary installer refuses preview-only cluster settings',
  refusesClusterInstallation);

function backupValues() {
  const values = cnpgValues();
  values.postgres.backup = {
    enabled: true,
    renderOnly: true,
    method: 'barmanObjectStore',
    destinationPath: 's3://database-backups/local-check',
    endpointURL: 'https://backup-store.cluster-test.svc:9000',
    endpointCA: { name: 'backup-trust', key: 'ca.crt' },
    s3Credentials: {
      accessKeyId: { name: 'backup-identity', key: 'ACCESS_KEY_ID' },
      secretAccessKey: { name: 'backup-identity', key: 'ACCESS_SECRET_KEY' },
      sessionToken: { name: 'backup-identity', key: 'SESSION_TOKEN' },
    },
  };
  return values;
}

function rendersSuspendedBackup() {
  const resources = renderedResources(backupValues());
  const cluster = resources.get('Cluster/postgres');
  assert.deepEqual(cluster.spec.backup, {
    barmanObjectStore: {
      destinationPath: 's3://database-backups/local-check',
      endpointURL: 'https://backup-store.cluster-test.svc:9000',
      endpointCA: { name: 'backup-trust', key: 'ca.crt' },
      s3Credentials: {
        accessKeyId: { name: 'backup-identity', key: 'ACCESS_KEY_ID' },
        secretAccessKey: { name: 'backup-identity', key: 'ACCESS_SECRET_KEY' },
        sessionToken: { name: 'backup-identity', key: 'SESSION_TOKEN' },
      },
      data: { encryption: 'AES256' },
      wal: { encryption: 'AES256' },
    },
  });
  const schedules = [];
  for (const resource of resources.values()) {
    if (resource.kind === 'ScheduledBackup') {
      schedules.push(resource);
    }
    if (resource.kind === 'Service') {
      assert.equal(resource.spec.type, 'ClusterIP');
    }
    for (const forbidden of ['Secret', 'Ingress', 'Gateway', 'Backup', 'CronJob']) {
      assert.notEqual(resource.kind, forbidden);
    }
  }
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].apiVersion, 'postgresql.cnpg.io/v1');
  assert.deepEqual(schedules[0].spec, {
    cluster: { name: 'postgres' }, method: 'barmanObjectStore',
    schedule: '0 0 0 * * *', suspend: true, immediate: false,
  });
}
test('CNPG renders encrypted local backup and WAL with one suspended schedule',
  rendersSuspendedBackup);

const privateBackupCanary = 'private-backup-value';
const backupRefusals = [
  ['standalone', ['mode'], 'standalone'],
  ['missing opt-in', ['backup', 'enabled'], undefined],
  ['disabled with settings', ['backup', 'enabled'], false],
  ['string opt-in', ['backup', 'enabled'], 'true'],
  ['missing render-only choice', ['backup', 'renderOnly'], undefined],
  ['installation requested', ['backup', 'renderOnly'], false],
  ['string render-only choice', ['backup', 'renderOnly'], 'true'],
  ['missing method', ['backup', 'method'], undefined],
  ['plugin method', ['backup', 'method'], 'plugin'],
  ['snapshot method', ['backup', 'method'], 'volumeSnapshot'],
  ['missing destination', ['backup', 'destinationPath'], undefined],
  ['HTTPS destination', ['backup', 'destinationPath'], 'https://bucket/prefix'],
  ['destination credentials', ['backup', 'destinationPath'],
    `s3://user:${privateBackupCanary}@bucket/prefix`],
  ['destination query', ['backup', 'destinationPath'], `s3://bucket/?key=${privateBackupCanary}`],
  ['destination fragment', ['backup', 'destinationPath'], `s3://bucket/#${privateBackupCanary}`],
  ['missing endpoint', ['backup', 'endpointURL'], undefined],
  ['plaintext endpoint', ['backup', 'endpointURL'], 'http://backup-store.cluster-test.svc'],
  ['external endpoint', ['backup', 'endpointURL'], 'https://storage.example.com'],
  ['foreign namespace', ['backup', 'endpointURL'], 'https://backup-store.other.svc'],
  ['endpoint credentials', ['backup', 'endpointURL'],
    `https://user:${privateBackupCanary}@backup-store.cluster-test.svc`],
  ['endpoint query', ['backup', 'endpointURL'],
    `https://backup-store.cluster-test.svc?key=${privateBackupCanary}`],
  ['endpoint fragment', ['backup', 'endpointURL'],
    `https://backup-store.cluster-test.svc#${privateBackupCanary}`],
  ['endpoint path', ['backup', 'endpointURL'], 'https://backup-store.cluster-test.svc/override'],
  ['inline credentials', ['backup', 'password'], privateBackupCanary],
  ['inline S3 credentials', ['backup', 's3Credentials', 'secretAccessKey'], privateBackupCanary],
  ['inherited IAM', ['backup', 's3Credentials', 'inheritFromIAMRole'], true],
  ['unsupported provider', ['backup', 'azureCredentials'], { value: privateBackupCanary }],
  ['base override', ['backup', 'data'], { encryption: '' }],
  ['WAL override', ['backup', 'wal'], { encryption: '' }],
  ['schedule override', ['backup', 'schedule'], '* * * * * *'],
  ['unsuspend override', ['backup', 'suspend'], false],
  ['immediate override', ['backup', 'immediate'], true],
  ['retention override', ['backup', 'retentionPolicy'], '1d'],
  ['invalid port', ['backup', 'endpointURL'], 'https://backup-store.cluster-test.svc:65536'],
  ['zero port', ['backup', 'endpointURL'], 'https://backup-store.cluster-test.svc:0'],
  ['missing S3 references', ['backup', 's3Credentials'], undefined],
  ['null S3 references', ['backup', 's3Credentials'], null],
  ['null backup', ['backup'], null],
  ['empty backup', ['backup'], {}],
  ['scalar backup', ['backup'], privateBackupCanary],
  ['array backup', ['backup'], []],
];
const referencePaths = [
  ['backup', 'endpointCA'],
  ['backup', 's3Credentials', 'accessKeyId'],
  ['backup', 's3Credentials', 'secretAccessKey'],
  ['backup', 's3Credentials', 'sessionToken'],
];
for (const path of referencePaths) {
  const referenceName = path.at(-1);
  backupRefusals.push([`${referenceName} missing`, path, undefined]);
  for (const field of ['name', 'key']) {
    for (const invalid of [undefined, '', 42, 'invalid/value']) {
      backupRefusals.push([`${referenceName} invalid ${field}: ${invalid}`,
        [...path, field], invalid]);
    }
  }
  backupRefusals.push([`${referenceName} inline value`, [...path, 'value'], privateBackupCanary]);
}
for (const [name, path, value] of backupRefusals) {
  function refusesBackup() {
    const values = backupValues();
    let parent = values.postgres;
    for (const key of path.slice(0, -1)) {
      parent = parent[key];
    }
    parent[path.at(-1)] = value;
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CNPG backup/u);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(privateBackupCanary));
  }
  test(`Helm refuses backup with ${name}`, refusesBackup);
}

function defaultHasNoBackup() {
  for (const values of [chartValues(), cnpgValues()]) {
    const resources = renderedResources(values);
    for (const resource of resources.values()) {
      assert.notEqual(resource.kind, 'ScheduledBackup');
      assert.equal(resource.spec?.backup, undefined);
    }
  }
}
test('default and ordinary CNPG renders contain no backup work', defaultHasNoBackup);

for (const contract of ['', '1.28', '1.32', 'unknown']) {
  function refusesBackupOperator() {
    const values = backupValues();
    values.postgres.operatorContract = contract;
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported CNPG operator contract/u);
    assert.equal(result.stdout, '');
  }
  test(`Helm refuses backup with operator contract ${contract}`, refusesBackupOperator);
}

function recoveryValues() {
  const values = backupValues();
  values.postgres.recovery = {
    ...values.postgres.backup,
    source: 'recorded-origin',
    serverName: 'postgres',
    recoveryTarget: { backupID: '20261026T120000', targetLSN: '0/7000028', targetTLI: '2' },
  };
  delete values.postgres.backup;
  return values;
}

function rendersExactRecovery() {
  const values = recoveryValues();
  const resources = renderedResources(values);
  const cluster = resources.get('Cluster/postgres');
  assert.deepEqual(cluster.spec.bootstrap, {
    recovery: {
      source: 'recorded-origin',
      database: 'projections', owner: 'projection', secret: { name: 'cnpg-projection' },
      recoveryTarget: { backupID: '20261026T120000', targetLSN: '0/7000028', targetTLI: '2' },
    },
  });
  assert.deepEqual(cluster.spec.superuserSecret, { name: 'cnpg-superuser' });
  const source = values.postgres.recovery;
  assert.deepEqual(cluster.spec.externalClusters, [{
    name: 'recorded-origin',
    barmanObjectStore: {
      serverName: 'postgres', destinationPath: source.destinationPath,
      endpointURL: source.endpointURL, endpointCA: source.endpointCA,
      s3Credentials: source.s3Credentials,
    },
  }]);
  assert.equal(cluster.spec.backup, undefined);
  for (const resource of resources.values()) {
    for (const forbidden of ['Secret', 'ScheduledBackup', 'Backup', 'CronJob', 'ObjectStore']) {
      assert.notEqual(resource.kind, forbidden);
    }
  }
  const ordinary = renderedResources(cnpgValues());
  ordinary.delete('Cluster/postgres');
  resources.delete('Cluster/postgres');
  assert.deepEqual(resources, ordinary);
  const rendered = renderChart(values);
  assert.doesNotMatch(rendered.stdout, /password:|secretAccessKey: [^\n]|latest|private-backup-value/u);
}
test('CNPG recovery renders one exact source and WAL target without an archive writer',
  rendersExactRecovery);

const recoveryRefusals = [
  ['missing source binding', ['recovery', 'source'], undefined],
  ['missing server name', ['recovery', 'serverName'], undefined],
  ['missing recovery target', ['recovery', 'recoveryTarget'], undefined],
  ['null recovery target', ['recovery', 'recoveryTarget'], null],
  ['array recovery target', ['recovery', 'recoveryTarget'], []],
  ['initdb alongside recovery', ['initdb'], {}],
  ['nested initdb', ['recovery', 'initdb'], {}],
  ['bootstrap override', ['bootstrap'], { initdb: {} }],
  ['external cluster override', ['externalClusters'], []],
  ['source backup writer', ['backup'], backupValues().postgres.backup],
  ['disabled backup writer', ['backup'], { enabled: false }],
  ['null backup writer', ['backup'], null],
  ['different operator', ['operatorContract'], '1.31'],
];
for (const field of ['source', 'serverName']) {
  for (const value of ['', 42, '../source', 'a'.repeat(64)]) {
    recoveryRefusals.push([`invalid ${field}: ${value}`, ['recovery', field], value]);
  }
}
const invalidTargets = {
  backupID: [undefined, '', 42, 'latest', '20261326T120000', '20261026T250000',
    '20260231T120000', '../backup'],
  targetLSN: [undefined, '', 42, 'latest', '0/XYZ', '100000000/1', '0/123456789', '0/1/2'],
  targetTLI: [undefined, '', 2, 'latest', 'current', '0', '-1', '1.5', '4294967296'],
};
for (const [field, invalidValues] of Object.entries(invalidTargets)) {
  for (const value of invalidValues) {
    recoveryRefusals.push([`invalid ${field}: ${value}`,
      ['recovery', 'recoveryTarget', field], value]);
  }
}
for (const field of ['targetTime', 'targetName', 'targetXID', 'targetImmediate', 'exclusive']) {
  recoveryRefusals.push([`extra target ${field}`, ['recovery', 'recoveryTarget', field], true]);
}
for (const [name, path, value] of backupRefusals) {
  const recoveryPath = [...path];
  if (recoveryPath[0] === 'backup') {
    recoveryPath[0] = 'recovery';
  }
  recoveryRefusals.push([name, recoveryPath, value]);
}
for (const [name, path, value] of recoveryRefusals) {
  function refusesRecovery() {
    const values = recoveryValues();
    let parent = values.postgres;
    for (const key of path.slice(0, -1)) {
      parent = parent[key];
    }
    parent[path.at(-1)] = value;
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CNPG|PostgreSQL/u);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(privateBackupCanary));
  }
  test(`Helm refuses recovery with ${name}`, refusesRecovery);
}

function preservesOtherExactRecoveryValues() {
  const values = recoveryValues();
  const recovery = values.postgres.recovery;
  recovery.source = 'another-origin';
  recovery.serverName = 'archived-postgres';
  recovery.recoveryTarget = {
    backupID: '20240229T235959', targetLSN: 'aB12/ffffffff', targetTLI: '4294967295',
  };
  const resources = renderedResources(values);
  const cluster = resources.get('Cluster/postgres');
  assert.equal(cluster.spec.bootstrap.recovery.source, recovery.source);
  assert.deepEqual(cluster.spec.bootstrap.recovery.recoveryTarget, recovery.recoveryTarget);
  assert.equal(cluster.spec.externalClusters[0].name, recovery.source);
  assert.equal(cluster.spec.externalClusters[0].barmanObjectStore.serverName, recovery.serverName);
}
test('CNPG recovery preserves other recorded names and target values',
  preservesOtherExactRecoveryValues);

function organisationSetting(variable) {
  return variable.name === 'ORGANISATION_NAME';
}

function rendersOrganisationName() {
  for (const name of ['', 'Acme & Sons']) {
    const values = { ...chartValues(), organisation: { name } };
    const options = { encoding: 'utf8', input: JSON.stringify(values) };
    const argumentsList = ['template', 'chart-test', 'infra/package/chart', '--values', '-'];
    const result = spawnSync('helm', argumentsList, options);
    assert.equal(result.status, 0, result.stderr);
    const documents = parseAllDocuments(result.stdout);
    let web;
    for (const document of documents) {
      const resource = document.toJS();
      if (resource.kind === 'Deployment' && resource.metadata.name === 'web') {
        web = resource.spec.template.spec.containers[0];
      }
    }
    assert.ok(web, 'The web deployment must exist');
    const setting = web.env?.find(organisationSetting);
    assert.deepEqual(setting, { name: 'ORGANISATION_NAME', value: name });
  }
}

test('the installation name reaches the web container', rendersOrganisationName);

function scheduledPilotBackup() {
  const values = chartValues();
  const result = spawnSync('helm', ['template', 'chart-test', 'infra/package/chart', '--values', '-'],
    { encoding: 'utf8', input: JSON.stringify(values) });
  assert.equal(result.status, 0, result.stderr);
  const documents = parseAllDocuments(result.stdout);
  const resources = [];
  for (const document of documents) resources.push(document.toJS());
  function backupSchedule(resource) {
    return resource.kind === 'CronJob' && resource.metadata.name === 'pilot-backup';
  }
  const cron = resources.find(backupSchedule);
  assert.ok(cron, 'The ordinary single-server package must schedule its coordinated backup.');
  assert.equal(cron.spec.concurrencyPolicy, 'Forbid');
  assert.equal(cron.spec.suspend, false);
  assert.equal(cron.spec.jobTemplate.spec.backoffLimit, 0);
  const job = cron.spec.jobTemplate.spec.template.spec;
  assert.equal(job.serviceAccountName, 'package-backup');
  const container = job.containers[0];
  assert.equal(container.image, values.images.server);
  assert.deepEqual(container.command,
    ['node', '--experimental-strip-types', 'infra/package/scheduled-backup-run.ts', 'run']);
  function backupVolume(volume) { return volume.name === 'backups'; }
  const volume = job.volumes.find(backupVolume);
  assert.equal(volume.persistentVolumeClaim.claimName, 'backups');
  assert.notEqual(volume.persistentVolumeClaim.claimName, 'data-objects-0');
  function backupRole(resource) {
    return resource.kind === 'Role' && resource.metadata.name === 'package-backup';
  }
  const role = resources.find(backupRole);
  function deploymentRead(rule) { return rule.resources.includes('deployments'); }
  const readiness = role.rules.find(deploymentRead);
  assert.deepEqual(readiness.verbs, ['get', 'list', 'watch']);
  assert.deepEqual(readiness.resourceNames, ['server', 'openfga', 'worker-dispatcher',
    'worker-members', 'worker-mcp-catalogue', 'worker-computers', 'worker-conversations',
    'worker-files', 'worker-budgets', 'worker-audit']);
  for (const rule of role.rules) assert.ok(!rule.resources.includes('secrets'));
}

test('the single-server package schedules a coordinated backup on separate storage',
  scheduledPilotBackup);

function keepsJournalBelowGroupManagedRoot() {
  const values = chartValues();
  values.pilotRestore = { enabled: true, backupId: 'saved-backup' };
  const args = ['template', 'chart-test', 'infra/package/chart', '--values', '-'];
  const result = spawnSync('helm', args, { encoding: 'utf8', input: JSON.stringify(values) });
  assert.equal(result.status, 0, result.stderr);
  let restore;
  for (const document of parseAllDocuments(result.stdout)) {
    const resource = document.toJS();
    if (resource.kind === 'CronJob' && resource.metadata.name === 'pilot-restore') {
      restore = resource.spec.jobTemplate.spec.template.spec;
    }
  }
  assert.ok(restore);
  assert.equal(restore.securityContext.fsGroupChangePolicy, 'OnRootMismatch');
  function privateDirectories(container) { return container.name === 'private-directories'; }
  const prepare = restore.initContainers.find(privateDirectories);
  // Keep the volume root group-managed so a remount leaves private child files untouched.
  assert.match(prepare.args[0], /mkdir -p \/restore\/state/u);
  assert.match(prepare.args[0], /chmod 0700 \/restore\/state/u);
  assert.doesNotMatch(prepare.args[0], /chmod 0700 \/restore(?:\s|&&)/u);
}

test('keeps the restore journal private when Kubernetes mounts its volume again',
  keepsJournalBelowGroupManagedRoot);

function publicModeUsesTokenWithoutExposure() {
  const values = chartValues();
  values.exposure.public = { enabled: true, host: 'pilot.example.test', tlsSecret: 'pilot-tls' };
  const resources = renderedResources(values);
  const server = resources.get('Deployment/server').spec.template.spec;
  const bootstrap = resources.get('Job/bootstrap').spec.template.spec;
  const tokenSetting = { name: 'BOOTSTRAP_TOKEN_FILE',
    value: '/var/lib/opencrane/bootstrap/token.json' };
  assert.ok(server.containers[0].env.some(isTokenSetting));
  function isTokenSetting(setting) {
    return setting.name === tokenSetting.name && setting.value === tokenSetting.value;
  }
  const ownerSetting = bootstrap.containers[0].env.find(isOwnerBootstrapSetting);
  function isOwnerBootstrapSetting(setting) {
    return setting.name === 'DEV_OWNER_BOOTSTRAP';
  }
  assert.deepEqual(ownerSetting, { name: 'DEV_OWNER_BOOTSTRAP', value: '0' });
  for (const resource of resources.values()) {
    assert.notEqual(resource.kind, 'Ingress');
    assert.notEqual(resource.kind, 'Gateway');
    if (resource.kind === 'Service') assert.equal(resource.spec.type, 'ClusterIP');
  }
  const source = server.initContainers.find(isPrivateFileCopy);
  function isPrivateFileCopy(container) {
    return container.name === 'copy-private-files';
  }
  assert.match(source.args[0], /chmod 0600 .*token.json/u);
  assert.match(source.args[0], /chmod 0700 .*bootstrap/u);
  assert.ok(server.containers[0].volumeMounts.some(isTokenVolume));
  function isTokenVolume(volume) {
    return volume.name === 'bootstrap-token' && volume.readOnly === true;
  }
}
test('public settings install uses the token path and keeps all network resources private',
  publicModeUsesTokenWithoutExposure);

for (const [name, field, value] of [
  ['missing hostname', 'host', ''], ['hostname with a scheme', 'host', 'https://pilot.example.test'],
  ['hostname with a port', 'host', 'pilot.example.test:443'], ['IP address', 'host', '127.0.0.1'],
  ['missing TLS reference', 'tlsSecret', ''], ['implicit choice', 'enabled', 'true'],
]) {
  function refusesPublicAddress() {
    const values = chartValues();
    values.exposure.public = { enabled: true, host: 'pilot.example.test', tlsSecret: 'pilot-tls' };
    values.exposure.public[field] = value;
    const rendered = renderChart(values);
    assert.equal(rendered.status, 1);
    assert.match(rendered.stderr, /Public address/u);
  }
  test(`chart refuses public address with ${name}`, refusesPublicAddress);
}

async function originalChartRender(values) {
  const directory = await mkdtemp(join(tmpdir(), 'original-package-chart-'));
  try {
    const baseline = '8b5e2dec78f1ba6769a12662848fa6c640068471';
    const args = ['archive', baseline, 'infra/package/chart'];
    const archive = spawnSync('git', args);
    assert.equal(archive.status, 0, 'The original chart must be available in repository history');
    const extractionArgs = ['-x', '-C', directory];
    const extractionOptions = { input: archive.stdout };
    const extracted = spawnSync('tar', extractionArgs, extractionOptions);
    assert.equal(extracted.status, 0, 'The original chart must be extracted without changes');
    const chart = join(directory, 'infra/package/chart');
    const result = renderChart(values, chart);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    const cleanup = { recursive: true, force: true };
    await rm(directory, cleanup);
  }
}

const keyVolumes = ['personal-secrets', 'memory-secrets'];
const keySettings = ['PERSONAL_KEY_DIRECTORY', 'MEMORY_KEY_DIRECTORY', 'MEMORY_PROJECTION_SCHEMA'];
const changedResources = [
  'PersistentVolumeClaim/personal-secrets', 'PersistentVolumeClaim/memory-secrets',
  'ServiceAccount/package-worker', 'Role/package-worker', 'RoleBinding/package-worker',
  'ServiceAccount/package-server', 'Role/package-server', 'RoleBinding/package-server',
  'ServiceAccount/package-dispatcher', 'Role/package-dispatcher', 'RoleBinding/package-dispatcher',
  'ServiceAccount/package-projection',
  'Role/package-computer-exec', 'RoleBinding/package-computer-exec',
  'ValidatingAdmissionPolicy/cluster-test-computer-exec',
  'ValidatingAdmissionPolicyBinding/cluster-test-computer-exec',
  'ValidatingAdmissionPolicy/cluster-test-computer-pod-name',
  'ValidatingAdmissionPolicyBinding/cluster-test-computer-pod-name',
];

function entriesWithout(entries, names) {
  function keep(entry) {
    return !names.includes(entry.name);
  }
  return entries.filter(keep);
}

function withoutKeyChanges(pod) {
  delete pod.securityContext.fsGroupChangePolicy;
  pod.initContainers = entriesWithout(pod.initContainers, ['private-member-keys', 'private-memory-keys']);
  pod.volumes = entriesWithout(pod.volumes, keyVolumes);
  pod.containers = entriesWithout(pod.containers, ['memory']);
  for (const container of pod.containers) {
    if (['server', 'worker'].includes(container.name)) {
      container.env = entriesWithout(container.env, keySettings);
      container.volumeMounts = entriesWithout(container.volumeMounts, keyVolumes);
    }
  }
}

function withoutAccountChanges(pod, name) {
  delete pod.serviceAccountName;
  if (name === 'server' || name === 'worker-dispatcher') {
    return;
  }
  delete pod.automountServiceAccountToken;
  pod.initContainers = entriesWithout(pod.initContainers, ['kubeconfig']);
  pod.volumes = entriesWithout(pod.volumes, ['kubeconfig']);
  const worker = pod.containers[0];
  worker.env = entriesWithout(worker.env, ['KUBECONFIG', 'KUBE_NAMESPACE']);
  worker.volumeMounts = entriesWithout(worker.volumeMounts, ['kubeconfig']);
}

function unchangedResources(render) {
  const resources = chartResources(render);
  for (const name of changedResources) {
    resources.delete(name);
  }
  for (const resource of resources.values()) {
    if (resource.kind !== 'Deployment') {
      continue;
    }
    const name = resource.metadata.name;
    const pod = resource.spec.template.spec;
    if (name === 'server' || name === 'worker-dispatcher' || name === 'worker-members') {
      withoutKeyChanges(pod);
    }
    if (name === 'server' || name.startsWith('worker-')) {
      withoutAccountChanges(pod, name);
    }
    if (name === 'server') {
      delete resource.spec.strategy;
    }
  }
  return resources;
}

async function defaultOnlyAddsMemberKeys() {
  const values = chartValues();
  const original = renderChart(values);
  assert.equal(original.status, 0, original.stderr);
  // Use the installed Helm for both charts because Helm 3 and 4 serialise YAML differently.
  const baseline = await originalChartRender(values);
  const originalResources = unchangedResources(original.stdout);
  const baselineResources = unchangedResources(baseline);
  assert.deepEqual(originalResources, baselineResources);
  values.models = { mode: 'stub' };
  assert.equal(renderChart(values).stdout, original.stdout);
}
test('default and explicit stub mode keep the original resources outside member key storage',
  defaultOnlyAddsMemberKeys);

function rendersOnboardingAndMemoryStorage() {
  const resources = renderedResources(chartValues());
  const serverDeployment = resources.get('Deployment/server');
  assert.deepEqual(serverDeployment.spec.strategy, { type: 'Recreate' });
  const server = serverDeployment.spec.template.spec;
  const members = resources.get('Deployment/worker-members').spec.template.spec;
  const dispatcher = resources.get('Deployment/worker-dispatcher').spec.template.spec;
  const projection = members.containers.find(isMemoryProjection);
  function isMemoryProjection(container) {
    return container.name === 'memory';
  }
  const personal = '/var/lib/opencrane/personal-secrets';
  const memory = '/var/lib/opencrane/memory-secrets';
  assert.ok(resources.has('PersistentVolumeClaim/personal-secrets'));
  assert.ok(resources.has('PersistentVolumeClaim/memory-secrets'));
  const keyGroup = { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' };
  assert.deepEqual(server.securityContext, keyGroup);
  assert.deepEqual(members.securityContext, keyGroup);
  assert.deepEqual(dispatcher.securityContext, keyGroup);
  assertKeySetup(server, 'private-member-keys', [personal, memory]);
  assertKeySetup(members, 'private-memory-keys', [memory]);
  assertKeySetup(dispatcher, 'private-memory-keys', [memory]);
  assertKeyDirectory(server, 'server', 'PERSONAL_KEY_DIRECTORY', personal);
  assertKeyDirectory(server, 'server', 'MEMORY_KEY_DIRECTORY', memory);
  assertKeyDirectory(dispatcher, 'worker', 'MEMORY_KEY_DIRECTORY', memory);
  assert.ok(projection, 'Run the Memory projection with the member worker');
  assertKeyDirectory(members, 'memory', 'MEMORY_KEY_DIRECTORY', memory, true);
  assert.deepEqual(keyReaders(resources, 'personal-secrets'), [
    'Deployment/server:private-member-keys', 'Deployment/server:server',
  ]);
  assert.deepEqual(keyReaders(resources, 'memory-secrets'), [
    'Deployment/server:private-member-keys', 'Deployment/server:server',
    'Deployment/worker-dispatcher:private-memory-keys', 'Deployment/worker-dispatcher:worker',
    'Deployment/worker-members:memory', 'Deployment/worker-members:private-memory-keys',
  ]);
}

function assertKeySetup(pod, name, paths) {
  function keySetup(container) {
    return container.name === name;
  }
  const setup = pod.initContainers.find(keySetup);
  assert.deepEqual(setup?.command, ['node', 'infra/package/provider-secrets.mjs',
    '--directory-only', ...paths]);
  assert.deepEqual(setup.securityContext, { runAsUser: 0, allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true });
}

function assertKeyDirectory(pod, name, variable, root, readOnly = false) {
  const pathParts = root.split('/');
  const volumeName = pathParts.at(-1);
  function namedContainer(container) {
    return container.name === name;
  }
  function namedSetting(setting) {
    return setting.name === variable;
  }
  function namedMount(mount) {
    return mount.name === volumeName;
  }
  const container = pod.containers.find(namedContainer);
  assert.equal(container.env.find(namedSetting)?.value, root + '/keys');
  const mount = container.volumeMounts.find(namedMount);
  assert.equal(mount?.mountPath, root);
  assert.equal(mount?.readOnly ?? false, readOnly);
  const volume = pod.volumes.find(namedMount);
  assert.equal(volume?.persistentVolumeClaim?.claimName, volumeName);
}

function keyReaders(resources, claimName) {
  function nameMount(mount) {
    return mount.workload + ':' + mount.container;
  }
  const mounts = keyMounts(resources, claimName);
  const readers = mounts.map(nameMount);
  return readers.sort();
}

function keyMounts(resources, claimName) {
  const mounts = [];
  for (const resource of resources.values()) {
    const pod = resource.kind === 'Pod' ? resource.spec :
      resource.spec?.jobTemplate?.spec?.template?.spec ?? resource.spec?.template?.spec;
    const claims = new Set();
    for (const volume of pod?.volumes ?? []) {
      const claim = volume.persistentVolumeClaim;
      if (claim?.claimName === claimName) {
        claims.add(volume.name);
      }
    }
    const containers = [...(pod?.initContainers ?? []), ...(pod?.containers ?? []),
      ...(pod?.ephemeralContainers ?? [])];
    for (const container of containers) {
      for (const mount of container.volumeMounts ?? []) {
        if (claims.has(mount.name)) {
          const workload = resource.kind + '/' + resource.metadata.name;
          mounts.push({ workload, container: container.name, ...mount });
        }
      }
    }
  }
  return mounts;
}
test('packages private persistent keys for onboarding and Memory', rendersOnboardingAndMemoryStorage);

function protectsProviderRemounts() {
  const values = chartValues();
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const pod = resources.get('Deployment/server').spec.template.spec;
  assert.equal(pod.securityContext.fsGroupChangePolicy, 'OnRootMismatch');
  function preparesKeys(container) { return container.name === 'private-provider-keys'; }
  const prepare = pod.initContainers.find(preparesKeys);
  assert.ok(prepare, 'Check private custody before server and models start');
  assert.deepEqual(prepare.command, ['node', 'infra/package/provider-secrets.mjs',
    '/var/lib/opencrane/provider-secrets']);
  assert.deepEqual(prepare.volumeMounts, [{ name: 'provider-secrets',
    mountPath: '/var/lib/opencrane/provider-secrets' }]);
}
test('provider storage avoids recursive remount changes and checks modes before startup',
  protectsProviderRemounts);

function replacesProviderLeaderBeforeStartingItsSuccessor() {
  const values = chartValues();
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const server = resources.get('Deployment/server');
  assert.equal(server.spec.replicas, 1);
  assert.deepEqual(server.spec.strategy, { type: 'Recreate' },
    'The replacement cannot become ready until the old Pod releases the budget lock');
}
test('provider updates stop the budget leader before starting the replacement',
  replacesProviderLeaderBeforeStartingItsSuccessor);

function assertPrivateProviderMounts(resources) {
  const mounts = keyMounts(resources, 'provider-secrets');
  assert.deepEqual(mounts, [
    { workload: 'Deployment/server', container: 'private-provider-keys',
      name: 'provider-secrets',
      mountPath: '/var/lib/opencrane/provider-secrets' },
    { workload: 'Deployment/server', container: 'server', name: 'provider-secrets',
      mountPath: '/var/lib/opencrane/provider-secrets' },
    { workload: 'Deployment/server', container: 'models', name: 'provider-secrets',
      mountPath: '/var/lib/opencrane/provider-secrets', readOnly: true },
  ]);
}

function rendersPrivateProviderStorage() {
  const values = chartValues();
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const server = resources.get('Deployment/server').spec.template.spec;
  assertPrivateProviderMounts(resources);
  const volumes = new Map();
  for (const volume of server.volumes) volumes.set(volume.name, volume);
  assert.deepEqual(volumes.get('provider-secrets'), {
    name: 'provider-secrets', persistentVolumeClaim: { claimName: 'provider-secrets' },
  });
  assert.deepEqual(resources.get('PersistentVolumeClaim/provider-secrets').spec, {
    accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } },
  });
  for (const container of server.containers) {
    const environment = {};
    for (const setting of container.env ?? []) environment[setting.name] = setting.value;
    if (container.name === 'server' || container.name === 'models') {
      assert.equal(environment.PROVIDER_SECRETS_DIR, '/var/lib/opencrane/provider-secrets/keys');
    } else {
      assert.equal(environment.PROVIDER_SECRETS_DIR, undefined);
    }
    if (container.name === 'models') {
      assert.equal(environment.PACKAGE_PROVIDER_MODE, '1');
      assert.equal(environment.DEV_REAL_PROVIDER, undefined);
    }
    for (const name of Object.keys(environment)) {
      assert.doesNotMatch(name, /^MODEL_(UPSTREAM|KEY_FILE|STUB_)/u);
    }
  }
}
test('provider mode shares persistent key storage only with server and read-only models',
  rendersPrivateProviderStorage);

for (const mode of ['unknown', '', 42, true]) {
  function refusesModelMode() {
    const values = chartValues();
    values.models = { mode };
    const result = renderChart(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported models mode/u);
    assert.equal(result.stdout, '');
  }
  test(`Helm refuses models mode ${mode}`, refusesModelMode);
}

function providerIncludesSelectionProjection() {
  const values = chartValues();
  const ordinary = renderedResources(values);
  assert.equal(ordinary.has('Deployment/worker-routines'), false);
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const routines = resources.get('Deployment/worker-routines');
  assert.ok(routines, 'Provider selection needs the routines checkpoint');
  assert.deepEqual(routines.spec.template.spec.containers[0].command,
    ['node', 'infra/package/worker.mjs', 'routines']);
  const backupRole = resources.get('Role/package-backup');
  for (const rule of backupRole.rules) {
    if (rule.resources.includes('deployments') || rule.resources.includes('deployments/scale')) {
      assert.ok(rule.resourceNames.includes('worker-routines'));
    }
  }
  const backup = resources.get('CronJob/pilot-backup').spec.jobTemplate.spec.template.spec;
  assert.ok(backup.containers[0].env.some(providerBackupMode));
}
test('provider mode runs the projection required by default-model selection',
  providerIncludesSelectionProjection);

function providerBackupMode(setting) {
  return setting.name === 'BACKUP_PROVIDER_MODE' && setting.value === 'true';
}

function detectsBackupKeyMount() {
  const values = chartValues();
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const backup = resources.get('CronJob/pilot-backup').spec.jobTemplate.spec.template.spec;
  backup.volumes.push({ name: 'innocent-alias',
    persistentVolumeClaim: { claimName: 'provider-secrets' } });
  backup.initContainers[0].volumeMounts.push({ name: 'innocent-alias', mountPath: '/leaked-keys' });
  const inspectMounts = assertPrivateProviderMounts.bind(undefined, resources);
  assert.throws(inspectMounts,
    { code: 'ERR_ASSERTION' }, 'A backup init container must never read provider keys');
}
test('provider isolation detects a key PVC mounted by an aliased backup init container',
  detectsBackupKeyMount);

function rendersSeparateQualificationProvider() {
  const values = chartValues();
  values.models = { mode: 'provider', qualification: true };
  const resources = renderedResources(values);
  const stub = resources.get('Deployment/model-qualification');
  assert.ok(stub, 'Run the free stand-in separately from provider custody');
  const pod = resources.get('Deployment/server').spec.template.spec;
  function modelsContainer(container) { return container.name === 'models'; }
  const models = pod.containers.find(modelsContainer);
  const settings = {};
  for (const item of models.env) settings[item.name] = item.value;
  assert.equal(settings.DEV_REAL_PROVIDER, undefined);
  assert.equal(settings.PACKAGE_PROVIDER_MODE, '1');
  assert.equal(settings.PACKAGE_PROVIDER_QUALIFICATION, '1');
  assertPrivateProviderMounts(resources);
}
test('packaged provider qualification uses a separate free stand-in with private custody',
  rendersSeparateQualificationProvider);

function takeProviderMount(container) {
  const retained = [];
  const transferred = [];
  for (const mount of container.volumeMounts) {
    if (mount.name === 'provider-secrets') {
      transferred.push(mount);
    } else {
      retained.push(mount);
    }
  }
  container.volumeMounts = retained;
  return { name: container.name, volumeMounts: transferred };
}

function detectsRelocatedProviderContainers() {
  const values = chartValues();
  values.models = { mode: 'provider' };
  const resources = renderedResources(values);
  const server = resources.get('Deployment/server').spec.template.spec;
  const backup = resources.get('CronJob/pilot-backup').spec.jobTemplate.spec.template.spec;
  backup.volumes.push({ name: 'provider-secrets',
    persistentVolumeClaim: { claimName: 'provider-secrets' } });
  for (const container of server.containers) {
    if (container.name === 'server' || container.name === 'models') {
      const moved = takeProviderMount(container);
      backup.initContainers.push(moved);
    }
  }
  const inspectMounts = assertPrivateProviderMounts.bind(undefined, resources);
  assert.throws(inspectMounts,
    { code: 'ERR_ASSERTION' }, 'Matching container names in another workload must not grant custody');
}
test('provider isolation refuses the same container names and mounts moved into the backup',
  detectsRelocatedProviderContainers);

function ordinaryWorkerCannotReachOtherPods() {
  const resources = renderedResources(chartValues());
  const worker = resources.get('Deployment/worker-files').spec.template.spec;
  const identity = worker.serviceAccountName ?? 'default';
  const grantedRules = [];
  for (const binding of resources.values()) {
    if (binding.kind !== 'RoleBinding') {
      continue;
    }
    function workerSubject(subject) {
      return subject.kind === 'ServiceAccount' && subject.name === identity;
    }
    if (!binding.subjects.some(workerSubject)) {
      continue;
    }
    const role = resources.get(binding.roleRef.kind + '/' + binding.roleRef.name);
    grantedRules.push(...role.rules);
  }
  const checks = [['create', 'pods'], ['create', 'pods/exec'], ['get', 'pods/exec']];
  const allowed = [];
  for (const [verb, resource] of checks) {
    function matches(rule) {
      return rule.apiGroups.includes('') &&
        (rule.resources.includes(resource) || rule.resources.includes('*')) &&
        (rule.verbs.includes(verb) || rule.verbs.includes('*'));
    }
    if (grantedRules.some(matches)) {
      allowed.push([verb, resource]);
    }
  }
  assert.deepEqual(allowed, []);
  assert.equal(worker.automountServiceAccountToken, false);
  assert.equal(resources.get('ServiceAccount/' + identity).automountServiceAccountToken, false);
  assert.notEqual(identity,
    resources.get('Deployment/worker-dispatcher').spec.template.spec.serviceAccountName);
  assert.notEqual(identity,
    resources.get('Deployment/server').spec.template.spec.serviceAccountName);
}
test('an unrelated projection worker cannot create pods or run commands in another pod',
  ordinaryWorkerCannotReachOtherPods);

function dispatcherUsesSeparateComputerExecRole() {
  const values = chartValues();
  const resources = renderedResources(values);
  const dispatcher = resources.get('Deployment/worker-dispatcher');
  const identity = dispatcher.spec.template.spec.serviceAccountName;
  const lifecycle = resources.get('Role/' + identity);
  function grantsExec(rule) {
    return rule.resources.includes('pods/exec');
  }
  const lifecycleGrantsExec = lifecycle.rules.some(grantsExec);
  assert.equal(lifecycleGrantsExec, false, 'The dispatcher lifecycle role must not grant exec');
  const execRole = resources.get('Role/package-computer-exec');
  const execRoleRules = [{
    apiGroups: [''], resources: ['pods/exec'], verbs: ['create', 'get'],
  }];
  assert.deepEqual(execRole.rules, execRoleRules);
  const execBinding = resources.get('RoleBinding/package-computer-exec');
  const execSubjects = [{ kind: 'ServiceAccount', name: identity }];
  assert.deepEqual(execBinding.subjects, execSubjects);
  assert.equal(execBinding.roleRef.name, execRole.metadata.name);
  checksComputerExecPolicy(resources, identity);
}

function checksComputerExecPolicy(resources, identity) {
  const namespace = 'cluster-test';
  const execPolicy = resources.get(`ValidatingAdmissionPolicy/${namespace}-computer-exec`);
  const podPolicy = resources.get(`ValidatingAdmissionPolicy/${namespace}-computer-pod-name`);
  const execOperations = [{
    apiGroups: [''], apiVersions: ['v1'], operations: ['CONNECT'], resources: ['pods/exec'],
  }];
  assert.deepEqual(execPolicy.spec.matchConstraints.resourceRules, execOperations);
  const dispatcherAccount = `system:serviceaccount:${namespace}:${identity}`;
  const dispatcherCondition = `request.userInfo.username == '${dispatcherAccount}'`;
  assert.equal(execPolicy.spec.matchConditions[0].expression, dispatcherCondition);
  assert.match(execPolicy.spec.validations[0].expression, /request\.name\.matches/u);
  assert.match(execPolicy.spec.validations[0].expression, /object\.container == 'computer'/u);
  const podOperations = [{ apiGroups: [''],
    apiVersions: ['v1'], operations: ['CREATE', 'UPDATE'],
    resources: ['pods', 'pods/ephemeralcontainers'] }];
  assert.deepEqual(podPolicy.spec.matchConstraints.resourceRules, podOperations);
  const controllerOnlyCreation = "request.operation != 'CREATE' || request.userInfo.username == "
    + "'system:serviceaccount:agent-sandbox-system:agent-sandbox-controller'";
  function checksCreator(validation) {
    return validation.expression === controllerOnlyCreation;
  }
  const hasCreatorCheck = podPolicy.spec.validations.some(checksCreator);
  assert.ok(hasCreatorCheck,
    'Only the computer controller may create a pod with a reserved computer name');
  const validationActions = ['Deny'];
  const namespaceLabels = { 'kubernetes.io/metadata.name': namespace };
  for (const policy of [execPolicy, podPolicy]) {
    const binding = resources.get(`ValidatingAdmissionPolicyBinding/${policy.metadata.name}`);
    assert.equal(policy.spec.failurePolicy, 'Fail');
    assert.equal(binding.spec.policyName, policy.metadata.name);
    assert.deepEqual(binding.spec.validationActions, validationActions);
    assert.deepEqual(binding.spec.matchResources.namespaceSelector.matchLabels, namespaceLabels);
  }
}
test('the dispatcher exec role is separate and admission restricts it to computer pods',
  dispatcherUsesSeparateComputerExecRole);

function comparesOtherPartsOfTheKeyDeployments() {
  const original = renderChart(chartValues()).stdout;
  const comparison = unchangedResources(original);
  const changes = [
    ['apps/server/src/main.ts', 'apps/server/src/another-entry.ts'],
    ['key: HANDLER_DATABASE_URL', 'key: DIFFERENT_DATABASE_URL'],
    ['key: PROJECTION_DATABASE_URL', 'key: DIFFERENT_DATABASE_URL'],
  ];
  for (const [existing, changed] of changes) {
    const edited = original.replace(existing, changed);
    assert.notEqual(edited, original);
    const editedResources = unchangedResources(edited);
    assert.equal(isDeepStrictEqual(editedResources, comparison), false);
  }
}
test('the chart comparison sees an unrelated server change beside the key mounts',
  comparesOtherPartsOfTheKeyDeployments);
