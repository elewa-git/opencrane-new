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
