import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
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

function renderPostgres(values) {
  const argumentsList = ['template', 'postgres-test', 'infra/package/chart', '--values', '-'];
  return spawnSync('helm', argumentsList, { encoding: 'utf8', input: JSON.stringify(values) });
}

function renderedResources(values) {
  const result = renderPostgres(values);
  assert.equal(result.status, 0, result.stderr);
  const resources = [];
  for (const document of parseAllDocuments(result.stdout)) {
    assert.deepEqual(document.errors, []);
    resources.push(document.toJS());
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
  const databases = resources.filter(postgresStatefulSet);
  assert.equal(databases.length, 1);
  assert.equal(databases[0].spec.replicas, 1);
  assert.equal(resources.filter(cnpgCluster).length, 0);
}
test('the default still runs one PostgreSQL StatefulSet', defaultPostgresRemains);

function twoInstanceCluster() {
  const values = cnpgValues();
  const resources = renderedResources(values);
  assert.equal(resources.filter(postgresStatefulSet).length, 0);
  const clusters = resources.filter(cnpgCluster);
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
  const writer = resources.find(postgresService);
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
  for (const resource of resources) {
    if (resource.kind === 'Service') {
      assert.equal(resource.spec.type, 'ClusterIP');
    }
    assert.notEqual(resource.kind, 'Secret');
  }
}

function postgresService(resource) {
  return resource.kind === 'Service' && resource.metadata.name === 'postgres';
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
    const result = renderPostgres(values);
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
    const result = renderPostgres(values);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  test(`Helm refuses CNPG ${exposure}`, refusesUnsafeCluster);
}
