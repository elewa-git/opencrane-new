import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sharedCertificates, certificates, issueCertificate }
  from '../../libs/event-store/test/certificates.ts';
import { parseAllDocuments } from 'yaml';

function chartValues() {
  const digest = 'a'.repeat(64);
  const images = {};
  const secrets = {};
  for (const name of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer']) {
    images[name] = `example.invalid/${name}@sha256:${digest}`;
  }
  for (const name of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap']) {
    secrets[name] = `chart-test-${name.toLowerCase()}`;
  }
  const exposure = { ingress: false, loadBalancer: false, funnel: false };
  return { chartVersion: '0.1.0', images, secrets, exposure };
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

function renderChart(values) {
  const options = { encoding: 'utf8', input: JSON.stringify(values) };
  const args = ['template', 'chart-test', 'infra/package/chart',
    '--namespace', 'cluster-test', '--values', '-'];
  const result = spawnSync('helm', args, options);
  assert.equal(result.error, undefined);
  return result;
}

function renderedResources(values) {
  const result = renderChart(values);
  assert.equal(result.status, 0, result.stderr);
  const resources = new Map();
  for (const document of parseAllDocuments(result.stdout)) {
    assert.deepEqual(document.errors, []);
    const resource = document.toJS();
    resources.set(`${resource.kind}/${resource.metadata.name}`, resource);
  }
  return resources;
}
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
  backupID: [undefined, '', 42, 'latest', '20261326T120000', '20261026T250000', '../backup'],
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
